/**
 * The embedder is optional, so it must never fail a review, and what it is sent
 * must fit its window:
 *   - an embedder error in skill selection falls back to area-glob match,
 *   - a wide PR's touched-area query is bounded before it reaches the embedder,
 *     most-touched areas first, so the PR still gets embedding-based selection,
 *   - every input the OpenAI-compatible embedder sends is bounded, so the
 *     curator's concern writes and lookups keep their embeddings,
 *   - models.embedder.maxInputChars is validated and honored.
 *
 * The stub server stands in for llama.cpp serving bge-small-en-v1.5 with
 * `--embedding -c 512`, which refuses an input over 512 tokens with the error
 * agent-sh/agentsys#439 hit. It refuses inputs over 880 characters: measured on
 * the live server, 880 characters of the densest path-like text seen in that
 * PR tokenize to 500 tokens.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { SqliteStore } from '../agents/common/src/store/sqlite-store.js';
import type { Embedder } from '../agents/common/src/memory/embedder.js';
import { createOpenAICompatEmbedder } from '../agents/common/src/memory/openai-embedder.js';
import { selectSkills } from '../agents/common/src/skills/select.js';
import { buildConcernsStoreTools } from '../agents/curator/src/tools/concerns-store.js';
import { loadConfig, type ModelSpec } from '../agents/common/src/config.js';
import type { ToolDef } from '../agents/common/src/tool-def.js';

const REPO = 'octo/widgets';
const SERVER_MAX_CHARS = 880;
const OVERSIZE = 'input (1056 tokens) is too large to process. increase the physical batch size (current batch size: 512)';

function withVault(fn: (vault: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const vault = mkdtempSync(join(tmpdir(), 'revuto-embb-'));
    try { await fn(vault); } finally { rmSync(vault, { recursive: true, force: true }); }
  };
}

/** A /v1/embeddings stub with llama.cpp's input limit. Every vector is the same, so every skill scores 1. */
async function withStubEmbedder(fn: (baseURL: string, inputs: string[]) => Promise<void>): Promise<void> {
  const inputs: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] };
      inputs.push(...input);
      res.setHeader('content-type', 'application/json');
      if (input.some((t) => t.length > SERVER_MAX_CHARS)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { code: 400, message: OVERSIZE, type: 'invalid_request_error' } }));
        return;
      }
      res.end(JSON.stringify({
        object: 'list',
        data: input.map((_, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })),
        model: 'bge-small-en-v1.5',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, inputs);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const spec = (baseURL: string, extra: Partial<ModelSpec> = {}): ModelSpec => ({ baseURL, model: 'bge-small-en-v1.5', ...extra });

/** A 210-file PR over 140 areas, like agent-sh/agentsys#439. `lib/` is touched most, then `plugins/`. */
function widePr(): string[] {
  // Listed in path order, so the most-touched areas come last.
  const files: string[] = [];
  for (let i = 0; i < 140; i++) files.push(`area-number-${i}/sub-directory-${i}/index.test.js`);
  for (let i = 0; i < 50; i++) files.push(`lib/core/module-${i}.js`);
  for (let i = 0; i < 20; i++) files.push(`plugins/deslop/file-${i}.md`);
  return files;
}

const byName = (tools: readonly ToolDef[], name: string) => tools.find((t) => t.name === name)!;
const call = async (tools: readonly ToolDef[], name: string, input: unknown) =>
  JSON.parse(await byName(tools, name).callback(input) as string);

test('an embedder error in skill selection falls back to area-glob match and logs one warning', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    await store.writeSkill({ subject: 'net retries', description: 'Use when touching src/net', area: ['src/net/**'], body: 'net body', status: 'active' });
    await store.writeSkill({ subject: 'docs style', description: 'Use when touching docs', area: ['docs/**'], body: 'docs body', status: 'active' });
    const failures: Embedder[] = [
      { id: 'oversize', async embed() { throw new Error(OVERSIZE); } },
      { id: 'down', async embed() { throw new Error('connect ECONNREFUSED 127.0.0.1:8181'); } },
      { id: 'slow', async embed() { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } },
    ];
    for (const embedder of failures) {
      warnings.length = 0;
      const md = await selectSkills(store, embedder, ['src/net/client.ts']);
      assert.match(md, /net body/, `${embedder.id}: the glob match is selected`);
      assert.doesNotMatch(md, /docs body/, `${embedder.id}: a non-matching skill is not`);
      assert.equal(warnings.length, 1, `${embedder.id}: one warning line`);
      assert.match(warnings[0], /\[skills\].*area-glob/);
    }
    assert.match(warnings[0], /aborted due to timeout/, 'the warning names the error');
  } finally {
    console.warn = warn;
    await store.close();
  }
}));

