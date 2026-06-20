/**
 * Covering test for the learn loop, end-to-end, with no GPU/network: a fake
 * OpenAI-compatible endpoint drives the real curator tool loop.
 *
 *   feedback → curator create_concern (via the loop) → 4x reinforcement →
 *   curator graduate (list_skills → submit_skill) → draft/active skills in vault,
 *   source concerns removed → decay deletes a stale concern.
 *
 *   npx tsx scripts/smoke/loop.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { SqliteStore } from '../../agents/common/src/store/sqlite-store.js';
import { runCurator, type FeedbackEvent } from '../../agents/curator/src/run-curator.js';
import { runDecay } from '../../ops/src/decay.js';
import { startFakeOpenAI } from './fake-openai.js';

const vault = mkdtempSync(join(tmpdir(), 'reviewer-loop-'));
const store = new SqliteStore(vault, 'octo/demo');

function cfg(baseURL: string): ReviewerConfig {
  const m = { baseURL, model: 'fake' };
  return {
    vaultPath: vault,
    github: { tokenEnv: 'GH_TOKEN' },
    models: { review: m, curator: m, distill: m, embedder: null },
    schedules: { review: '*/12 * * * *', learn: '0 */4 * * *', decay: '0 3 * * *' },
    review: { maxSteps: 10, allowWrite: false, workspaceDir: join(vault, '.ws') },
    limits: { maxOutputTokens: { review: 1024, curator: 1024, distill: 1024 }, dailyReviews: 0, learnBatch: 0, dailyLearn: 0, dailyTokens: 0 },
    store: { backend: 'sqlite', surreal: { url: '', namespace: 'reviewer' } },
  };
}

const feedback: FeedbackEvent = {
  feedbackId: 'rc-1',
  kind: 'review_comment_reply',
  body: 'agree — cap the retries with backoff',
  repo: 'octo/demo',
  prNumber: 1,
  anchorPath: 'src/net/reconnect.c',
  anchorLine: 10,
  inReplyToBot: 'unbounded retry loop here',
  actor: 'maintainer',
  touchedFiles: ['src/net/reconnect.c'],
};

// 1. CREATE through the real curator loop
const createSrv = await startFakeOpenAI((n) => n === 0
  ? { tool: 'create_concern', args: { area_bucket: 'src', record: { area: ['src/net/**'], subject: 'reconnect backoff', concern: 'cap retries with exponential backoff', context: '' } } }
  : { tool: 'curator_done', args: { decision: 'created', summary: 'created reconnect backoff' } });
const out1 = await runCurator({ config: cfg(createSrv.url), store, embedder: null, feedback });
await createSrv.close();
assert.equal(out1.decision, 'created', 'curator reported created');
const concerns = await store.listConcerns('src');
assert.equal(concerns.length, 1, 'curator created exactly one concern via the loop');
const cid = concerns[0].recordId;

// 2. accumulate to the graduation threshold (3 more reinforcements)
for (let i = 0; i < 3; i++) await store.bumpConcern(cid);
assert.equal((await store.getConcern(cid))!.reinforcementCount, 4, 'reinforced to 4');

// 3. GRADUATE through the real curator loop (list_skills → submit_skill → done)
const gradSrv = await startFakeOpenAI((n) => {
  if (n === 0) return { tool: 'list_skills', args: {} };
  if (n === 1) return {
    tool: 'submit_skill',
    args: {
      subject: 'reconnect backoff',
      description: 'Use when reviewing PRs that touch src/net reconnect or backoff logic in reconnect.c.',
      skill_md: '## Use when\nA PR changes reconnect/backoff in src/net.\n\n## Patterns\n### Unbounded retry\nSkip unless: the reconnect loop changes.\n\n## Do NOT flag\n- Bounded retries that already cap attempts.',
      source_record_id: cid,
    },
  };
  return { tool: 'curator_done', args: { decision: 'graduated', summary: 'graduated reconnect backoff' } };
});
const out2 = await runCurator({ config: cfg(gradSrv.url), store, embedder: null, feedback });
await gradSrv.close();
assert.equal(out2.decision, 'graduated', 'curator reported graduated');
assert.equal(await store.getConcern(cid), null, 'source concern removed after graduation');
const skills = await store.listSkills();
assert.equal(skills.length, 1, 'one topic skill graduated');
assert.equal(skills[0].status, 'draft', 'graduates as draft (awaits approval)');
assert.deepEqual(skills[0].area, ['src/net/**'], 'skill inherits the concern area globs');

// 3b. Auto-activate graduates directly to active through the same curator tool path.
const autoRec = await store.createConcern({
  areaBucket: 'src',
  area: ['src/cache/**'],
  subject: 'cache eviction ordering',
  concern: 'preserve cache eviction ordering',
  context: '',
});
for (let i = 0; i < 3; i++) await store.bumpConcern(autoRec.recordId);
const autoSrv = await startFakeOpenAI((n) => {
  if (n === 0) return { tool: 'list_skills', args: {} };
  if (n === 1) return {
    tool: 'submit_skill',
    args: {
      subject: 'cache eviction ordering',
      description: 'Use when reviewing PRs that touch src/cache eviction cleanup.',
      skill_md: '## Use when\nA PR changes cache eviction cleanup.\n\n## Patterns\n### Ordering drift\nSkip unless: cleanup ordering changes.\n\n## Do NOT flag\n- Refactors that do not alter eviction order.',
      source_record_id: autoRec.recordId,
    },
  };
  return { tool: 'curator_done', args: { decision: 'graduated', summary: 'graduated cache eviction ordering' } };
});
const out3 = await runCurator({ config: cfg(autoSrv.url), store, embedder: null, feedback, autoActivate: true });
await autoSrv.close();
assert.equal(out3.decision, 'graduated', 'auto-activate curator reported graduated');
assert.equal(await store.getConcern(autoRec.recordId), null, 'auto-activated concern removed after graduation');
const activeSkill = (await store.listSkills()).find((skill) => skill.slug === 'cache-eviction-ordering');
assert.equal(activeSkill?.status, 'active', 'auto-activate graduates active');

// 4. decay: a fresh concern survives a normal pass; an aged one is deleted
const fresh = await store.createConcern({ areaBucket: 'a', area: ['a/**'], subject: 's', concern: 'c', context: '' });
const survive = await runDecay(store);
assert.equal(survive.deleted, 0, 'fresh concern survives default decay');
assert.ok(await store.getConcern(fresh.recordId), 'fresh concern still present');
await new Promise((r) => setTimeout(r, 6));
const aggressive = await runDecay(store, { halfLifeMs: 1, floor: 0.5 });
assert.ok(aggressive.deleted >= 1, 'aged concern decayed away below floor');

await store.close();
console.log('PASS: learn loop (curator create → 4x → graduate draft/active skills, concerns removed) + decay');
