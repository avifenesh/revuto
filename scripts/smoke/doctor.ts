/**
 * Smoke for `revuto doctor`: probes Responses, chat, and embedding endpoints
 * against the fake OpenAI-compatible server. (GitHub probe fails without a token
 * — expected; we assert only the model probes here.)
 *
 *   npx tsx scripts/smoke/doctor.ts
 */
import assert from 'node:assert/strict';
import type { ModelSpec, ReviewerConfig } from '../../agents/common/src/config.js';
import { runDoctor } from '../../daemon/src/doctor.js';
import { startFakeOpenAI } from './fake-openai.js';

const srv = await startFakeOpenAI(() => ({ text: 'pong' }));
const m: ModelSpec = { baseURL: srv.url, model: 'fake' };
const responses: ModelSpec = { ...m, name: 'bedrock-mantle', api: 'responses', auth: 'none', reasoningEffort: 'medium' };
const config: ReviewerConfig = {
  vaultPath: '/tmp/reviewer-doctor',
  github: { tokenEnv: 'REVIEWER_NO_SUCH_TOKEN_ENV' },
  models: { review: responses, curator: m, distill: m, embedder: m },
  schedules: { review: '* * * * *', learn: '* * * * *', decay: '* * * * *' },
  review: { maxSteps: 1, allowWrite: false, workspaceDir: '/tmp/reviewer-doctor/.ws' },
  limits: { maxOutputTokens: { review: 5, curator: 5, distill: 5 }, dailyReviews: 0, learnBatch: 0, dailyLearn: 0, dailyTokens: 0 },
  store: { backend: 'sqlite', surreal: { url: '', namespace: 'reviewer' } },
};

const report = await runDoctor(config);
await srv.close();

assert.ok(report.models.length >= 3, 'probes Responses, chat, and embedding endpoints separately');
assert.ok(report.models.every((p) => p.ok), `all model probes reachable: ${JSON.stringify(report.models.filter((p) => !p.ok))}`);
assert.ok(report.models.some((p) => p.kind === 'chat' && p.api === 'responses' && p.roles.includes('review')), 'has a Responses chat probe');
assert.ok(report.models.some((p) => p.kind === 'chat' && p.api === 'chat' && p.roles.includes('curator') && p.roles.includes('distill')), 'has a default chat probe');
assert.ok(report.models.some((p) => p.kind === 'embedding'), 'has an embedding probe');
assert.ok(report.models.every((p) => p.responseModel === 'fake'), `all model probes report provider model: ${JSON.stringify(report.models)}`);
assert.ok(srv.getPaths().some((p) => p.endsWith('/responses')), 'doctor probes the Responses endpoint');
assert.ok(srv.getPaths().some((p) => p.endsWith('/chat/completions')), 'doctor probes the chat endpoint separately');
assert.ok(report.store.ok, `store probe reachable (sqlite): ${report.store.error ?? ''}`);
assert.equal(report.store.backend, 'sqlite', 'store backend reported');

console.log('PASS: doctor probes Responses + chat + embedding + store backend (dedup OK)');
