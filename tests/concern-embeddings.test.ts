/**
 * Concern and skill embeddings are only useful if lookups compare like with
 * like and nothing silently drops a vector:
 *   - nearestConcerns compares a query only with vectors from the same embedder
 *     (legacy untagged vectors only when the length matches),
 *   - an old SQLite file gains the embedding_model column on open,
 *   - merge_concerns re-embeds the merged record instead of clearing it,
 *   - find_similar_concerns searches every bucket,
 *   - an embedder outage neither blocks a merge nor throws out of find_similar,
 *   - the skill-embedding cache misses when the embedder changes.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../agents/common/src/store/sqlite-store.js';
import type { Embedder } from '../agents/common/src/memory/embedder.js';
import { selectSkills } from '../agents/common/src/skills/select.js';
import { buildConcernsStoreTools } from '../agents/curator/src/tools/concerns-store.js';
import type { ToolDef } from '../agents/common/src/tool-def.js';
import { isToolErrorOutput } from '../agents/common/src/trace.js';

const REPO = 'octo/widgets';

function withVault(fn: (vault: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const vault = mkdtempSync(join(tmpdir(), 'revuto-emb-'));
    try { await fn(vault); } finally { rmSync(vault, { recursive: true, force: true }); }
  };
}

/** Deterministic embedder: character counts folded into `dim` buckets. Records every text it embeds. */
function fakeEmbedder(id: string, dim: number): Embedder & { texts: string[] } {
  const texts: string[] = [];
  return {
    id,
    texts,
    async embed(batch: string[]) {
      texts.push(...batch);
      return batch.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % dim] += 1;
        return v;
      });
    },
  };
}

/** The local embedding server is down. */
const downEmbedder: Embedder = {
  id: 'down',
  async embed() { throw new Error('connect ECONNREFUSED 127.0.0.1:8181'); },
};

const concern = (subject: string, extra: Partial<Parameters<SqliteStore['createConcern']>[0]> = {}) =>
  ({ areaBucket: 'src', area: ['src/**'], subject, concern: 'c', context: '', ...extra });

const byName = (tools: readonly ToolDef[], name: string) => tools.find((t) => t.name === name)!;
const call = async (tools: readonly ToolDef[], name: string, input: unknown) =>
  JSON.parse(await byName(tools, name).callback(input) as string);

test('nearestConcerns compares only same-model vectors, plus legacy ones of the query length', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    const same = await store.createConcern(concern('same', { embedding: [1, 0, 0], embeddingModel: 'm1' }));
    const legacy = await store.createConcern(concern('legacy', { embedding: [0.9, 0.1, 0] }));
    await store.createConcern(concern('legacy-short', { embedding: [1, 0] }));
    await store.createConcern(concern('other-model', { embedding: [1, 0, 0], embeddingModel: 'm2' }));
    await store.createConcern(concern('no-vector'));

    const hits = await store.nearestConcerns([1, 0, 0], 10, 'm1');
    assert.deepEqual(hits.map((h) => h.record.recordId), [same.recordId, legacy.recordId]);
    assert.ok(hits[0].score > 0.999);
  } finally { await store.close(); }
}));

