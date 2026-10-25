/**
 * Smaller hardening: redirects on model calls, the Grok issuer, credentials in
 * traces, executable content in vault notes, and tokens of failed reviews.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateText } from 'ai';

import { buildChatModel } from '../agents/common/src/model.js';
import { tokenEndpoint } from '../agents/common/src/grok-cli-auth.js';
import { startReviewTrace } from '../agents/common/src/trace.js';
import { sanitizeNote } from '../agents/common/src/outbound.js';
import { MarkdownSkills } from '../agents/common/src/store/markdown-skills.js';
import { NativeStepLimitError } from '../agents/common/src/agy-review.js';
import { openStore } from '../agents/common/src/store/open.js';
import { reviewOnePr } from '../daemon/src/jobs.js';
import { counterKey } from '../daemon/src/review-rounds.js';
import type { ReviewerConfig } from '../agents/common/src/config.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';

test('a model call does not follow a redirect with its key and prompt', async () => {
  let elsewhere = 0;
  const target = createServer((_req, res) => { elsewhere++; res.end('{}'); });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const t = (target.address() as AddressInfo).port;
  const redirector = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${t}/v1/chat/completions` }); res.end(); });
  await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
  const port = (redirector.address() as AddressInfo).port;
  try {
    const model = buildChatModel({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'm', apiKeyEnv: 'REVUTO_TEST_KEY' });
    // A fake value built at runtime, so secret scanners have nothing to match.
    process.env.REVUTO_TEST_KEY = 'k'.repeat(20);
    await assert.rejects(generateText({ model, prompt: 'hi', maxRetries: 0 }));
    assert.equal(elsewhere, 0, 'the redirect target never saw the request');
  } finally {
    delete process.env.REVUTO_TEST_KEY;
    await new Promise<void>((r) => redirector.close(() => r()));
    await new Promise<void>((r) => target.close(() => r()));
  }
});

test('a Grok token refresh only goes to an https x.ai issuer', () => {
  assert.equal(tokenEndpoint(undefined), 'https://auth.x.ai/oauth2/token');
  assert.equal(tokenEndpoint('https://auth.x.ai/'), 'https://auth.x.ai/oauth2/token');
  assert.equal(tokenEndpoint('https://accounts.x.ai'), 'https://accounts.x.ai/oauth2/token');
  assert.throws(() => tokenEndpoint('https://attacker.example'), /must be https on x\.ai/);
  assert.throws(() => tokenEndpoint('http://auth.x.ai'), /must be https on x\.ai/);
  assert.throws(() => tokenEndpoint('https://x.ai.attacker.example'), /must be https on x\.ai/);
});

test('a trace keeps the step, never a credential the tool echoed', () => {
  const vault = mkdtempSync(join(tmpdir(), 'revuto-trace-redact-'));
  process.env.REVUTO_TEST_TOKEN = 'live-token-value-987654';
  try {
    const trace = startReviewTrace({ vaultPath: vault, repo: 'o/r', prNumber: 1, headSha: 'a'.repeat(40), model: 'm', startedAt: new Date() });
    trace.step('main', { toolResults: [{ output: 'env: REVUTO_TEST_TOKEN=live-token-value-987654 and ghp_' + 'B'.repeat(36) }] });
    const text = readFileSync(trace.path!, 'utf8');
    assert.doesNotMatch(text, /live-token-value-987654|ghp_B{36}/);
    assert.match(text, /\[redacted\]/);
  } finally { delete process.env.REVUTO_TEST_TOKEN; rmSync(vault, { recursive: true, force: true }); }
});

test('vault notes written from model output run and load nothing in Obsidian', () => {
  const note = sanitizeNote('Use this.\n<img src=https://evil/p.png>\n```dataviewjs\napp.vault.adapter.write("x", "y")\n```\n![b](https://evil/b.gif)');
  assert.doesNotMatch(note, /<img|```dataviewjs|!\[b\]/);
  assert.match(note, /```text\napp\.vault/);
  const vault = mkdtempSync(join(tmpdir(), 'revuto-note-'));
  try {
    const skills = new MarkdownSkills(vault, 'o__r');
    skills.writeTextbook('# T\n```templater\n<% tp.system %>\n```');
    assert.doesNotMatch(skills.readTextbook()!, /```templater/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('a review that fails after spending tokens still counts them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'failed-tokens-'));
  const HEAD = 'a'.repeat(40);
  const cfg = { vaultPath: root, review: { workspaceDir: join(root, 'workspaces'), maxConcurrent: 4, maxConcurrentPerRepo: 2, maxRounds: 10 },
    github: { tokenEnv: 'TEST_UNUSED' }, models: { embedder: null }, limits: { dailyReviews: 0, dailyTokens: 1_000_000 }, store: { backend: 'sqlite' } } as ReviewerConfig;
  const auth = { login: 'reviewer', token: async () => 'unused', octokit: {
    pulls: { get: async () => ({ data: { head: { sha: HEAD }, state: 'open', draft: false, html_url: 'https://example.test/pr' } }), listReviews: () => {} },
    paginate: async () => [],
  } } as unknown as GithubAuth;
  try {
    await assert.rejects(reviewOnePr(cfg, 'a/repo', 7, { githubAuth: auth, runReview: async () => { throw new NativeStepLimitError('step limit', 3, 4321); } }));
    const store = await openStore(cfg, 'a/repo');
    try {
      const day = new Date().toISOString().slice(0, 10);
      assert.equal(await store.getCounter(counterKey('tokens', day)), 4321);
    } finally { await store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
