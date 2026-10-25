/**
 * The native reviewers' sandbox layout: what Claude Code's settings deny, how a
 * worktree's git directories are found, and that the skills copy brings no links.
 * The live behavior is checked by scripts/smoke/native-sandbox.ts.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkoutGitDir, claudeReviewSettings, copySkills } from '../agents/common/src/native-sandbox.js';

test('a worktree pointer resolves to its gitdir and the shared cache, both write-denied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revuto-native-sandbox-'));
  try {
    const src = join(root, 'src');
    execFileSync('git', ['init', '-q', '-b', 'main', src]);
    execFileSync('git', ['-C', src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    const cache = join(root, 'cache');
    execFileSync('git', ['clone', '-q', '--bare', src, cache]);
    const checkout = join(root, 'checkout');
    execFileSync('git', ['-C', cache, 'worktree', 'add', '-q', '--detach', checkout, 'HEAD']);
    const git = await checkoutGitDir(checkout);
    assert.equal(git?.gitDir, join(cache, 'worktrees', 'checkout'));
    assert.equal(git?.commonDir, cache);

    const settings = claudeReviewSettings({ checkout, ...git }) as {
      permissions: { deny: string[]; blockReadsOutsideWorkingDirectories: boolean };
      sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean;
        filesystem: { denyWrite: string[]; allowRead: string[]; denyRead: string[] };
        network: { allowedDomains: string[] }; credentials: { envVars: Array<{ name: string; mode: string }> } };
    };
    for (const path of [join(checkout, '.git'), git!.gitDir, cache]) {
      assert.ok(settings.sandbox.filesystem.denyWrite.includes(path), `sandbox denies writes to ${path}`);
      assert.ok(settings.permissions.deny.includes(`Write(/${path})`) && settings.permissions.deny.includes(`Edit(/${path}/**)`), `tools deny writes to ${path}`);
    }
    assert.deepEqual(settings.sandbox.filesystem.allowRead.sort(), [cache, git!.gitDir].sort(), 'git can read history');
    assert.ok(settings.permissions.blockReadsOutsideWorkingDirectories);
    assert.equal(settings.sandbox.enabled && settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(settings.sandbox.network.allowedDomains, []);
    assert.ok(settings.sandbox.filesystem.denyRead.includes('/run/user'), 'the session bus is hidden');
    assert.ok(settings.sandbox.credentials.envVars.every((v) => v.mode === 'deny'));
    assert.ok(settings.sandbox.credentials.envVars.some((v) => v.name === 'AWS_BEARER_TOKEN_BEDROCK'));

    const plain = await checkoutGitDir(src);
    assert.deepEqual(plain, { gitDir: join(src, '.git'), commonDir: join(src, '.git') });
    assert.equal(await checkoutGitDir(root), undefined, 'a directory without git has none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the skills copy keeps files and skips links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revuto-native-skills-'));
  try {
    const from = join(root, 'skills');
    mkdirSync(join(from, '_history'), { recursive: true });
    writeFileSync(join(from, 'locks.md'), 'skill');
    writeFileSync(join(from, '_history', 'old.md'), 'old');
    writeFileSync(join(root, 'secret.txt'), 'secret');
    symlinkSync(join(root, 'secret.txt'), join(from, 'link.md'));
    const to = join(root, 'copy');
    await copySkills(from, to);
    assert.equal(readFileSync(join(to, 'locks.md'), 'utf8'), 'skill');
    assert.ok(existsSync(join(to, '_history', 'old.md')));
    assert.equal(existsSync(join(to, 'link.md')), false, 'a link out of the vault is not copied');
    await copySkills(join(root, 'missing'), join(root, 'none'));
    assert.equal(existsSync(join(root, 'none')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
