import { spawn } from 'node:child_process';
import type { Octokit } from '@octokit/rest';
import type { GithubAppConfig, ReviewerConfig } from '../../agents/common/src/config.js';
import { getAppOctokit, getRepositoryInstallationOctokit, type GithubAuth } from '../../agents/common/src/github-auth.js';
import { repoIgnored } from '../../agents/common/src/review-routing.js';
import { listReviewers } from './reviewers.js';

type Delivery = Awaited<ReturnType<Octokit['apps']['listWebhookDeliveries']>>['data'][number];
const succeeded = (delivery: Delivery): boolean => delivery.status_code >= 200 && delivery.status_code < 300;
const failed = (delivery: Delivery): boolean => !/^pending$/i.test(delivery.status)
  && (delivery.status_code === 0 || delivery.status_code >= 300);
const order = (a: Delivery, b: Delivery): number => Date.parse(b.delivered_at) - Date.parse(a.delivered_at) || b.id - a.id;
const attemptKey = (delivery: Delivery): string => `${delivery.id}:${delivery.delivered_at}`;
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

export interface WebhookHealthDependencies {
  readonly appClient?: (app: GithubAppConfig) => Octokit;
  readonly authForRepo?: (app: GithubAppConfig, repo: string) => Promise<GithubAuth>;
  readonly repos?: () => readonly string[];
  readonly repair?: (argv: readonly string[]) => Promise<void>;
  readonly log?: (message: string) => void;
}

/** Output, argv, environment and exception text must never reach the logs. */
export function runWebhookRepair(argv: readonly string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1)], { shell: false, stdio: 'ignore', detached: process.platform !== 'win32' });
    // A hard deadline also covers children that ignore SIGTERM.
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* the process group already exited */ }
    }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('webhook repair could not start')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('webhook repair failed or timed out'));
    });
  });
}

/**
 * One serialized monitor per daemon. Health comes from GitHub's delivery
 * results, not from local unit liveness or a successful repair exit code.
 */
export function createWebhookHealthCheck(config: ReviewerConfig, deps: WebhookHealthDependencies = {}): () => Promise<void> {
  const app = config.github.app;
  const log = deps.log ?? ((message: string) => console.error(`[webhook-health] ${message}`));
  const attempted = new Set<string>();
  let busy = false;
  let client: Octokit | undefined;
  let lastRepairDelivery: number | undefined;
  let lastScannedDelivery: string | undefined;
  let recoveryAfter: number | undefined;

  return async () => {
    if (!app || busy) return;
    busy = true;
    try {
      client ??= (deps.appClient ?? getAppOctokit)(app);
      const { data } = await client.apps.listWebhookDeliveries({ per_page: 100 });
      const recent = [...data].sort(order);
      const newest = recent[0];
      if (!newest) return;
      const threshold = app.webhookFailureThreshold ?? 3;
      if (recent.length >= threshold && recent.slice(0, threshold).every(failed)) {
        recoveryAfter = Date.parse(newest.delivered_at);
        log(`ALERT: newest ${threshold} App webhook deliveries failed; latest delivery=${newest.id}`);
        if (app.webhookRepairCommand && lastRepairDelivery !== newest.id) {
          const command = app.webhookRepairCommand;
          const commands: readonly (readonly string[])[] = typeof command[0] === 'string'
            ? [command as readonly string[]] : command as readonly (readonly string[])[];
          for (const argv of commands) await (deps.repair ?? runWebhookRepair)(argv);
          lastRepairDelivery = newest.id;
          log('repair completed; waiting for a successful GitHub delivery before catch-up');
        }
        return;
      }
      // A success after the detected outage demonstrates recovery. Keep this
      // evidence when one asynchronous replay later fails, so it can retry
      // without depending on an unrelated new successful event.
      const success = recent.find(succeeded);
      const scanKey = `${attemptKey(newest)}:${newest.status_code}`;
      if (!success || (recoveryAfter !== undefined && Date.parse(success.delivered_at) <= recoveryAfter)
        || lastScannedDelivery === scanKey) return;
      const deliveries = (await client.paginate(client.apps.listWebhookDeliveries, { per_page: 100 })).sort(order);
      const retainedAttempts = new Set(deliveries.map(attemptKey));
      for (const key of attempted) if (!retainedAttempts.has(key)) attempted.delete(key);
      const successfulGuids = new Set(deliveries.filter(succeeded).map((delivery) => delivery.guid));
      const candidates = deliveries.filter((delivery) => failed(delivery)
        && delivery.event === 'pull_request' && REVIEW_ACTIONS.has(delivery.action ?? ''));
      const repos = deps.repos?.() ?? listReviewers(config).map((reviewer) => reviewer.repo);
      const heads = new Map<string, string>();
      let incomplete = false;
      for (const slug of repos) {
        const [owner, repo, extra] = slug.split('/');
        if (!owner || !repo || extra || repoIgnored(app.ignoredRepos, slug)) continue;
        if (app.allowedOwners.length && !app.allowedOwners.some((allowed) => allowed.toLowerCase() === owner.toLowerCase())) continue;
        try {
          const auth = await (deps.authForRepo ?? getRepositoryInstallationOctokit)(app, slug);
          const pulls = await auth.octokit.paginate(auth.octokit.pulls.list, { owner, repo, state: 'open', per_page: 100 });
          for (const pull of pulls) heads.set(`${slug.toLowerCase()}#${pull.number}`, pull.head.sha);
        } catch {
          incomplete = true;
          log('could not read open PRs for a registered repository; will retry on the next poll');
        }
      }
      const picked = new Set<string>();
      for (const delivery of candidates) {
        const { data: detail } = await client.apps.getWebhookDelivery({ delivery_id: delivery.id });
        // Headers, signatures and the rest of the payload are never logged.
        const payload = detail.request.payload as {
          repository?: { full_name?: string };
          number?: number;
          pull_request?: { head?: { sha?: string } };
        } | null;
        if (!payload?.repository?.full_name || !payload.number) continue;
        const key = `${payload.repository.full_name.toLowerCase()}#${payload.number}`;
        if (picked.has(key) || heads.get(key) !== payload.pull_request?.head?.sha || !heads.has(key)) continue;
        picked.add(key);
        if (successfulGuids.has(delivery.guid) || attempted.has(attemptKey(delivery))) continue;
        await client.apps.redeliverWebhookDelivery({ delivery_id: delivery.id });
        attempted.add(attemptKey(delivery));
        log(`requested catch-up delivery=${delivery.id}`);
      }
      if (!incomplete) lastScannedDelivery = scanKey;
    } catch {
      // API error objects may embed credentials, request headers or payloads.
      log('health check, repair or catch-up failed; will retry on the next poll');
    } finally {
      busy = false;
    }
  };
}

/** Start immediately, then poll without overlapping a previous tick. */
export function startWebhookHealthMonitor(config: ReviewerConfig): NodeJS.Timeout | undefined {
  if (!config.github.app) return undefined;
  const check = createWebhookHealthCheck(config);
  void check();
  return setInterval(() => void check(), (config.github.app.webhookHealthIntervalMinutes ?? 3) * 60_000);
}
