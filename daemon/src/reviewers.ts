/**
 * Reviewer registry — the "skill of the reviewer". One markdown note per
 * registered repo in the vault (<vault>/reviewers/<owner>__<repo>.md) carries
 * that repo's schedule overrides, author allowlist, auto-activate flag, and the
 * GitHub login the reviewer posts as (for feedback attribution). Replaces the
 * old CDK `routes[]` array.
 */
import matter from 'gray-matter';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewerConfig } from '../../agents/common/src/config.js';

export interface ReviewerSettings {
  readonly repo: string;
  readonly schedules?: Partial<{ review: string; learn: string; decay: string }>;
  /** Only review PRs by these authors. Empty/undefined = review all (non-bot). */
  readonly authorAllowlist?: string[];
  /** Activate graduated skills immediately instead of leaving them draft for human approval. */
  readonly autoActivate?: boolean;
  /** The GitHub login the reviewer posts as; defaults to the token's own user. */
  readonly botLogin?: string;
  /** When true, the scheduler skips this repo's jobs (applied on daemon (re)start). */
  readonly paused?: boolean;
}

function reviewersDir(config: ReviewerConfig): string {
  return join(config.vaultPath, 'reviewers');
}

function noteName(repo: string): string {
  const [owner, name] = repo.split('/');
  return `${owner}__${name}.md`;
}

function parseNote(raw: string): ReviewerSettings | null {
  const d = matter(raw).data as Record<string, unknown>;
  if (!d.repo) return null;
  return {
    repo: String(d.repo),
    schedules: (d.schedules as ReviewerSettings['schedules']) ?? {},
    authorAllowlist: Array.isArray(d.authorAllowlist) ? d.authorAllowlist.map(String) : [],
    autoActivate: !!d.autoActivate,
    botLogin: d.botLogin ? String(d.botLogin) : undefined,
    paused: !!d.paused,
  };
}

export function listReviewers(config: ReviewerConfig): ReviewerSettings[] {
  const dir = reviewersDir(config);
  if (!existsSync(dir)) return [];
  const out: ReviewerSettings[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const s = parseNote(readFileSync(join(dir, f), 'utf8'));
    if (s) out.push(s);
  }
  return out;
}

export function readReviewer(config: ReviewerConfig, repo: string): ReviewerSettings | null {
  const p = join(reviewersDir(config), noteName(repo));
  return existsSync(p) ? parseNote(readFileSync(p, 'utf8')) : null;
}

export function writeReviewer(config: ReviewerConfig, s: ReviewerSettings): void {
  const dir = reviewersDir(config);
  mkdirSync(dir, { recursive: true });
  const data: Record<string, unknown> = {
    repo: s.repo,
    schedules: s.schedules ?? {},
    authorAllowlist: s.authorAllowlist ?? [],
    autoActivate: s.autoActivate ?? false,
    paused: s.paused ?? false,
  };
  if (s.botLogin) data.botLogin = s.botLogin;
  const [owner, name] = s.repo.split('/');
  const body = `# ${s.repo}\n\nRegistered reviewer. Skills live under \`skills/${owner}__${name}/\`; memory in \`memory/${owner}__${name}\` (SQLite or SurrealDB).\n`;
  writeFileSync(join(dir, noteName(s.repo)), matter.stringify(body, data), 'utf8');
  updateIndex(config);
}

/** Maintain a viewable Obsidian index note listing every registered repo. */
export function updateIndex(config: ReviewerConfig): void {
  const dir = reviewersDir(config);
  mkdirSync(dir, { recursive: true });
  const rs = listReviewers(config).sort((a, b) => a.repo.localeCompare(b.repo));
  const lines = ['# Reviewers', '', `${rs.length} repo(s) registered.`, '', '| Repo | paused | auto-activate | author allowlist |', '|---|---|---|---|'];
  for (const r of rs) {
    const [owner, name] = r.repo.split('/');
    const allow = r.authorAllowlist?.length ? r.authorAllowlist.join(', ') : '(all)';
    lines.push(`| [[${owner}__${name}\\|${r.repo}]] | ${r.paused ? 'yes' : 'no'} | ${r.autoActivate ? 'yes' : 'no'} | ${allow} |`);
  }
  writeFileSync(join(dir, '_index.md'), lines.join('\n') + '\n', 'utf8');
}

/** Unregister a repo. With `purge`, also deletes its skill notes + SQLite memory file. */
export function removeReviewer(config: ReviewerConfig, repo: string, opts: { purge?: boolean } = {}): boolean {
  const p = join(reviewersDir(config), noteName(repo));
  if (!existsSync(p)) return false;
  rmSync(p);
  if (opts.purge) {
    const [owner, name] = repo.split('/');
    const slug = `${owner}__${name}`;
    rmSync(join(config.vaultPath, 'skills', slug), { recursive: true, force: true });
    for (const ext of ['.sqlite', '.sqlite-wal', '.sqlite-shm']) {
      rmSync(join(config.vaultPath, 'memory', `${slug}${ext}`), { force: true });
    }
    // SurrealDB memory lives in the server's per-repo database; drop it there if using surreal.
  }
  updateIndex(config);
  return true;
}

/** Pause/resume a repo's scheduled jobs. Takes effect on daemon (re)start. */
export function setPaused(config: ReviewerConfig, repo: string, paused: boolean): boolean {
  const s = readReviewer(config, repo);
  if (!s) return false;
  writeReviewer(config, { ...s, paused });
  return true;
}

/** Set (expr) or clear (null) a per-repo cron override for one job. */
export function setSchedule(config: ReviewerConfig, repo: string, job: 'review' | 'learn' | 'decay', expr: string | null): boolean {
  const s = readReviewer(config, repo);
  if (!s) return false;
  const schedules: Record<string, string> = { ...(s.schedules ?? {}) };
  if (expr) schedules[job] = expr; else delete schedules[job];
  writeReviewer(config, { ...s, schedules });
  return true;
}

export function effectiveSchedules(
  config: ReviewerConfig,
  s: ReviewerSettings,
): { review: string; learn: string; decay: string } {
  return {
    review: s.schedules?.review ?? config.schedules.review,
    learn: s.schedules?.learn ?? config.schedules.learn,
    decay: s.schedules?.decay ?? config.schedules.decay,
  };
}
