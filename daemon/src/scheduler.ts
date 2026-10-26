/**
 * Long-lived scheduler. Reads the registered reviewers from the vault and
 * schedules each repo's review / learn / decay jobs with node-cron. node-cron's
 * timers keep the process alive, so this is the daemon's main loop. Run it as a
 * systemd user service for restart-on-reboot.
 *
 * The schedule follows the registry live: `revuto add`, `remove`, `pause`,
 * `resume` and `cron` take effect without a daemon restart.
 */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { listReviewers, readReviewer, effectiveSchedules, type ReviewerSettings } from './reviewers.js';
import { reviewRepo, learnRepo, decayRepo } from './jobs.js';
import { runQueuedForRepo } from './repo-queue.js';
import { startWebhookHealthMonitor } from './webhook-health.js';

export { runQueuedForRepo } from './repo-queue.js';

async function guard(config: ReviewerConfig, job: string, repo: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  const run = async (): Promise<void> => {
    const t = Date.now();
    try {
      const res = await fn();
      console.log(`[${job}] ${repo} ${res ? JSON.stringify(res) : ''} (${Date.now() - t}ms)`);
    } catch (e) {
      console.error(`[${job}] ${repo} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (job === 'review') await run();
  else await runQueuedForRepo(config, repo, run);
}

export interface ScheduledRepo {
  readonly repo: string;
  readonly schedules: { review: string; learn: string; decay: string };
}

export interface SchedulerJobs {
  readonly review: (config: ReviewerConfig, reviewer: ReviewerSettings) => Promise<unknown> | unknown;
  readonly learn: (config: ReviewerConfig, reviewer: ReviewerSettings) => Promise<unknown> | unknown;
  readonly decay: (config: ReviewerConfig, reviewer: ReviewerSettings) => Promise<unknown> | unknown;
}

const DEFAULT_JOBS: SchedulerJobs = {
  review: (config, reviewer) => reviewRepo(config, reviewer),
  learn: (config, reviewer) => learnRepo(config, reviewer),
  decay: (config, reviewer) => decayRepo(config, reviewer.repo),
};

/** Plan the schedule without starting timers — used by the daemon and by tests. */
export function planSchedule(config: ReviewerConfig, reviewers: ReviewerSettings[]): ScheduledRepo[] {
  return reviewers.map((r) => ({ repo: r.repo, schedules: effectiveSchedules(config, r) }));
}

function scheduleRepo(config: ReviewerConfig, r: ReviewerSettings, jobs: SchedulerJobs): ScheduledTask[] {
  if (r.paused) { console.log(`paused ${r.repo} — not scheduled`); return []; }
  const s = effectiveSchedules(config, r);
  // A job reads the repo's settings when it fires, so an edit to a field that does not
  // move the timers (allowlist, botLogin, autoActivate) still reaches the next run.
  const current = (): ReviewerSettings => readReviewer(config, r.repo) ?? r;
  const tasks: ScheduledTask[] = [];
  for (const [job, expr, fn] of [
    ['review', s.review, () => jobs.review(config, current())],
    ['learn', s.learn, () => jobs.learn(config, current())],
    ['decay', s.decay, () => jobs.decay(config, current())],
  ] as const) {
    if (!cron.validate(expr)) {
      console.error(`[${job}] ${r.repo}: invalid cron "${expr}" — skipped`);
      continue;
    }
    tasks.push(cron.schedule(expr, () => guard(config, job, r.repo, fn)));
  }
  console.log(`scheduled ${r.repo}: review='${s.review}' learn='${s.learn}' decay='${s.decay}'`);
  return tasks;
}

export function scheduleReviewers(
  config: ReviewerConfig,
  reviewers: ReviewerSettings[],
  jobs: SchedulerJobs = DEFAULT_JOBS,
): ScheduledTask[] {
  return reviewers.flatMap((r) => scheduleRepo(config, r, jobs));
}

export interface ScheduleChange {
  added: string[];
  removed: string[];
  changed: string[];
}

/** The fields that decide a repo's timers; any change in them replaces the timers. */
function timerKey(config: ReviewerConfig, r: ReviewerSettings): string {
  return JSON.stringify({ paused: !!r.paused, schedules: effectiveSchedules(config, r) });
}

/**
 * The registry-backed schedule. `reconcile` brings the timers in line with the
 * registry: it starts new repos, stops removed ones, and replaces repos whose pause
 * state or schedules changed. Untouched repos keep their timers, so a reconcile
 * never shifts or doubles a job that is already due.
 */
export class LiveSchedule {
  private readonly repos = new Map<string, { key: string; tasks: ScheduledTask[] }>();

  constructor(
    private readonly config: ReviewerConfig,
    private readonly jobs: SchedulerJobs = DEFAULT_JOBS,
  ) {}

  reconcile(reviewers: ReviewerSettings[] = listReviewers(this.config)): ScheduleChange {
    const change: ScheduleChange = { added: [], removed: [], changed: [] };
    const seen = new Set<string>();
    for (const r of reviewers) {
      seen.add(r.repo);
      const key = timerKey(this.config, r);
      const prev = this.repos.get(r.repo);
      if (prev?.key === key) continue;
      if (prev) {
        for (const t of prev.tasks) void t.stop();
        change.changed.push(r.repo);
      } else {
        change.added.push(r.repo);
      }
      this.repos.set(r.repo, { key, tasks: scheduleRepo(this.config, r, this.jobs) });
    }
    for (const [repo, prev] of this.repos) {
      if (seen.has(repo)) continue;
      for (const t of prev.tasks) void t.stop();
      this.repos.delete(repo);
      change.removed.push(repo);
      console.log(`unscheduled ${repo}: no longer registered`);
    }
    return change;
  }

  /** Repos that have timers now (paused repos are tracked but have none). */
  scheduled(): string[] {
    return [...this.repos].filter(([, v]) => v.tasks.length > 0).map(([repo]) => repo);
  }

  stop(): void {
    for (const v of this.repos.values()) for (const t of v.tasks) void t.stop();
    this.repos.clear();
  }
}

// fs.watch can drop events (editors that swap files, a busy inotify queue);
// a slow sweep catches anything it missed
const REGISTRY_SWEEP_MS = 60_000;
const REGISTRY_DEBOUNCE_MS = 500;

/** Reconcile on every registry change, plus a slow sweep. Returns a stop function. */
export function followRegistry(config: ReviewerConfig, schedule: LiveSchedule): () => void {
  let timer: NodeJS.Timeout | null = null;
  const reconcile = () => {
    timer = null;
    try {
      const c = schedule.reconcile();
      if (c.added.length || c.removed.length || c.changed.length) {
        console.log(`[registry] added=${c.added.join(',') || '-'} removed=${c.removed.join(',') || '-'} changed=${c.changed.join(',') || '-'}`);
      }
    } catch (e) {
      console.error(`[registry] reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reconcile, REGISTRY_DEBOUNCE_MS);
    timer.unref();
  };
  let watcher: FSWatcher | null = null;
  const arm = () => {
    if (watcher) return;
    try {
      watcher = watch(join(config.vaultPath, 'reviewers'), { persistent: false }, soon);
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch {
      watcher = null; // no reviewers dir yet: the sweep arms the watch once it exists
    }
  };
  arm();
  const sweep = setInterval(() => { arm(); reconcile(); }, REGISTRY_SWEEP_MS);
  sweep.unref();
  return () => {
    clearInterval(sweep);
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

export function startDaemon(config: ReviewerConfig): LiveSchedule {
  startWebhookHealthMonitor(config);
  const reviewers = listReviewers(config);
  if (reviewers.length === 0) {
    console.warn('no reviewers registered — add one with `revuto init <owner/repo>` (or `revuto add`)');
  }
  const schedule = new LiveSchedule(config);
  schedule.reconcile(reviewers);
  followRegistry(config, schedule);
  return schedule;
}
