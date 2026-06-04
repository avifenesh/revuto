import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { ReviewerConfig } from '../../agents/common/src/config.js';

const repoQueues = new Map<string, Promise<unknown>>();
const DEFAULT_POLL_MS = 250;
const ORPHAN_LOCK_MS = 30_000;

export interface RepoQueueOptions {
  readonly pollMs?: number;
}

interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly repo: string;
  readonly createdAt: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function repoLockName(repo: string): string {
  return `${Buffer.from(repo, 'utf8').toString('base64url') || 'repo'}.lock`;
}

function repoLockDir(config: ReviewerConfig, repo: string): string {
  return join(config.vaultPath, '.locks', 'repos', repoLockName(repo));
}

function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EPERM';
  }
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(join(lockDir, 'owner.json'), 'utf8');
    const owner = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof owner.pid !== 'number' || typeof owner.hostname !== 'string') return null;
    return {
      pid: owner.pid,
      hostname: owner.hostname,
      repo: typeof owner.repo === 'string' ? owner.repo : '',
      createdAt: typeof owner.createdAt === 'string' ? owner.createdAt : '',
    };
  } catch {
    return null;
  }
}

async function removeStaleLock(lockDir: string): Promise<boolean> {
  const owner = await readOwner(lockDir);
  if (owner?.hostname === hostname() && !isProcessAlive(owner.pid)) {
    await rm(lockDir, { recursive: true, force: true });
    return true;
  }

  if (!owner) {
    try {
      const ageMs = Date.now() - (await stat(lockDir)).mtimeMs;
      if (ageMs >= ORPHAN_LOCK_MS) {
        await rm(lockDir, { recursive: true, force: true });
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

async function withRepoLock<T>(
  config: ReviewerConfig,
  repo: string,
  fn: () => Promise<T> | T,
  options: RepoQueueOptions,
): Promise<T> {
  const lockDir = repoLockDir(config, repo);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  for (;;) {
    try {
      await mkdir(join(config.vaultPath, '.locks', 'repos'), { recursive: true });
      await mkdir(lockDir);

      try {
        await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          repo,
          createdAt: new Date().toISOString(),
        }, null, 2) + '\n');
        return await fn();
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      if (await removeStaleLock(lockDir)) continue;
      await delay(pollMs);
    }
  }
}

export async function runQueuedForRepo<T>(
  config: ReviewerConfig,
  repo: string,
  fn: () => Promise<T> | T,
  options: RepoQueueOptions = {},
): Promise<T> {
  const key = repoLockDir(config, repo);
  const previous = repoQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => withRepoLock(config, repo, fn, options));
  repoQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (repoQueues.get(key) === current) repoQueues.delete(key);
  }
}
