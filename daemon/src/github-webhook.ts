import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

import type { GithubAppConfig, ReviewerConfig } from '../../agents/common/src/config.js';
import { getInstallationOctokit, type GithubAuth } from '../../agents/common/src/github-auth.js';
import { reviewOnePr } from './jobs.js';
import { runQueuedForRepo } from './repo-queue.js';
import { readReviewer } from './reviewers.js';
import {
  checkResultForError,
  checkResultForOutcome,
  completeReviewCheck,
  createReviewCheck,
  type ReviewCheckTarget,
} from './review-check.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

const PullRequestWebhookSchema = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({
    full_name: z.string().min(3),
    html_url: z.string().url(),
    owner: z.object({ login: z.string().min(1) }),
  }),
  pull_request: z.object({
    draft: z.boolean().nullable(),
    html_url: z.string().url(),
    head: z.object({ sha: z.string().min(1) }),
  }),
});

export type PullRequestWebhook = z.infer<typeof PullRequestWebhookSchema>;

export function shouldReviewPullRequest(event: PullRequestWebhook): boolean {
  return REVIEW_ACTIONS.has(event.action) && event.pull_request.draft !== true;
}

export function verifyWebhookSignature(body: Buffer | string, secret: string, signature: string | undefined): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const expectedBytes = Buffer.from(expected, 'ascii');
  const actualBytes = Buffer.from(signature, 'ascii');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function githubApp(config: ReviewerConfig): GithubAppConfig {
  if (!config.github.app) throw new Error('github.app is not configured');
  return config.github.app;
}

function webhookSecret(app: GithubAppConfig): string {
  const secret = (process.env[app.webhookSecretEnv] ?? '').trim();
  if (!secret) throw new Error(`GitHub webhook secret is missing: set $${app.webhookSecretEnv}`);
  return secret;
}

function ownerAllowed(app: GithubAppConfig, owner: string): boolean {
  if (app.allowedOwners.length === 0) return true;
  const normalized = owner.toLowerCase();
  return app.allowedOwners.some((candidate) => candidate.toLowerCase() === normalized);
}

export async function runForRegisteredRepo<T>(
  config: ReviewerConfig,
  repo: string,
  run: () => Promise<T>,
): Promise<T | null> {
  return readReviewer(config, repo) ? run() : null;
}

/**
 * Process one accepted pull_request event. The per-repo queue prevents a
 * synchronize event from racing another review or learn job; the store claim
 * deduplicates GitHub redeliveries by repo, PR number, and exact head SHA.
 */
export async function processPullRequestWebhook(config: ReviewerConfig, event: PullRequestWebhook): Promise<void> {
  const app = githubApp(config);
  if (!shouldReviewPullRequest(event)) return;
  if (!readReviewer(config, event.repository.full_name)) {
    console.warn(`[webhook] ignored ${event.repository.full_name}#${event.number}: repository is not registered`);
    return;
  }
  if (!ownerAllowed(app, event.repository.owner.login)) {
    console.warn(`[webhook] ignored ${event.repository.full_name}#${event.number}: owner is not allowed`);
    return;
  }

  let auth: GithubAuth | undefined;
  let checkRunId: number | undefined;
  const target: ReviewCheckTarget = {
    repo: event.repository.full_name,
    prNumber: event.number,
    headSha: event.pull_request.head.sha,
    detailsUrl: event.pull_request.html_url,
  };
  try {
    const outcome = await runQueuedForRepo(
      config,
      event.repository.full_name,
      () => runForRegisteredRepo(config, event.repository.full_name, async () => {
        auth = await getInstallationOctokit(app, event.installation.id);
        return reviewOnePr(config, event.repository.full_name, event.number, {
          githubAuth: auth,
          expectedHeadSha: event.pull_request.head.sha,
          onClaimed: async () => {
            checkRunId = await createReviewCheck(auth!, app, target);
          },
        });
      }),
    );

    // No check means the repo was removed while queued, or the delivery was stale,
    // draft, or already claimed.
    if (outcome === null || !auth || checkRunId === undefined) return;
    await completeReviewCheck(auth, app, target, checkRunId, checkResultForOutcome(outcome));
    console.log(`[webhook] reviewed ${event.repository.full_name}#${event.number}@${event.pull_request.head.sha}`);
  } catch (err) {
    console.error(`[webhook] ${event.repository.full_name}#${event.number} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (auth && checkRunId !== undefined) {
      try {
        await completeReviewCheck(auth, app, target, checkRunId, checkResultForError(err));
      } catch (updateErr) {
        console.error(`[webhook] could not complete check ${checkRunId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
      }
    }
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new Error('webhook payload exceeds 2 MiB');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${body}\n`);
}

export interface WebhookServerDependencies {
  readonly secret?: string;
  readonly processPullRequest?: (config: ReviewerConfig, event: PullRequestWebhook) => Promise<void>;
  readonly onError?: (err: unknown) => void;
}

/** Build the HTTP server without listening, so tests can bind it to an ephemeral port. */
export function createWebhookServer(config: ReviewerConfig, deps: WebhookServerDependencies = {}): Server {
  const app = githubApp(config);
  const secret = deps.secret ?? webhookSecret(app);
  const processEvent = deps.processPullRequest ?? processPullRequestWebhook;
  const onError = deps.onError ?? ((err: unknown) => {
    console.error(`[webhook] background failure: ${err instanceof Error ? err.message : String(err)}`);
  });

  return createServer(async (req, res) => {
    const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && requestPath === '/healthz') {
      respond(res, 200, 'ok');
      return;
    }
    if (req.method !== 'POST' || requestPath !== app.path) {
      respond(res, 404, 'not found');
      return;
    }

    try {
      const body = await readBody(req);
      if (!verifyWebhookSignature(body, secret, header(req, 'x-hub-signature-256'))) {
        respond(res, 401, 'invalid signature');
        return;
      }

      const eventName = header(req, 'x-github-event');
      if (eventName !== 'pull_request') {
        respond(res, 202, 'ignored');
        return;
      }

      const json = JSON.parse(body.toString('utf8')) as unknown;
      const parsed = PullRequestWebhookSchema.safeParse(json);
      if (!parsed.success) {
        respond(res, 400, 'invalid pull_request payload');
        return;
      }
      if (!shouldReviewPullRequest(parsed.data)) {
        respond(res, 202, 'ignored');
        return;
      }
      if (!readReviewer(config, parsed.data.repository.full_name)) {
        respond(res, 202, 'ignored');
        return;
      }

      respond(res, 202, 'accepted');
      setImmediate(() => {
        void processEvent(config, parsed.data).catch(onError);
      });
    } catch (err) {
      const status = err instanceof Error && err.message.includes('exceeds 2 MiB') ? 413 : 400;
      respond(res, status, status === 413 ? 'payload too large' : 'invalid request');
    }
  });
}

export async function startWebhookServer(config: ReviewerConfig, deps: WebhookServerDependencies = {}): Promise<Server> {
  const app = githubApp(config);
  const server = createWebhookServer(config, deps);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(app.port, app.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
