import { spawn } from 'node:child_process';
import type { Octokit } from '@octokit/rest';
import type { GithubAppConfig, ReviewerConfig } from '../../agents/common/src/config.js';
import { getAppOctokit, getRepositoryInstallationOctokit, RepositoryNotInstalledError, type GithubAuth } from '../../agents/common/src/github-auth.js';
import { repoIgnored } from '../../agents/common/src/review-routing.js';
import { listReviewers } from './reviewers.js';

type ApiDelivery = Awaited<ReturnType<Octokit['apps']['listWebhookDeliveries']>>['data'][number];
type Delivery = Omit<ApiDelivery, 'id'> & { readonly id: string };
interface PullRequestDelivery {
  readonly repo: string;
  readonly number: number;
  readonly head: string;
  readonly draft: boolean;
}
const succeeded = (delivery: Delivery): boolean => delivery.status_code >= 200 && delivery.status_code < 300;
const failed = (delivery: Delivery): boolean => !/^pending$/i.test(delivery.status)
  && (delivery.status_code === 0 || delivery.status_code >= 300);
const repairable = (delivery: Delivery): boolean => failed(delivery)
  && (delivery.status_code === 0 || (delivery.status_code >= 500 && delivery.status_code < 600));
const order = (a: Delivery, b: Delivery): number => Date.parse(b.delivered_at) - Date.parse(a.delivered_at)
  || (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0);
const attemptKey = (delivery: Delivery): string => `${delivery.id}:${delivery.delivered_at}`;
const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
// GitHub allows redelivery for three days. Keep routing caches for that window:
// https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
const DELIVERY_RETENTION_MS = 3 * 24 * 60 * 60_000;

async function deliveryPage(client: Octokit, cursor?: string): Promise<{ deliveries: Delivery[]; next?: string }> {
  const response = await client.apps.listWebhookDeliveries({ per_page: 100, ...(cursor ? { cursor } : {}) });
  const deliveries = response.data as unknown as Delivery[];
  for (const delivery of deliveries) {
    if (typeof delivery.id !== 'string' || !/^\d+$/.test(delivery.id) || !Number.isFinite(Date.parse(delivery.delivered_at))) {
      throw new Error('invalid webhook delivery identity or timestamp');
    }
  }
  const link = response.headers?.link?.split(',').find((part) => /;\s*rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1];
  return { deliveries, ...(link ? { next: new URL(link).searchParams.get('cursor') ?? undefined } : {}) };
}

export interface WebhookHealthDependencies {
  readonly appClient?: (app: GithubAppConfig) => Octokit;
  readonly authForRepo?: (app: GithubAppConfig, repo: string) => Promise<GithubAuth>;
  readonly repos?: () => readonly string[];
  readonly repair?: (argv: readonly string[], envAllowlist: readonly string[]) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /** Counts only, for checking retention without exposing cached delivery data. */
  readonly onCacheStats?: (stats: { readonly attempts: number; readonly failures: number }) => void;
}

