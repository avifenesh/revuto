/**
 * Config resolution smoke:
 *  - a config with no `vaultPath` defaults the vault to the config file's own folder;
 *  - $REVUTO_VAULT (default ~/revuto) is the default vault, and a config dropped there
 *    is found with no explicit path / no cwd config;
 *  - unset limits/store fall back to defaults.
 *
 *   npx tsx scripts/smoke/config.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, defaultVaultPath } from '../../agents/common/src/config.js';

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

// Vault is the default config home: point $REVUTO_VAULT at a temp dir, drop a config
// there, and confirm loadConfig() (no path arg) finds it from a cwd with no local config.
const vault = mkdtempSync(join(tmpdir(), 'revuto-vault-'));
process.env.REVUTO_VAULT = vault;
delete process.env.REVUTO_CONFIG;
delete process.env.REVIEWER_CONFIG;
assert.equal(defaultVaultPath(), vault, 'defaultVaultPath honors $REVUTO_VAULT');
writeFileSync(join(vault, 'revuto.config.json'), JSON.stringify({ github: { tokenEnv: 'GH_TOKEN' }, models: { review: m, curator: m, distill: m, embedder: null } }));
process.chdir(mkdtempSync(join(tmpdir(), 'revuto-cwd-'))); // no ./revuto.config.json here
const v = loadConfig();
assert.equal(v.vaultPath, vault, 'config found in $REVUTO_VAULT with no path arg; vaultPath self-locates to the vault');

console.log('PASS: config-in-vault default (vaultPath self-locates, $REVUTO_VAULT is the default home) + limit/store defaults');
