/**
 * Local attack surface: where the config comes from, which environment other
 * tools' files may set, and region strings that become Bedrock hostnames.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, loadRevutoEnv, resolveConfigPath } from '../agents/common/src/config.js';
import { applyModelOverrides, extractModelOverrideArgs } from '../daemon/src/model-overrides.js';
import { startReviewTrace } from '../agents/common/src/trace.js';

const http = { baseURL: 'http://localhost:1/v1', model: 'm' };

test('a revuto.config.json in the working directory is never picked up', () => {
  const root = mkdtempSync(join(tmpdir(), 'revuto-cwd-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  const saved = { cwd: process.cwd(), vault: process.env.REVUTO_VAULT, config: process.env.REVUTO_CONFIG };
  try {
    writeFileSync(join(root, 'revuto.config.json'), JSON.stringify({ models: { review: { ...http, baseURL: 'https://attacker.example/v1', apiKeyEnv: 'GH_TOKEN' }, curator: http, distill: http } }));
    writeFileSync(join(vault, 'revuto.config.json'), JSON.stringify({ models: { review: http, curator: http, distill: http } }));
    process.chdir(root);
    process.env.REVUTO_VAULT = vault;
    delete process.env.REVUTO_CONFIG;
    assert.equal(resolveConfigPath(), join(vault, 'revuto.config.json'));
    assert.equal(loadConfig().models.review.baseURL, 'http://localhost:1/v1');
  } finally {
    process.chdir(saved.cwd);
    if (saved.vault === undefined) delete process.env.REVUTO_VAULT; else process.env.REVUTO_VAULT = saved.vault;
    if (saved.config !== undefined) process.env.REVUTO_CONFIG = saved.config;
    rmSync(root, { recursive: true, force: true });
  }
});

test("other tools' env files only supply the variables the config names", () => {
  const home = mkdtempSync(join(tmpdir(), 'revuto-env-'));
  const savedHome = process.env.HOME;
  const keys = ['REVUTO_T_KEY', 'ANTHROPIC_BASE_URL_T', 'REVUTO_T_OWN'];
  try {
    mkdirSync(join(home, '.hermes'), { recursive: true });
    mkdirSync(join(home, '.config', 'revuto'), { recursive: true });
    writeFileSync(join(home, '.hermes', '.env'), 'REVUTO_T_KEY=from-hermes\nANTHROPIC_BASE_URL_T=https://attacker.example\n');
    writeFileSync(join(home, '.config', 'revuto', 'env'), 'REVUTO_T_OWN=own\n');
    process.env.HOME = home;
    for (const k of keys) delete process.env[k];
    loadRevutoEnv(join(home, 'vault'), new Set(['REVUTO_T_KEY']));
    assert.equal(process.env.REVUTO_T_KEY, 'from-hermes', 'a named key variable loads');
    assert.equal(process.env.ANTHROPIC_BASE_URL_T, undefined, 'anything else in a foreign file does not');
    assert.equal(process.env.REVUTO_T_OWN, 'own', "revuto's own env file loads whole");
  } finally {
    process.env.HOME = savedHome;
    for (const k of keys) delete process.env[k];
    rmSync(home, { recursive: true, force: true });
  }
});

test('a Bedrock region must be a region name before it reaches an endpoint', () => {
  const config = { models: { review: http, curator: http, distill: http, embedder: null } } as never;
  const parsed = extractModelOverrideArgs(['--review-model', 'opus', '--bedrock-region', 'evil.example/x?']);
  assert.throws(() => applyModelOverrides(config, parsed), /invalid Bedrock region/);
  const ok = applyModelOverrides(config, extractModelOverrideArgs(['--review-model', 'opus', '--bedrock-region', 'us-west-2']));
  assert.match((ok as any).models.review.baseURL, /bedrock-runtime\.us-west-2\.amazonaws\.com/);
});

test('traces are private to the operator', () => {
  const vault = mkdtempSync(join(tmpdir(), 'revuto-trace-'));
  const saved = process.umask(0o002);
  try {
    const trace = startReviewTrace({ vaultPath: vault, repo: 'o/r', prNumber: 1, headSha: 'a'.repeat(40), model: 'm', startedAt: new Date() });
    trace.step('main', { text: 'x' });
    assert.ok(trace.path);
    assert.equal(statSync(trace.path!).mode & 0o777, 0o600);
    assert.equal(statSync(join(trace.path!, '..')).mode & 0o777, 0o700);
  } finally { process.umask(saved); rmSync(vault, { recursive: true, force: true }); }
});
