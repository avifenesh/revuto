/**
 * Smoke for `revuto doctor`: probes chat + embedding endpoints against the
 * fake OpenAI-compatible server. (GitHub probe fails without a token — expected;
 * we assert only the model probes here.)
 *
 *   npx tsx scripts/smoke/doctor.ts
 */
import assert from 'node:assert/strict';
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { runDoctor } from '../../daemon/src/doctor.js';
import { startFakeOpenAI } from './fake-openai.js';

const srv = await startFakeOpenAI(() => ({ text: 'pong' }));
const m = { baseURL: srv.url, model: 'fake' };
const config: ReviewerConfig = {
  vaultPath: '/tmp/reviewer-doctor',
  github: { tokenEnv: 'REVIEWER_NO_SUCH_TOKEN_ENV' },
  models: { review: m, curator: m, distill: m, embedder: m },
  schedules: { review: '* * * * *', learn: '* * * * *', decay: '* * * * *' },
  review: { maxSteps: 1, maxOutputTokens: 5, allowWrite: false, workspaceDir: '/tmp/reviewer-doctor/.ws' },
  store: { backend: 'sqlite', surreal: { url: '', namespace: 'reviewer' } },
};

const report = await runDoctor(config);
await srv.close();

assert.ok(report.models.length >= 2, 'probes the chat endpoint + the embedder');
assert.ok(report.models.every((p) => p.ok), `all model probes reachable: ${JSON.stringify(report.models.filter((p) => !p.ok))}`);
assert.ok(report.models.some((p) => p.kind === 'chat'), 'has a chat probe');
assert.ok(report.models.some((p) => p.kind === 'embedding'), 'has an embedding probe');
// chat roles share one endpoint+model → deduped into a single probe
assert.ok(report.models.some((p) => p.roles.includes('review') && p.roles.includes('curator')), 'shared chat endpoint deduped');

console.log('PASS: doctor probes chat + embedding endpoints (dedup OK)');
