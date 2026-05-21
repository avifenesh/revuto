/**
 * Config resolution smoke: a config with no `vaultPath` defaults the vault to the
 * config file's own folder (so it can live inside the vault), and unset limits/store
 * fall back to defaults.
 *
 *   npx tsx scripts/smoke/config.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../agents/common/src/config.js';

const dir = mkdtempSync(join(tmpdir(), 'revuto-cfg-'));
const m = { baseURL: 'http://x/v1', model: 'm' };
const file = join(dir, 'revuto.config.json');
writeFileSync(file, JSON.stringify({ github: { tokenEnv: 'GH_TOKEN' }, models: { review: m, curator: m, distill: m, embedder: null } }));

const c = loadConfig(file);
assert.equal(c.vaultPath, dir, 'vaultPath defaults to the config file folder');
assert.equal(c.store.backend, 'surreal', 'store backend defaults to surreal');
assert.ok(c.limits.maxOutputTokens.review > 0, 'review token cap default applied');
assert.equal(c.limits.dailyTokens, 0, 'unset limits default to 0 (unlimited)');
assert.equal(c.github.tokenEnv, 'GH_TOKEN', 'github token env read');

console.log('PASS: config-in-vault (vaultPath defaults to config folder) + limit/store defaults');
