/**
 * CLI list smoke:
 *  - `revuto list --json` emits the reviewer array shape consumed by Eigen's
 *    working-station Revuto connector;
 *  - plain `revuto list` keeps the existing human-readable line format.
 *
 *   npx tsx scripts/smoke/cli-list.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../agents/common/src/config.js';
import { writeReviewer } from '../../daemon/src/reviewers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vault = mkdtempSync(join(tmpdir(), 'revuto-cli-list-'));
const m = { baseURL: 'http://x/v1', model: 'm' };
const configFile = join(vault, 'revuto.config.json');

writeFileSync(configFile, JSON.stringify({
  vaultPath: vault,
  github: { tokenEnv: 'GH_TOKEN' },
  models: { review: m, curator: m, distill: m, embedder: null },
}));

const config = loadConfig(configFile);
writeReviewer(config, {
  repo: 'octo/alpha',
  paused: true,
  autoActivate: true,
  botLogin: 'reviewer-bot',
  schedules: { review: '*/5 * * * *' },
  authorAllowlist: ['alice', 'bob'],
});
writeReviewer(config, { repo: 'octo/beta' });

function revutoList(args: string[]): string {
  const proc = spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'daemon/src/cli.ts'), 'list', ...args], {
    cwd: repoRoot,
    env: { ...process.env, REVUTO_CONFIG: configFile, REVUTO_VAULT: vault },
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

const json = JSON.parse(revutoList(['--json'])).sort((a: { repo: string }, b: { repo: string }) => a.repo.localeCompare(b.repo));
assert.deepEqual(json, [
  {
    repo: 'octo/alpha',
    schedules: { review: '*/5 * * * *' },
    authorAllowlist: ['alice', 'bob'],
    autoActivate: true,
    botLogin: 'reviewer-bot',
    paused: true,
  },
  {
    repo: 'octo/beta',
    schedules: {},
    authorAllowlist: [],
    autoActivate: false,
    paused: false,
  },
], 'JSON list shape stays compatible with Eigen internal/revuto.Reviewer');

const humanLines = revutoList([]).split('\n').sort();
assert.deepEqual(humanLines, [
  'octo/alpha  PAUSED  schedules={"review":"*/5 * * * *"}  allowlist=alice,bob  autoActivate=true',
  'octo/beta  schedules={}  allowlist=(all)  autoActivate=false',
].sort(), 'plain list output stays human-readable and unchanged');

console.log('PASS: CLI list --json shape + default human output');
