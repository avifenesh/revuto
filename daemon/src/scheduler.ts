/**
 * Long-lived scheduler. Reads the registered reviewers from the vault and
 * schedules each repo's review / learn / decay jobs with node-cron. node-cron's
 * timers keep the process alive, so this is the daemon's main loop. Run it as a
 * systemd user service for restart-on-reboot.
 */
import cron, { type ScheduledTask } from 'node-cron';
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { listReviewers, effectiveSchedules, type ReviewerSettings } from './reviewers.js';
import { reviewRepo, learnRepo, decayRepo } from './jobs.js';
import { runQueuedForRepo } from './repo-queue.js';

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

  await runQueuedForRepo(config, repo, run);
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

export function scheduleReviewers(
  config: ReviewerConfig,
  reviewers: ReviewerSettings[],
  jobs: SchedulerJobs = DEFAULT_JOBS,
): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  for (const r of reviewers) {
    if (r.paused) { console.log(`paused ${r.repo} — not scheduled`); continue; }
    const s = effectiveSchedules(config, r);
    for (const [job, expr, fn] of [
      ['review', s.review, () => jobs.review(config, r)],
      ['learn', s.learn, () => jobs.learn(config, r)],
      ['decay', s.decay, () => jobs.decay(config, r)],
    ] as const) {
      if (!cron.validate(expr)) {
        console.error(`[${job}] ${r.repo}: invalid cron "${expr}" — skipped`);
        continue;
      }
      tasks.push(cron.schedule(expr, () => guard(config, job, r.repo, fn)));
    }
    console.log(`scheduled ${r.repo}: review='${s.review}' learn='${s.learn}' decay='${s.decay}'`);
  }
  return tasks;
}

export function startDaemon(config: ReviewerConfig): ScheduledTask[] {
  const reviewers = listReviewers(config);
  if (reviewers.length === 0) {
    console.warn('no reviewers registered — add one with `revuto init <owner/repo>` (or `revuto add`)');
  }

  return scheduleReviewers(config, reviewers);
}
