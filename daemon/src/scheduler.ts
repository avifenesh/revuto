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

async function guard(job: string, repo: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  const t = Date.now();
  try {
    const res = await fn();
    console.log(`[${job}] ${repo} ${res ? JSON.stringify(res) : ''} (${Date.now() - t}ms)`);
  } catch (e) {
    console.error(`[${job}] ${repo} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface ScheduledRepo {
  readonly repo: string;
  readonly schedules: { review: string; learn: string; decay: string };
}

/** Plan the schedule without starting timers — used by the daemon and by tests. */
export function planSchedule(config: ReviewerConfig, reviewers: ReviewerSettings[]): ScheduledRepo[] {
  return reviewers.map((r) => ({ repo: r.repo, schedules: effectiveSchedules(config, r) }));
}

export function startDaemon(config: ReviewerConfig): ScheduledTask[] {
  const reviewers = listReviewers(config);
  if (reviewers.length === 0) {
    console.warn('no reviewers registered — add one with `reviewer init <owner/repo>` (or `reviewer add`)');
  }

  const tasks: ScheduledTask[] = [];
  for (const r of reviewers) {
    if (r.paused) { console.log(`paused ${r.repo} — not scheduled`); continue; }
    const s = effectiveSchedules(config, r);
    for (const [job, expr, fn] of [
      ['review', s.review, () => reviewRepo(config, r)],
      ['learn', s.learn, () => learnRepo(config, r)],
      ['decay', s.decay, () => decayRepo(config, r.repo)],
    ] as const) {
      if (!cron.validate(expr)) {
        console.error(`[${job}] ${r.repo}: invalid cron "${expr}" — skipped`);
        continue;
      }
      tasks.push(cron.schedule(expr, () => guard(job, r.repo, fn)));
    }
    console.log(`scheduled ${r.repo}: review='${s.review}' learn='${s.learn}' decay='${s.decay}'`);
  }
  return tasks;
}
