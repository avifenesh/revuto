import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { runQueuedForRepo } from './repo-queue.js';

interface Ticket { id: string; repo: string; pr: number; pid: number; host: string; queued: number; running: boolean; }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** One short cross-process dispatch lock; no repository lock spans a model run. */
export async function runQueuedReview<T>(config: ReviewerConfig, repo: string, pr: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const dir = join(config.vaultPath, '.locks', 'reviews');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ticket: Ticket = { id: randomUUID(), repo, pr, pid: process.pid, host: hostname(), queued: Date.now(), running: false };
  const file = join(dir, `${ticket.id}.json`);
  const dispatch = <R>(work: () => Promise<R>) => runQueuedForRepo(config, '_review-dispatch', work);
  const save = async (t: Ticket) => {
    const path = join(dir, `${t.id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(t), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  try {
    await dispatch(() => save(ticket));
    for (;;) {
      signal?.throwIfAborted();
      const admitted = await dispatch(async () => {
        const tickets: Ticket[] = [];
        for (const name of await readdir(dir)) {
          if (!name.endsWith('.json')) continue;
          const t: Ticket = JSON.parse(await readFile(join(dir, name), 'utf8'));
          if (t.host === hostname() && !alive(t.pid)) { await rm(join(dir, name), { force: true }); continue; }
          tickets.push(t);
        }
        const running = tickets.filter(t => t.running);
        // Admit the earliest eligible tickets, without letting a busy repo block others.
        for (const t of tickets.filter(t => !t.running).sort((a, b) => a.queued - b.queued || a.id.localeCompare(b.id))) {
          if (running.length >= (config.review.maxConcurrent ?? 4)) break;
          const sameRepo = running.filter(r => r.repo === t.repo);
          if (sameRepo.length >= (config.review.maxConcurrentPerRepo ?? 2) || sameRepo.some(r => r.pr === t.pr)) continue;
          t.running = true; await save(t); running.push(t);
        }
        return running.some(t => t.id === ticket.id);
      });
      if (admitted) break;
      await delay(100, undefined, { signal });
    }
    signal?.throwIfAborted();
    return await fn();
  } finally {
    await dispatch(async () => { await rm(file, { force: true }); await rm(`${file}.tmp`, { force: true }); });
  }
}
