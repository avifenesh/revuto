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
import { applyModelOverrides, extractModelOverrideArgs, modelPreset } from '../../daemon/src/model-overrides.js';

const dir = mkdtempSync(join(tmpdir(), 'revuto-cfg-'));
const m = { baseURL: 'http://x/v1', model: 'm' };
const responses = { ...m, api: 'responses', auth: 'auto', reasoningEffort: 'xhigh', awsRegion: 'us-east-2' };
const file = join(dir, 'revuto.config.json');
writeFileSync(file, JSON.stringify({ github: { tokenEnv: 'GH_TOKEN' }, models: { review: { ...responses, fallbacks: [m] }, curator: m, distill: m, embedder: null } }));

const c = loadConfig(file);
assert.equal(c.vaultPath, dir, 'vaultPath defaults to the config file folder');
assert.equal(c.models.review.api, 'responses', 'responses API config survives load');
assert.equal(c.models.review.auth, 'auto', 'auth mode config survives load');
assert.equal(c.models.review.reasoningEffort, 'xhigh', 'reasoning effort config survives load');
assert.equal(c.models.review.awsRegion, 'us-east-2', 'AWS region config survives load');
assert.equal(c.models.review.fallbacks?.[0]?.model, 'm', 'fallback model config survives load');
assert.equal(c.store.backend, 'surreal', 'store backend defaults to surreal');
assert.ok(c.limits.maxOutputTokens.review > 0, 'review token cap default applied');
assert.equal(c.limits.dailyTokens, 0, 'unset limits default to 0 (unlimited)');
assert.equal(c.github.tokenEnv, 'GH_TOKEN', 'github token env read');

const gpt = modelPreset('us.openai-gpt-5-5');
assert.equal(gpt.baseURL, 'https://bedrock-mantle.us-east-2.api.aws/openai/v1', 'gpt55 alias uses Bedrock Mantle OpenAI path');
assert.equal(gpt.model, 'openai.gpt-5.5', 'gpt55 alias normalizes to the documented OpenAI model id');
assert.equal(gpt.api, 'responses', 'gpt55 alias uses Responses');
const sonnet = modelPreset('sonnet@us-east-2');
assert.equal(sonnet.baseURL, 'https://bedrock-runtime.us-east-2.amazonaws.com', 'sonnet alias uses Bedrock Runtime');
assert.equal(sonnet.model, 'global.anthropic.claude-sonnet-5', 'sonnet alias uses the global Sonnet 5 inference id');
assert.equal(sonnet.api, 'converse', 'sonnet alias uses Converse');

const overrides = extractModelOverrideArgs(['--bedrock-region', 'us-east-2', 'daemon', '--review-model', 'gpt55,opus', '--model=curator=opus,sonnet', '--distill-model=opus@us-west-2,sonnet@us-east-2']);
assert.deepEqual(overrides.args, ['daemon'], 'model override flags are stripped from argv');
const overridden = applyModelOverrides(c, overrides);
assert.equal(overridden.models.review.model, 'openai.gpt-5.5', 'review override sets primary');
assert.equal(overridden.models.review.fallbacks?.[0]?.model, 'us.anthropic.claude-opus-4-8', 'review override sets Opus fallback');
assert.equal(overridden.models.curator.fallbacks?.[0]?.model, 'global.anthropic.claude-sonnet-5', 'curator override sets Sonnet fallback');
assert.equal(overridden.models.distill.awsRegion, 'us-west-2', 'entry @region overrides the default region');
assert.equal(overridden.models.distill.fallbacks?.[0]?.awsRegion, 'us-east-2', 'fallback entry @region can differ from primary');

const badFile = join(dir, 'bad-revuto.config.json');
writeFileSync(badFile, JSON.stringify({ github: { tokenEnv: 'GH_TOKEN' }, models: { review: { ...m, api: 'response' }, curator: m, distill: m, embedder: null } }));
assert.throws(() => loadConfig(badFile), /models\.review\.api must be one of chat, responses/, 'invalid model api fails fast');

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

console.log('PASS: config-in-vault default + responses/fallback model options + model override aliases + invalid-api validation + limit/store defaults');
