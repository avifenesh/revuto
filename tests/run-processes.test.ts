/**
 * No process a review run starts outlives the run. A native CLI can start a
 * command in a new session (Codex's sandbox helper does), which leaves the
 * process group revuto spawned the CLI in; a group kill misses it. On Linux with
 * a systemd user manager every native CLI runs in its own scope (a cgroup), so
 * the whole tree ends with the run on every exit path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelSpec, ReviewerConfig } from '../agents/common/src/config.js';
import { runAgyCli } from '../agents/common/src/agy-review.js';
import { reviewGit } from '../agents/common/src/review-worktree.js';
import { ownUserUnit } from '../agents/common/src/process-scope.js';

/** Whether this host can put a process in a systemd user scope, probed without revuto's code. */
const scopes = process.platform === 'linux'
  && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore' }).status === 0;
const NO_SCOPES = 'no systemd user manager here: a process that starts its own session can outlive the run (the documented process-group fallback)';

/**
 * A fake native CLI for all three runners. It starts one descendant that ignores
 * SIGTERM, in a new session (`setsid`) or in its own process group, records it,
 * then finishes its turn, or hangs when the prompt says so.
 */
function fakeCli(dir: string): string {
  const command = join(dir, 'cli-fake.mjs');
  // Laid out like the Codex npm package, whose directory the Codex sandbox must read.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  writeFileSync(command, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.argv[1] + '.cli', String(process.pid));
if (args[0] === 'debug' && args[1] === 'models') { console.log(JSON.stringify({ models: [{ slug: 'm' }] })); process.exit(0); }
const runner = args[0] === 'exec' ? 'codex' : args.includes('--setting-sources') ? 'claude' : 'agy';
const prompt = runner === 'agy' ? args[args.indexOf('-p') + 1] : readFileSync(0, 'utf8');
const sameGroup = prompt.includes('same-group');
// The descendant records its pid and session id once it ignores SIGTERM, so a reap must escalate to SIGKILL.
const marker = process.argv[1] + '.pids';
const keep = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});const sid=Number(require('fs').readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[3]);require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,sid]));setInterval(()=>{},1000)", marker], { detached: !sameGroup, stdio: 'ignore' });
keep.unref();
for (let i = 0; !existsSync(marker) && i < 250; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
if (prompt.includes('hang')) setInterval(() => {}, 1000);
else {
  const verdict = { decision: 'skip_review', reason: 'no concerns', body: '', comments: [] };
  if (runner === 'agy') console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', structured_output: verdict, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
  if (runner === 'claude') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', structured_output: verdict, usage: { input_tokens: 1, output_tokens: 1 } }));
  if (runner === 'codex') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 't' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(verdict) } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  }
}
`);
  chmodSync(command, 0o755);
  return command;
}

const specs = (command: string): Record<'agy' | 'claude' | 'codex', ModelSpec> => ({
  agy: { api: 'agy', baseURL: 'agy://local', model: 'fake', command },
  claude: { api: 'claude', baseURL: 'claude-cli://local', auth: 'none', model: 'fake', command },
  codex: { api: 'codex', baseURL: 'codex://bedrock', model: 'fake', command },
});

const running = (pid: number) => {
  const stat = `/proc/${pid}/stat`;
  try { return readFileSync(stat, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return false; }
};

/** The descendant the fake recorded, after checking which session it runs in. */
async function recorded(command: string, ownSession = true): Promise<number[]> {
  const marker = `${command}.pids`;
  for (let i = 0; !existsSync(marker) && i < 250; i++) await delay(20);
  assert.ok(existsSync(marker), 'the fake CLI started its descendant');
  const [pid, sid] = JSON.parse(readFileSync(marker, 'utf8')) as [number, number];
  if (ownSession) assert.equal(sid, pid, 'the descendant leads a session of its own, outside the CLI process group');
  else assert.notEqual(sid, pid);
  return [pid];
}

/** Bounded: the reap may land a moment after the run settles, never minutes. */
async function assertGone(pids: number[]): Promise<void> {
  for (let i = 0; pids.some(running) && i < 150; i++) await delay(20);
  for (const pid of pids) assert.equal(running(pid), false, `descendant ${pid} outlived the run`);
}

/** Whatever the test's outcome, the fake CLI and its descendant end here. */
function cleanup(command: string, dir: string): void {
  const read = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return undefined; } };
  const pids = [read(`${command}.cli`), (read(`${command}.pids`) as number[] | undefined)?.[0]].filter((p): p is number => typeof p === 'number');
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
}

for (const runner of ['agy', 'claude', 'codex'] as const) {
  test(`${runner}: a descendant in its own session ends when the run finishes`, { skip: !scopes && NO_SCOPES }, async () => {
    const dir = mkdtempSync(join(tmpdir(), `revuto-reap-${runner}-`));
    const command = fakeCli(dir);
    try {
      const run = await runAgyCli({ spec: specs(command)[runner], cwd: dir, prompt: 'review' });
      assert.equal(run.result.status, 'SUCCESS');
      await assertGone(await recorded(command));
    } finally { cleanup(command, dir); }
  });
}

test('a descendant left in the CLI process group ends when the run finishes', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-reap-group-'));
  const command = fakeCli(dir);
  try {
    await runAgyCli({ spec: specs(command).agy, cwd: dir, prompt: 'review same-group' });
    await assertGone(await recorded(command, false));
  } finally { cleanup(command, dir); }
});

test('a cancelled run ends a descendant in its own session', { skip: !scopes && NO_SCOPES }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-reap-abort-'));
  const command = fakeCli(dir);
  const abort = new AbortController();
  const pending = runAgyCli({ spec: specs(command).agy, cwd: dir, prompt: 'hang', signal: abort.signal });
  try {
    const pids = await recorded(command);
    abort.abort(new Error('cancelled review'));
    await assert.rejects(pending, /cancelled review/);
    await assertGone(pids);
  } finally {
    abort.abort();
    await pending.catch(() => {});
    cleanup(command, dir);
  }
});

test('a timed-out run ends a descendant in its own session', { skip: !scopes && NO_SCOPES }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-reap-timeout-'));
  const command = fakeCli(dir);
  const pending = runAgyCli({ spec: specs(command).codex, cwd: dir, prompt: 'hang', timeoutMs: 1500 });
  try {
    const pids = await recorded(command);
    await assert.rejects(pending, /timed out/);
    await assertGone(pids);
  } finally {
    await pending.catch(() => {});
    cleanup(command, dir);
  }
});

test('daemon shutdown ends a running review and its descendant in its own session', { skip: !scopes && NO_SCOPES }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-reap-shutdown-'));
  const command = fakeCli(dir);
  const cfg = { vaultPath: dir, review: { workspaceDir: join(dir, 'workspaces'), maxConcurrent: 1, maxConcurrentPerRepo: 1 } } as ReviewerConfig;
  const worker = join(dir, 'worker.mjs');
  writeFileSync(worker, `import {withReviewWorktree} from ${JSON.stringify(new URL('../agents/common/src/review-worktree.ts', import.meta.url).href)};
