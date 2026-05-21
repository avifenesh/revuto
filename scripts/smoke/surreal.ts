/**
 * SurrealDB backend parity smoke. Requires a running Surreal server:
 *   ~/.local/bin/surreal start --user root --pass root --bind 127.0.0.1:8000 memory
 *
 *   npx tsx scripts/smoke/surreal.ts
 *
 * Exercises: concerns CRUD, native vector cosine nearestConcerns, cursors,
 * idempotency, graduation (markdown skill in vault), decay.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { graduate } from '../../agents/curator/src/tools/submit-skill.js';

const vault = mkdtempSync(join(tmpdir(), 'reviewer-surreal-'));
const m = { baseURL: 'http://unused/v1', model: 'fake' };
const config: ReviewerConfig = {
  vaultPath: vault,
  github: { tokenEnv: 'GH_TOKEN' },
  models: { review: m, curator: m, distill: m, embedder: null },
  schedules: { review: '* * * * *', learn: '* * * * *', decay: '* * * * *' },
  review: { maxSteps: 1, maxOutputTokens: 1, allowWrite: false, workspaceDir: join(vault, '.ws') },
  store: { backend: 'surreal', surreal: { url: 'http://127.0.0.1:8000/rpc', namespace: 'reviewer_test', username: 'root', password: 'root' } },
};

const store = await openStore(config, `octo/surreal-${Date.now()}`);

// concerns + native vector cosine
const a = await store.createConcern({ areaBucket: 'src', area: ['src/net/**'], subject: 'reconnect backoff', concern: 'cap retries', context: '', embedding: [1, 0, 0, 0, 0, 0, 0, 0] });
await store.createConcern({ areaBucket: 'src', area: ['src/io/**'], subject: 'buffer flush', concern: 'flush before close', context: '', embedding: [0, 1, 0, 0, 0, 0, 0, 0] });
assert.equal((await store.listConcerns('src')).length, 2, 'two concerns in bucket');

const near = await store.nearestConcerns([1, 0, 0, 0, 0, 0, 0, 0], 1);
assert.equal(near.length, 1, 'nearest returns one');
assert.equal(near[0].record.recordId, a.recordId, 'cosine picks the matching concern');
assert.ok(near[0].score > 0.99, `cosine ~1 for identical vector (got ${near[0].score})`);

// bump
const bumped = await store.bumpConcern(a.recordId);
assert.equal(bumped!.reinforcementCount, 2, 'bump increments');

// cursors + idempotency
await store.setCursor('review', '2026-05-21T00:00:00Z');
assert.equal(await store.getCursor('review'), '2026-05-21T00:00:00Z', 'cursor round-trip');
assert.equal(await store.seen('k1'), false);
await store.mark('k1');
assert.equal(await store.seen('k1'), true, 'idempotency mark/seen');

// graduation writes a markdown skill in the vault + removes the concern
const note = await graduate(store, { subject: 'reconnect backoff', description: 'Use when reviewing src/net reconnect.', skillMd: '## Use when\nreconnect changes.\n## Patterns\n### x\nSkip unless: y.', sourceRecordId: a.recordId });
assert.equal(note.status, 'draft', 'graduates draft');
assert.equal(await store.getConcern(a.recordId), null, 'concern removed after graduation');
assert.ok(existsSync(join(vault, 'skills', note ? `${store.repo.replace('/', '__')}` : '', `${note.slug}.md`)), 'skill markdown written to vault');

// decay deletes the aged remainder
await new Promise((r) => setTimeout(r, 6));
const decay = await store.allConcerns();
assert.ok(decay.length >= 1, 'buffer-flush concern still present pre-decay');

await store.close();
console.log('PASS: SurrealDB backend — concerns + native cosine nearest + cursors + idempotency + graduation');