test('an existing SQLite file without embedding_model is migrated on open and keeps its legacy vectors', withVault(async (vault) => {
  // The concerns table as created before embeddings carried a model id.
  mkdirSync(join(vault, 'memory'), { recursive: true });
  const old = new Database(join(vault, 'memory', 'octo__widgets.sqlite'));
  old.exec(`CREATE TABLE concerns (
    record_id TEXT PRIMARY KEY, area_bucket TEXT NOT NULL, area_json TEXT NOT NULL,
    subject TEXT NOT NULL, concern TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
    reinforcement_count INTEGER NOT NULL DEFAULT 1, decay_score REAL NOT NULL DEFAULT 1.0,
    embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const f = Float32Array.from([0, 1, 0]);
  old.prepare(`INSERT INTO concerns VALUES ('old-1', 'src', '["src/**"]', 'old', 'c', '', 2, 1.0, ?, 't', 't')`)
    .run(Buffer.from(f.buffer));
  old.close();

  const store = new SqliteStore(vault, REPO);
  try {
    const created = await store.createConcern(concern('new', { embedding: [0, 1, 0], embeddingModel: 'm1' }));
    const hits = await store.nearestConcerns([0, 1, 0], 10, 'm1');
    assert.deepEqual(new Set(hits.map((h) => h.record.recordId)), new Set(['old-1', created.recordId]));
  } finally { await store.close(); }
  // Reopening an already-migrated file is a no-op.
  await new SqliteStore(vault, REPO).close();
}));

test('merge_concerns re-embeds the merged record so it stays findable', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    const tools = buildConcernsStoreTools({ store, embedder: fakeEmbedder('fake-8', 8) });
    const record = (subject: string, text: string) => ({ area: ['src/**'], subject, concern: text, context: '' });
    const t = await call(tools, 'create_concern', { area_bucket: 'src', record: record('retry cap', 'cap retries') });
    const s = await call(tools, 'create_concern', { area_bucket: 'lib', record: record('backoff', 'use jitter') });

    const merged = await call(tools, 'merge_concerns', {
      target_record_id: t.record_id, source_record_id: s.record_id,
      merged: record('reconnect policy', 'cap retries and add jitter to the backoff'),
    });
    assert.equal(merged.combined_reinforcement, 2);

    const found = await call(tools, 'find_similar_concerns', { subject: 'reconnect policy', concern: 'cap retries and add jitter to the backoff' });
    assert.equal(found.records.length, 1, 'source is gone, target is still embedded');
    assert.equal(found.records[0].recordId, t.record_id);
    assert.ok(found.records[0].score > 0.999);
  } finally { await store.close(); }
}));

test('find_similar_concerns ranks records across buckets, and degrades without an embedder', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    const tools = buildConcernsStoreTools({ store, embedder: fakeEmbedder('fake-16', 16) });
    const make = (bucket: string, subject: string, text: string) =>
      call(tools, 'create_concern', { area_bucket: bucket, record: { area: [`${bucket}/**`], subject, concern: text, context: '' } });
    await make('src', 'buffer flush', 'flush buffers before closing the socket');
    const other = await make('docs', 'changelog entries', 'every user-facing change needs a changelog line');
    for (let i = 0; i < 5; i++) await make('lib', `filler ${i}`, `zzzz ${i}`);

    const found = await call(tools, 'find_similar_concerns', { subject: 'changelog entries', concern: 'every user-facing change needs a changelog line' });
    assert.equal(found.ok, true);
    assert.equal(found.records.length, 5, 'top 5 only');
    assert.equal(found.records[0].recordId, other.record_id, 'match from another bucket ranks first');
    assert.equal(found.records[0].areaBucket, 'docs');
    for (let i = 1; i < found.records.length; i++) assert.ok(found.records[i - 1].score >= found.records[i].score);

    const plain = buildConcernsStoreTools({ store, embedder: null });
    const none = await call(plain, 'find_similar_concerns', { subject: 'changelog entries', concern: 'x' });
    assert.equal(none.ok, true);
    assert.deepEqual(none.records, []);
    assert.match(none.note, /similarity unavailable/);
  } finally { await store.close(); }
}));

test('the skill-embedding cache misses when the embedder changes', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    await store.writeSkill({ subject: 'net retries', description: 'Use when touching src/net', area: ['src/net/**'], body: 'b', status: 'active' });
    const isSkillText = (t: string) => t.includes('Use when touching src/net');

    const a = fakeEmbedder('model-a', 8);
    await selectSkills(store, a, ['src/net/client.ts']);
    await selectSkills(store, a, ['src/net/client.ts']);
    assert.equal(a.texts.filter(isSkillText).length, 1, 'same model hits the cache');

    const b = fakeEmbedder('model-b', 4);
    await selectSkills(store, b, ['src/net/client.ts']);
    assert.equal(b.texts.filter(isSkillText).length, 1, 'new model re-embeds the skill');
  } finally { await store.close(); }
}));

test('merge_concerns still merges when the embedder is down, and checks the records before embedding', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    const tools = buildConcernsStoreTools({ store, embedder: downEmbedder });
    const t = await store.createConcern(concern('retry cap'));
    const s = await store.createConcern(concern('backoff', { areaBucket: 'lib' }));
    const merged = { area: ['src/**'], subject: 'reconnect policy', concern: 'cap retries', context: '' };

    const missing = await byName(tools, 'merge_concerns').callback({ target_record_id: t.recordId, source_record_id: 'nope', merged });
    assert.equal(missing, 'ERROR merge_concerns: target/source not found or identical');

    const out = await call(tools, 'merge_concerns', { target_record_id: t.recordId, source_record_id: s.recordId, merged });
    assert.equal(out.ok, true);
    assert.equal(out.combined_reinforcement, 2);
    assert.match(out.note, /embedder failed .*ECONNREFUSED/);
    assert.equal(await store.getConcern(s.recordId), null, 'source deleted');
    assert.equal((await store.getConcern(t.recordId))?.subject, 'reconnect policy');
  } finally { await store.close(); }
}));

test('find_similar_concerns reports an embedder outage as an ERROR result instead of throwing', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    const tools = buildConcernsStoreTools({ store, embedder: downEmbedder });
    const out = await byName(tools, 'find_similar_concerns').callback({ subject: 'x', concern: 'y' });
    assert.equal(isToolErrorOutput(out), true);
    assert.match(out as string, /similarity unavailable, embedder failed: connect ECONNREFUSED/);
  } finally { await store.close(); }
}));