import {runAgyCli} from ${JSON.stringify(new URL('../agents/common/src/agy-review.ts', import.meta.url).href)};
await withReviewWorktree(JSON.parse(process.env.TEST_CONFIG),'a/repo',7,(path,cache,signal)=>runAgyCli({spec:JSON.parse(process.env.TEST_SPEC),cwd:process.env.TEST_DIR,prompt:'hang',signal}));`);
  const child = spawn(process.execPath, ['--import', 'tsx', worker], { cwd: process.cwd(), stdio: 'ignore',
    env: { ...process.env, TEST_CONFIG: JSON.stringify(cfg), TEST_SPEC: JSON.stringify(specs(command).agy), TEST_DIR: dir } });
  try {
    const exited = new Promise<void>((resolveExit, reject) => { child.on('exit', () => resolveExit()); child.on('error', reject); });
    const pids = await recorded(command);
    child.kill('SIGTERM');
    await Promise.race([exited, delay(20000).then(() => { throw new Error('the daemon did not exit on SIGTERM'); })]);
    await assertGone(pids);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    cleanup(command, dir);
  }
});

test('review git never detaches automatic maintenance into a session of its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-reap-git-'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    // `git gc --auto` (run by fetch) daemonizes with setsid unless told not to.
    assert.equal((await reviewGit(['config', '--get', 'gc.autoDetach'], { cwd: dir })).trim(), 'false');
    assert.equal((await reviewGit(['config', '--get', 'maintenance.autoDetach'], { cwd: dir })).trim(), 'false');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scopes bind to the user-manager unit revuto runs in, and to nothing else', () => {
  const at = (path: string) => `0::${path}\n`;
  assert.equal(ownUserUnit(at('/user.slice/user-1000.slice/user@1000.service/app.slice/revuto.service'), 1000), 'revuto.service');
  assert.equal(ownUserUnit(at('/user.slice/user-1000.slice/user@1000.service/app.slice/app-kitty-42.scope'), 1000), 'app-kitty-42.scope');
  // A delegated subtree below a unit still binds to the unit.
  assert.equal(ownUserUnit(at('/user.slice/user-1000.slice/user@1000.service/app.slice/revuto.service/payload'), 1000), 'revuto.service');
  // The system manager's units and another user's manager are not this user manager's.
  assert.equal(ownUserUnit(at('/system.slice/revuto.service'), 1000), undefined);
  assert.equal(ownUserUnit(at('/user.slice/user-1000.slice/session-3.scope'), 1000), undefined);
  assert.equal(ownUserUnit(at('/user.slice/user-1001.slice/user@1001.service/app.slice/revuto.service'), 1000), undefined);
  assert.equal(ownUserUnit(at('/user.slice/user-1000.slice/user@1000.service/app.slice/revuto.service'), undefined), undefined);
});
