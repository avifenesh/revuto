/**
 * Focused node-cron compatibility smoke for the daemon cadence contract.
 *
 * It schedules fake review / learn / decay jobs through the same scheduler path
 * as the daemon, then proves node-cron starts the tasks and the per-repo queue
 * still serializes jobs that fire on the same second.
 *
 *   npx tsx scripts/smoke/cron-cadence.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { listReviewers, writeReviewer } from '../../daemon/src/reviewers.js';
import { scheduleReviewers, type SchedulerJobs } from '../../daemon/src/scheduler.js';

const vault = mkdtempSync(join(tmpdir(), 'revuto-cron-cadence-'));
const config: ReviewerConfig = {
  vaultPath: vault,
  github: { tokenEnv: 'GH_TOKEN' },
  models: {
    review: { baseURL: 'http://x/v1', model: 'm' },
    curator: { baseURL: 'http://x/v1', model: 'm' },
    distill: { baseURL: 'http://x/v1', model: 'm' },
    embedder: null,
  },
  schedules: { review: '* * * * * *', learn: '* * * * * *', decay: '* * * * * *' },
  review: { maxSteps: 1, allowWrite: false, workspaceDir: join(vault, '.ws') },
  limits: { maxOutputTokens: { review: 1, curator: 1, distill: 1 }, dailyReviews: 0, learnBatch: 0, dailyLearn: 0, dailyTokens: 0 },
  store: { backend: 'sqlite', surreal: { url: '', namespace: 'reviewer' } },
};

type JobName = 'review' | 'learn' | 'decay';
type Event = { job: JobName; phase: 'start' | 'end'; at: number };

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const events: Event[] = [];
let activeJobs = 0;
let maxActiveJobs = 0;

function seen(job: JobName): boolean {
  return events.some((event) => event.job === job && event.phase === 'end');
}

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await delay(10);
  }
}

async function runJob(job: JobName): Promise<{ ok: true }> {
  activeJobs++;
  maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
  events.push({ job, phase: 'start', at: Date.now() });
  await delay(40);
  events.push({ job, phase: 'end', at: Date.now() });
  activeJobs--;
  return { ok: true };
}

writeReviewer(config, { repo: 'octo/cadence' });

const jobs: SchedulerJobs = {
  review: () => runJob('review'),
  learn: () => runJob('learn'),
  decay: () => runJob('decay'),
};

const tasks = scheduleReviewers(config, listReviewers(config), jobs);
try {
  assert.equal(tasks.length, 3, 'review, learn, and decay tasks were scheduled');
  await waitUntil(() => seen('review') && seen('learn') && seen('decay'), 'one review/learn/decay cadence');
} finally {
  await Promise.all(tasks.map((task) => task.destroy()));
  rmSync(vault, { recursive: true, force: true });
}

const starts = events.filter((event) => event.phase === 'start');
assert.deepEqual(new Set(starts.map((event) => event.job)), new Set<JobName>(['review', 'learn', 'decay']), 'all daemon job kinds fired');
assert.equal(maxActiveJobs, 1, 'same-repo jobs stayed serialized when cron fired them together');
assert.ok(Math.max(...starts.map((event) => event.at)) - Math.min(...starts.map((event) => event.at)) < 1_500, 'all jobs fired within one cadence window');

console.log('PASS: node-cron daemon cadence fired review/learn/decay and kept same-repo jobs serialized');