/** Output, argv, environment and exception text must never reach the logs. */
export function runWebhookRepair(argv: readonly string[], timeoutMs = 30_000, envAllowlist: readonly string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'HOME', ...envAllowlist]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const child = spawn(argv[0], [...argv.slice(1)], { env, shell: false, stdio: 'ignore', detached: process.platform !== 'win32' });
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
  const attempted = new Map<string, number>();
  const handled = new Map<string, number>();
  const handledHeads = new Map<string, string>();
  const awaiting = new Set<string>();
  const successfulGuids = new Set<string>();
  const reportedFailures = new Map<string, number>();
  const known = new Map<string, Delivery>();
  const payloads = new Map<string, PullRequestDelivery | null>();
  const guidPayloads = new Map<string, PullRequestDelivery | null>();
  const reportedNotInstalled = new Set<string>();
  const cacheRecords = new Map<string, { guid: string; time: number }>();
  const retrying = new Set<string>();
  let busy = false;
  let client: Octokit | undefined;
  let lastRepairDelivery: string | undefined;
  let lastScannedDelivery: string | undefined;
  let lastScan: Delivery | undefined;
  let recoveryAfter: Delivery | undefined;
  let recoveryEvidence: Delivery | undefined;
  const markHandled = (delivery: Delivery) => handled.set(attemptKey(delivery), Date.parse(delivery.delivered_at));

  const expire = () => {
    const cutoff = (deps.now ?? Date.now)() - DELIVERY_RETENTION_MS;
    for (const [id, record] of cacheRecords) {
      if (record.time >= cutoff) continue;
      cacheRecords.delete(id);
      known.delete(id);
      payloads.delete(id);
      retrying.delete(id);
    }
    const guids = new Set([...cacheRecords.values()].map((record) => record.guid));
    for (const guid of guidPayloads.keys()) if (!guids.has(guid)) guidPayloads.delete(guid);
    for (const set of [awaiting, successfulGuids]) for (const guid of set) if (!guids.has(guid)) set.delete(guid);
    for (const set of [attempted, handled, reportedFailures]) {
      for (const [key, time] of set) {
        if (time < cutoff || !cacheRecords.has(key.split(':', 1)[0])) set.delete(key);
      }
    }
    for (const [head, guid] of handledHeads) if (!guids.has(guid)) handledHeads.delete(head);
    if (recoveryEvidence && Date.parse(recoveryEvidence.delivered_at) < cutoff) recoveryEvidence = undefined;
  };

  const remember = (deliveries: Delivery[]) => {
    for (const delivery of deliveries) {
      const time = Date.parse(delivery.delivered_at);
      if (time < (deps.now ?? Date.now)() - DELIVERY_RETENTION_MS) continue;
      cacheRecords.set(delivery.id, { guid: delivery.guid, time: Math.max(time, cacheRecords.get(delivery.id)?.time ?? time) });
      const old = known.get(delivery.id);
      if (!old || order(delivery, old) <= 0) known.set(delivery.id, delivery);
      if (succeeded(delivery)) {
        if (!recoveryEvidence || order(delivery, recoveryEvidence) < 0) recoveryEvidence = delivery;
        successfulGuids.add(delivery.guid);
        awaiting.delete(delivery.guid);
        for (const id of retrying) {
          if (cacheRecords.get(id)?.guid === delivery.guid) retrying.delete(id);
        }
        const payload = guidPayloads.get(delivery.guid);
        if (payload) handledHeads.set(`${payload.repo}#${payload.number}@${payload.head}`, delivery.guid);
      }
      const failureKey = `${attemptKey(delivery)}:${delivery.status_code}:${delivery.status}`;
      if (failed(delivery) && !reportedFailures.has(failureKey)) {
        reportedFailures.set(failureKey, time);
        log(`ALERT: App webhook delivery=${delivery.id} failed (status=${delivery.status_code})`);
      }
    }
  };

  const finishScan = (newest: Delivery, scanKey: string, complete: boolean) => {
    lastScannedDelivery = complete ? scanKey : undefined;
    lastScan = newest;
    // Do not advance past an outstanding replay or pending review delivery:
    // its outcome can change below an otherwise unchanged newest record.
    for (const delivery of known.values()) {
      const pendingReview = /^pending$/i.test(delivery.status) && delivery.event === 'pull_request'
        && REVIEW_ACTIONS.has(delivery.action ?? '') && !successfulGuids.has(delivery.guid);
      if ((awaiting.has(delivery.guid) || pendingReview || retrying.has(delivery.id)) && order(delivery, lastScan) > 0) lastScan = delivery;
    }
    for (const [id, delivery] of known) {
      if (order(delivery, lastScan) > 0 && !awaiting.has(delivery.guid) && !retrying.has(id)) known.delete(id);
    }
  };

  const describe = async (delivery: Delivery): Promise<PullRequestDelivery | null> => {
    if (payloads.has(delivery.id)) return payloads.get(delivery.id)!;
    if (guidPayloads.has(delivery.guid)) {
      const payload = guidPayloads.get(delivery.guid)!;
      payloads.set(delivery.id, payload);
      return payload;
    }
    const { data } = await client!.request(`GET /app/hook/deliveries/${delivery.id}`);
    const payload = data.request?.payload;
    const value: PullRequestDelivery | null = typeof payload?.repository?.full_name === 'string'
      && Number.isSafeInteger(payload.number) && payload.number > 0 && typeof payload.pull_request?.head?.sha === 'string'
      ? { repo: payload.repository.full_name.toLowerCase(), number: payload.number, head: payload.pull_request.head.sha, draft: payload.pull_request.draft === true }
      : null;
    // Keep only the routing fields. Never cache headers, signatures or secrets.
    payloads.set(delivery.id, value);
    guidPayloads.set(delivery.guid, value);
    return value;
  };

  return async () => {
    if (!app || busy) return;
    busy = true;
    try {
      expire();
      client ??= (deps.appClient ?? getAppOctokit)(app);
      let page = await deliveryPage(client);
      remember(page.deliveries);
      const recent = [...page.deliveries].sort(order);
      const newest = recent[0];
      if (!newest) return;
      const threshold = app.webhookFailureThreshold ?? 3;
      if (recent.length >= threshold && recent.slice(0, threshold).every(failed)) {
        recoveryAfter = newest;
        log(`ALERT: newest ${threshold} App webhook deliveries failed; latest delivery=${newest.id}`);
        if (recent.slice(0, threshold).every(repairable) && app.webhookRepairCommand && lastRepairDelivery !== newest.id) {
          const command = app.webhookRepairCommand;
          const commands: readonly (readonly string[])[] = typeof command[0] === 'string'
            ? [command as readonly string[]] : command as readonly (readonly string[])[];
          for (const argv of commands) {
            const allowlist = app.webhookRepairEnvAllowlist ?? [];
            if (deps.repair) await deps.repair(argv, allowlist);
            else await runWebhookRepair(argv, 30_000, allowlist);
          }
          lastRepairDelivery = newest.id;
          log('repair completed; waiting for a successful GitHub delivery before catch-up');
        }
        return;
      }
      // A success after the detected outage demonstrates recovery. Keep this
      // evidence when one asynchronous replay later fails, so it can retry
      // without depending on an unrelated new successful event.
      const cursors = new Set<string>();
      while (page.next && (!lastScan || !page.deliveries.some((delivery) => order(delivery, lastScan!) >= 0))) {
        if (cursors.has(page.next)) throw new Error('repeated webhook delivery cursor');
        cursors.add(page.next);
        page = await deliveryPage(client, page.next);
        remember(page.deliveries);
      }
      const deliveries = [...known.values()].sort(order);
      const success = recoveryEvidence;
      if (!success || (recoveryAfter !== undefined && order(success, recoveryAfter) >= 0)) return;
      const scanKey = deliveries.map((delivery) => `${attemptKey(delivery)}:${delivery.status_code}:${delivery.status}`).join('|');
      if (lastScannedDelivery === scanKey) return;
      const repos = new Set((deps.repos?.() ?? listReviewers(config).map((reviewer) => reviewer.repo)).map((repo) => repo.toLowerCase()));
      for (const repo of reportedNotInstalled) if (!repos.has(repo)) reportedNotInstalled.delete(repo);
      const byRepo = new Map<string, Array<{ delivery: Delivery; payload: PullRequestDelivery }>>();
      let incomplete = false;
      for (const delivery of deliveries) {
        if (!failed(delivery) || delivery.event !== 'pull_request' || !REVIEW_ACTIONS.has(delivery.action ?? '')
          || successfulGuids.has(delivery.guid) || handled.has(attemptKey(delivery)) || attempted.has(attemptKey(delivery))) continue;
        let payload: PullRequestDelivery | null;
        try {
          payload = await describe(delivery);
          retrying.delete(delivery.id);
        } catch (err) {
          if ((err as { status?: number })?.status === 404) {
            payloads.set(delivery.id, null);
            markHandled(delivery);
            retrying.delete(delivery.id);
            awaiting.delete(delivery.guid);
            log(`delivery=${delivery.id} is no longer available; skipping`);
          } else {
            incomplete = true;
            retrying.add(delivery.id);
            log(`could not read delivery=${delivery.id}; will retry on the next poll`);
          }
          continue;
        }
        if (!payload) { markHandled(delivery); continue; }
        const [owner, repo, extra] = payload.repo.split('/');
        const headKey = `${payload.repo}#${payload.number}@${payload.head}`;
        if (payload.draft || !owner || !repo || extra || !repos.has(payload.repo) || repoIgnored(app.ignoredRepos, payload.repo)
          || (app.allowedOwners.length && !app.allowedOwners.some((allowed) => allowed.toLowerCase() === owner))
          || (handledHeads.has(headKey) && !awaiting.has(delivery.guid))) {
          markHandled(delivery);
          awaiting.delete(delivery.guid);
          continue;
        }
        const candidates = byRepo.get(payload.repo) ?? [];
        candidates.push({ delivery, payload });
        byRepo.set(payload.repo, candidates);
      }
      for (const [slug, candidates] of byRepo) {
        const [owner, repo] = slug.split('/');
        let auth: GithubAuth;
        try {
          auth = await (deps.authForRepo ?? getRepositoryInstallationOctokit)(app, slug);
        } catch (err) {
          if (err instanceof RepositoryNotInstalledError) {
            for (const { delivery } of candidates) {
              markHandled(delivery);
              awaiting.delete(delivery.guid);
              retrying.delete(delivery.id);
            }
            if (!reportedNotInstalled.has(slug)) {
              reportedNotInstalled.add(slug);
              log('App is not installed for a candidate repository; skipping');
            }
          } else {
            incomplete = true;
            for (const { delivery } of candidates) retrying.add(delivery.id);
            log('could not read a candidate repository installation; will retry on the next poll');
          }
          continue;
        }
        try {
          const pulls = await auth.octokit.paginate(auth.octokit.pulls.list, { owner, repo, state: 'open', per_page: 100 });
          const heads = new Map(pulls.map((pull) => [pull.number, pull.head.sha]));
          const picked = new Set<number>();
          for (const { delivery, payload } of candidates) {
            if (heads.get(payload.number) !== payload.head) {
              markHandled(delivery);
              awaiting.delete(delivery.guid);
              retrying.delete(delivery.id);
              continue;
            }
            if (picked.has(payload.number)) {
              markHandled(delivery);
              retrying.delete(delivery.id);
              continue;
            }
            picked.add(payload.number);
            await client.request(`POST /app/hook/deliveries/${delivery.id}/attempts`);
            attempted.set(attemptKey(delivery), Date.parse(delivery.delivered_at));
            retrying.delete(delivery.id);
            handledHeads.set(`${slug}#${payload.number}@${payload.head}`, delivery.guid);
            awaiting.add(delivery.guid);
            log(`requested catch-up delivery=${delivery.id}`);
          }
        } catch {
          incomplete = true;
          for (const { delivery } of candidates) {
            if (!handled.has(attemptKey(delivery)) && !attempted.has(attemptKey(delivery))) retrying.add(delivery.id);
          }
          log('could not recover a candidate repository; will retry on the next poll');
        }
      }
      finishScan(newest, scanKey, !incomplete);
    } catch {
      // API error objects may embed credentials, request headers or payloads.
      log('health check, repair or catch-up failed; will retry on the next poll');
    } finally {
      busy = false;
      deps.onCacheStats?.({ attempts: attempted.size, failures: reportedFailures.size });
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