test('a wide PR query is bounded before it reaches the embedder, most-touched areas first', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    // Only embedding selection picks this skill: its area matches no touched file.
    await store.writeSkill({ subject: 'release notes', description: 'Use when shipping', area: ['CHANGELOG.md'], body: 'release body', status: 'active' });
    await withStubEmbedder(async (baseURL, inputs) => {
      const md = await selectSkills(store, createOpenAICompatEmbedder(spec(baseURL)), widePr());
      assert.match(md, /release body/, 'embedding-based selection ran');
      const query = inputs.at(-1)!;
      assert.ok(query.length <= 800, `query is ${query.length} chars`);
      assert.ok(query.startsWith('lib lib/core plugins plugins/deslop '), `most-touched first: ${query.slice(0, 60)}`);
      for (const term of query.split(' ')) assert.match(term, /^[\w-]+(\/[\w-]+)?$/, `whole area names only: ${term}`);

      // A configured limit replaces the default.
      inputs.length = 0;
      await store.writeSkill({ subject: 'more', description: 'x', area: ['nothing/**'], body: 'b', status: 'active' });
      await selectSkills(store, createOpenAICompatEmbedder(spec(baseURL, { maxInputChars: 100 })), widePr());
      assert.ok(inputs.length > 0 && inputs.every((t) => t.length <= 100), `every input within 100 chars: ${inputs.map((t) => t.length)}`);
    });
  } finally { await store.close(); }
}));

test('the curator keeps embedding long concerns: create and find_similar stay within the window', withVault(async (vault) => {
  const store = new SqliteStore(vault, REPO);
  try {
    await withStubEmbedder(async (baseURL, inputs) => {
      const tools = buildConcernsStoreTools({ store, embedder: createOpenAICompatEmbedder(spec(baseURL)) });
      const long = 'Retry the request with capped exponential backoff and jitter. '.repeat(50);
      const out = await call(tools, 'create_concern', {
        area_bucket: 'src', record: { area: ['src/**'], subject: 'retry policy', concern: long, context: '' },
      });
      assert.equal(out.ok, true);
      assert.equal(out.note, undefined, `stored with an embedding: ${out.note}`);
      assert.deepEqual(await store.untaggedConcerns(), [], 'the record is tagged with the embedder');

      const found = await call(tools, 'find_similar_concerns', { subject: 'retry policy', concern: long });
      assert.equal(found.ok, true);
      assert.equal(found.records[0].recordId, out.record_id);
      assert.ok(inputs.every((t) => t.length <= 800), `inputs: ${inputs.map((t) => t.length)}`);
    });
  } finally { await store.close(); }
}));

test('models.embedder.maxInputChars must be a positive integer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-embcfg-'));
  const path = join(dir, 'revuto.config.json');
  const http = (model: string) => ({ baseURL: 'http://127.0.0.1:1/v1', model });
  const base = { vaultPath: dir, models: { review: http('r'), curator: http('c'), distill: http('d') } };
  try {
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, embedder: { ...http('e'), maxInputChars: 1200 } } }));
    assert.equal(loadConfig(path).models.embedder?.maxInputChars, 1200);
    for (const bad of [0, -5, 1.5, '800']) {
      writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, embedder: { ...http('e'), maxInputChars: bad } } }));
      assert.throws(() => loadConfig(path), /models\.embedder\.maxInputChars must be a positive integer/, String(bad));
    }
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, curator: { ...http('c'), maxInputChars: 800 } } }));
    assert.throws(() => loadConfig(path), /maxInputChars applies only to models\.embedder/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
