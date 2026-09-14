import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import type { ReviewerConfig } from './config.js';

export function reviewCachePath(config: ReviewerConfig, repo: string): string {
  return resolve(config.review.workspaceDir, '.review-cache', `${Buffer.from(repo).toString('base64url')}.git`);
}
const runsDir = (config: ReviewerConfig) => resolve(config.review.workspaceDir, '.review-runs');
export function killReviewChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  // A POSIX process group can outlive its leader. Escalation remains necessary
  // until stdio closes; callers clear their escalation timers on the close event.
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } else process.kill(-child.pid, signal);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export function reviewGit(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; discard?: boolean } = {}): Promise<string> {
  opts.signal?.throwIfAborted();
  return new Promise((resolveGit, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...opts.env };
    for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
    const child = spawn('git', args, { cwd: opts.cwd, detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', opts.discard ? 'ignore' : 'pipe', 'pipe'] });
    let output = '', errors = '', timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { killReviewChild(child); timeout = setTimeout(() => killReviewChild(child, 'SIGKILL'), 2000); };
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', s => { output += s; });
    child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (s: string) => { errors += s.slice(0, Math.max(0, 16000-errors.length)); });
    child.on('error', error => { opts.signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      opts.signal?.removeEventListener('abort', abort); if (timeout) clearTimeout(timeout);
      if (opts.signal?.aborted) reject(opts.signal.reason);
      else if (code !== 0) reject(new Error(`git ${args[0]} failed (${code}): ${errors}`));
      else resolveGit(output);
    });
    if (opts.signal?.aborted) abort();
  });
}

interface Owner { repo: string; pid: number; host: string; workspace: string; cache: string; }
async function removeOwned(config: ReviewerConfig, owner: Owner, manifest: string): Promise<void> {
  if (dirname(owner.workspace) !== runsDir(config) || owner.cache !== reviewCachePath(config, owner.repo)) throw new Error('Refusing an invalid review worktree manifest');
  if (existsSync(join(owner.cache, 'HEAD'))) {
    const registered = await reviewGit(['worktree', 'list', '--porcelain'], { cwd: owner.cache });
    if (registered.split('\n').includes(`worktree ${owner.workspace}`)) {
      await reviewGit(['worktree', 'remove', '--force', owner.workspace], { cwd: owner.cache });
    }
  }
  await rm(owner.workspace, { recursive: true, force: true });
  await rm(manifest, { force: true });
}

/** Only this namespace's dead-owner manifests are eligible for crash recovery. */
export async function reapReviewWorktrees(config: ReviewerConfig): Promise<number> {
  const dir = runsDir(config); if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const file of await readdir(dir)) {
    const incomplete = /^pr-\d+-(\d+)-[A-Za-z0-9]+$/.exec(file);
    if (incomplete && !existsSync(join(dir, `${file}.owner.json`))) {
      try { process.kill(Number(incomplete[1]), 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH' && (await readdir(join(dir,file))).length === 0) {
          await rm(join(dir,file), { recursive: true }); await rm(join(dir,`${file}.owner.json.tmp`), { force: true }); removed++;
        }
      }
      continue;
    }
    if (!file.endsWith('.owner.json')) continue;
    const manifest = join(dir, file); const owner: Owner = JSON.parse(await readFile(manifest, 'utf8'));
    if (owner.host !== hostname()) continue;
    try { process.kill(owner.pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    await removeOwned(config, owner, manifest); removed++;
  }
  return removed;
}

const active = new Set<{ controller: AbortController; done: Promise<void> }>();
let handlersInstalled = false;
let stopping = false;
function installShutdown(): void {
  if (handlersInstalled) return; handlersInstalled = true;
  for (const [signal, code] of [['SIGINT',130],['SIGTERM',143]] as const) {
    process.on(signal, () => {
      if (stopping) return; stopping = true;
      for (const entry of active) entry.controller.abort(new Error(`Review cancelled by ${signal}`));
      const forceExit = setTimeout(() => process.exit(code), 15000);
      Promise.allSettled([...active].map(e => e.done)).then(() => { clearTimeout(forceExit); process.exit(code); });
    });
  }
}

export async function withReviewWorktree<T>(config: ReviewerConfig, repo: string, pr: number,
  work: (workspace: string, cache: string, signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  if (stopping) throw new Error('Reviewer is shutting down');
  parentSignal?.throwIfAborted(); installShutdown();
  const controller = new AbortController(); const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abort, { once: true });
  let finish!: () => void; const entry = { controller, done: new Promise<void>(resolveDone => { finish = resolveDone; }) };
  active.add(entry);
  let owner: Owner | undefined, manifest = '';
  try {
    const dir = runsDir(config); await mkdir(dir, { recursive: true, mode: 0o700 });
    const workspace = await mkdtemp(join(dir, `pr-${pr}-${process.pid}-`)); manifest = `${workspace}.owner.json`;
    owner = { repo, pid: process.pid, host: hostname(), workspace, cache: reviewCachePath(config, repo) };
    await writeFile(`${manifest}.tmp`, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    await rename(`${manifest}.tmp`, manifest);
    if (parentSignal?.aborted) abort(); controller.signal.throwIfAborted();
    return await work(workspace, owner.cache, controller.signal);
  } finally {
    try { if (owner) { await removeOwned(config, owner, manifest); await rm(`${manifest}.tmp`, { force: true }); } }
    finally { parentSignal?.removeEventListener('abort', abort); active.delete(entry); finish(); }
  }
}
