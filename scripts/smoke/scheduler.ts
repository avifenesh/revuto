/**
 * Deterministic Phase 3 smoke: reviewer registry round-trip + schedule planning
 * (per-repo overrides merged over config defaults). No GitHub/LLM calls.
 *
 *   npx tsx scripts/smoke/scheduler.ts
 */
import assert from 'node:assert/strict';
import cron from 'node-cron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { writeReviewer, listReviewers, readReviewer } from '../../daemon/src/reviewers.js';
import { planSchedule } from '../../daemon/src/scheduler.js';

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

console.log('PASS: reviewer registry round-trip + per-repo schedule merge + cron validity');
