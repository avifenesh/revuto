/**
 * Deterministic Phase 3 smoke: reviewer registry round-trip + schedule planning
 * (per-repo overrides merged over config defaults). No GitHub/LLM calls.
 *
 *   npx tsx scripts/smoke/scheduler.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import cron from 'node-cron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { writeReviewer, listReviewers, readReviewer } from '../../daemon/src/reviewers.js';
import { planSchedule } from '../../daemon/src/scheduler.js';
import { runQueuedForRepo } from '../../daemon/src/repo-queue.js';

const vault = mkdtempSync(join(tmpdir(), 'reviewer-sched-'));
const config: ReviewerConfig = {
  vaultPath: vault,
  github: { tokenEnv: 'GH_TOKEN' },
  models: {
    review: { baseURL: 'http://x/v1', model: 'm' },
    curator: { baseURL: 'http://x/v1', model: 'm' },
    distill: { baseURL: 'http://x/v1', model: 'm' },
    embedder: null,
  },
  schedules: { review: '*/12 * * * *', learn: '0 */4 * * *', decay: '0 3 * * *' },
  review: { maxSteps: 1, allowWrite: false, workspaceDir: join(vault, '.ws') },
  limits: { maxOutputTokens: { review: 1, curator: 1, distill: 1 }, dailyReviews: 0, learnBatch: 0, dailyLearn: 0, dailyTokens: 0 },
  store: { backend: 'sqlite', surreal: { url: '', namespace: 'reviewer' } },
};

// register two repos: one with a review-cron override, one with defaults
writeReviewer(config, { repo: 'octo/alpha', schedules: { review: '*/5 * * * *' }, authorAllowlist: ['alice'], botLogin: 'reviewer-bot' });
writeReviewer(config, { repo: 'octo/beta', autoActivate: true });

const reviewers = listReviewers(config);
assert.equal(reviewers.length, 2, 'two reviewers registered');

const alpha = readReviewer(config, 'octo/alpha')!;
assert.deepEqual(alpha.authorAllowlist, ['alice'], 'allowlist persisted');
assert.equal(alpha.botLogin, 'reviewer-bot', 'botLogin persisted');

const plan = planSchedule(config, reviewers);
const planAlpha = plan.find((p) => p.repo === 'octo/alpha')!;
const planBeta = plan.find((p) => p.repo === 'octo/beta')!;
assert.equal(planAlpha.schedules.review, '*/5 * * * *', 'per-repo review override applied');
assert.equal(planAlpha.schedules.learn, '0 */4 * * *', 'learn falls back to config default');
assert.equal(planBeta.schedules.review, '*/12 * * * *', 'beta uses config default review');

for (const p of plan) {
  for (const expr of Object.values(p.schedules)) assert.ok(cron.validate(expr), `valid cron: ${expr}`);
}

const events: string[] = [];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

await Promise.all([
  runQueuedForRepo(config, 'octo/alpha', async () => {
    events.push('alpha-1-start');
    await delay(30);
    events.push('alpha-1-end');
  }, { pollMs: 1 }),
  runQueuedForRepo(config, 'octo/alpha', async () => {
    events.push('alpha-2-start');
    await delay(5);
    events.push('alpha-2-end');
  }, { pollMs: 1 }),
  runQueuedForRepo(config, 'octo/beta', async () => {
    events.push('beta-start');
    await delay(5);
    events.push('beta-end');
  }, { pollMs: 1 }),
]);

assert.ok(events.indexOf('alpha-2-start') > events.indexOf('alpha-1-end'), 'same repo jobs are serialized');
assert.ok(events.indexOf('beta-start') < events.indexOf('alpha-1-end'), 'different repo jobs can overlap');

const childEvents: string[] = [];
const waiters = new Map<string, Array<() => void>>();
let child: ChildProcessWithoutNullStreams | null = null;

function noteChildEvent(event: string): void {
  childEvents.push(event);
  const resolvers = waiters.get(event) ?? [];
  waiters.delete(event);
  for (const resolve of resolvers) resolve();
}

function waitForChildEvent(event: string): Promise<void> {
  if (childEvents.includes(event)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for child event: ${event}`)), 5_000);
    const resolveOnce = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    waiters.set(event, [...(waiters.get(event) ?? []), resolveOnce]);
  });
}

function watchChildOutput(proc: ChildProcessWithoutNullStreams): void {
  let stdout = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) noteChildEvent(line);
    }
  });
}

function spawnQueueWorker(repo: string): ChildProcessWithoutNullStreams {
  const workerSource = `
const { runQueuedForRepo } = await import(process.env.REVUTO_QUEUE_MODULE);
const config = JSON.parse(process.env.REVUTO_QUEUE_CONFIG);
const repo = process.env.REVUTO_QUEUE_REPO;
process.stdout.write('child-ready\\n');
await runQueuedForRepo(config, repo, async () => {
  process.stdout.write('child-start\\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.stdout.write('child-end\\n');
}, { pollMs: 1 });
`;
  const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REVUTO_QUEUE_MODULE: pathToFileURL(join(process.cwd(), 'daemon/src/repo-queue.ts')).href,
      REVUTO_QUEUE_CONFIG: JSON.stringify(config),
      REVUTO_QUEUE_REPO: repo,
    },
  });
  watchChildOutput(proc);
  proc.stderr.pipe(process.stderr);
  return proc;
}

await runQueuedForRepo(config, 'octo/manual', async () => {
  childEvents.push('parent-start');
  child = spawnQueueWorker('octo/manual');
  await waitForChildEvent('child-ready');
  await delay(20);
  assert.equal(childEvents.includes('child-start'), false, 'child process waits behind an existing repo lock');
  childEvents.push('parent-end');
}, { pollMs: 1 });

assert.ok(child, 'child queue worker was spawned');
const [code] = await once(child, 'exit') as [number | null];
assert.equal(code, 0, 'child queue worker exited cleanly');
assert.ok(childEvents.indexOf('child-start') > childEvents.indexOf('parent-end'), 'cross-process jobs for the same repo are serialized');

console.log('PASS: reviewer registry round-trip + per-repo schedule merge + cron validity + per-repo job queue');
