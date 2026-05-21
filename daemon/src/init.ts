/**
 * `revuto init <owner/repo>` — stand up a reviewer for a new repo:
 *   1. clone the repo (read-only working copy),
 *   2. onboard: scan structure (deterministic) for a factual overview,
 *   3. backfill up to N past PRs' review feedback via GraphQL,
 *   4. distill the maintainer-essence points an LLM extracts from that feedback,
 *   5. compose the repo's reviewer "textbook" (_textbook.md) and write it to the vault,
 *   6. register the reviewer note so the scheduler picks it up.
 *
 * Topic skills are NOT seeded here — they accrue from the learn loop as feedback
 * repeats and graduates. Init produces the curated textbook only.
 */
import { generateText } from 'ai';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { getOctokit } from '../../agents/common/src/github-auth.js';
import { cloneRepo } from '../../agents/common/src/workspace.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { buildChatModel } from '../../agents/common/src/model.js';
import { engineRoot } from '../../agents/common/src/engine-root.js';
import { classifyCommentBody } from '../../agents/common/src/heuristics.js';
import { writeReviewer } from './reviewers.js';

// ---------------------------------------------------------------------------
// 2. deterministic repo scan
// ---------------------------------------------------------------------------

export interface RepoFacts {
  readonly topDirs: string[];
  readonly languages: Array<{ ext: string; count: number }>;
  readonly buildFiles: string[];
  readonly readmeExcerpt: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', '.cache', 'vendor']);
const BUILD_FILES = ['Makefile', 'CMakeLists.txt', 'Cargo.toml', 'package.json', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'BUILD.bazel'];

export function scanRepo(dir: string): RepoFacts {
  const topDirs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  const extCounts = new Map<string, number>();
  let budget = 20_000; // cap files walked
  const walk = (d: string): void => {
    if (budget <= 0) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (budget <= 0) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(join(d, e.name));
      } else {
        budget--;
        const dot = e.name.lastIndexOf('.');
        if (dot > 0) {
          const ext = e.name.slice(dot).toLowerCase();
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
      }
    }
  };
  walk(dir);

  const languages = [...extCounts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const buildFiles = BUILD_FILES.filter((f) => existsSync(join(dir, f)));

  let readmeExcerpt = '';
  for (const r of ['README.md', 'README.rst', 'README.txt', 'README']) {
    const p = join(dir, r);
    if (existsSync(p) && statSync(p).isFile()) { readmeExcerpt = readFileSync(p, 'utf8').slice(0, 4000); break; }
  }

  return { topDirs, languages, buildFiles, readmeExcerpt };
}

// ---------------------------------------------------------------------------
// 3. PR-history backfill (GraphQL)
// ---------------------------------------------------------------------------

export interface CorpusComment { readonly author: string; readonly body: string; readonly path?: string; }
export interface CorpusItem { readonly pr: number; readonly title: string; readonly comments: CorpusComment[]; }

interface GqlResponse {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        number: number; title: string;
        reviews: { nodes: Array<{ author: { login: string } | null; body: string; comments: { nodes: Array<{ author: { login: string } | null; body: string; path: string | null }> } }> };
        comments: { nodes: Array<{ author: { login: string } | null; body: string }> };
      }>;
    };
  };
}

const BACKFILL_QUERY = `
query($owner:String!, $name:String!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:25, states:[MERGED], orderBy:{field:UPDATED_AT, direction:DESC}, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title
        reviews(first:30) { nodes { author { login } body comments(first:30) { nodes { author { login } body path } } } }
        comments(first:30) { nodes { author { login } body } }
      }
    }
  }
}`;

/** Pull up to `maxPRs` merged PRs' human review feedback, noise-filtered. */
export async function backfillReviewCorpus(
  octokit: ReturnType<typeof getOctokit>['octokit'],
  repo: string,
  maxPRs: number,
  excludeLogin?: string,
): Promise<CorpusItem[]> {
  const [owner, name] = repo.split('/');
  const out: CorpusItem[] = [];
  let cursor: string | null = null;

  while (out.length < maxPRs) {
    let resp: GqlResponse;
    try {
      resp = await octokit.graphql<GqlResponse>(BACKFILL_QUERY, { owner, name, cursor });
    } catch (err) {
      // one retry on secondary-rate-limit / transient error, then stop
      await new Promise((r) => setTimeout(r, 2000));
      try { resp = await octokit.graphql<GqlResponse>(BACKFILL_QUERY, { owner, name, cursor }); }
      catch { break; }
    }

    const page = resp.repository?.pullRequests;
    if (!page) break;
    for (const pr of page.nodes) {
      const comments: CorpusComment[] = [];
      const consider = (author: string | undefined, body: string, path?: string): void => {
        if (!body?.trim()) return;
        if (author && excludeLogin && author === excludeLogin) return;
        if (classifyCommentBody(body).noise) return;
        comments.push({ author: author ?? '', body: body.trim(), path });
      };
      for (const rev of pr.reviews.nodes) {
        consider(rev.author?.login, rev.body);
        for (const c of rev.comments.nodes) consider(c.author?.login, c.body, c.path ?? undefined);
      }
      for (const c of pr.comments.nodes) consider(c.author?.login, c.body);
      if (comments.length) out.push({ pr: pr.number, title: pr.title, comments });
      if (out.length >= maxPRs) break;
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4 + 5. distill + compose textbook (LLM)
// ---------------------------------------------------------------------------

const DISTILL_SYSTEM = `You are a senior maintainer distilling institutional knowledge from past PR review comments. From the feedback below, extract the durable, repo-specific points a maintainer who knows the history applies when reviewing new PRs: recurring correctness concerns, intentional design decisions and carve-outs, subsystem invariants, and conventions NOT obvious from the code alone. Output a concise bulleted list grouped by subsystem/area. Drop one-off nits, style chatter, and anything a competent generic reviewer already knows. Never include contributor names, PR numbers, or dates.`;

function renderCorpus(corpus: CorpusItem[], maxChars: number): string {
  const lines: string[] = [];
  for (const item of corpus) {
    for (const c of item.comments) {
      lines.push(c.path ? `- [${c.path}] ${c.body.replace(/\s+/g, ' ').slice(0, 400)}` : `- ${c.body.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    if (lines.join('\n').length > maxChars) break;
  }
  return lines.join('\n').slice(0, maxChars);
}

function renderFacts(repo: string, f: RepoFacts): string {
  return [
    `Repository: ${repo}`,
    `Top-level directories: ${f.topDirs.join(', ') || '(none)'}`,
    `Languages (by file count): ${f.languages.map((l) => `${l.ext}:${l.count}`).join(', ') || '(unknown)'}`,
    `Build files: ${f.buildFiles.join(', ') || '(none detected)'}`,
    f.readmeExcerpt ? `README excerpt:\n${f.readmeExcerpt}` : 'README: (none)',
  ].join('\n');
}

export async function distillEssence(config: ReviewerConfig, facts: RepoFacts, repo: string, corpus: CorpusItem[]): Promise<string> {
  if (corpus.length === 0) return '';
  const { text } = await generateText({
    model: buildChatModel(config.models.distill),
    system: DISTILL_SYSTEM,
    prompt: `${renderFacts(repo, facts)}\n\n## Past review feedback (noise-filtered)\n\n${renderCorpus(corpus, 60_000)}`,
    maxOutputTokens: config.limits.maxOutputTokens.distill,
  });
  return text.trim();
}

/** Strip a wrapping ```...``` code fence the model sometimes adds (even if it forgets to close it). */
function stripFence(s: string): string {
  const lines = s.trim().split('\n');
  if (lines.length && /^```[a-zA-Z]*$/.test(lines[0].trim())) lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
  return lines.join('\n').trim();
}

export async function composeTextbook(config: ReviewerConfig, repo: string, facts: RepoFacts, essence: string): Promise<string> {
  const guidancePath = join(engineRoot(), 'agent-knowledge', 'skill-writing-best-practices.md');
  const guidance = existsSync(guidancePath) ? readFileSync(guidancePath, 'utf8') : '';
  const system = `You are composing the reviewer "textbook" for a repository — the institutional-memory SKILL the PR reviewer reads on every review. Write tight, evidence-oriented markdown: what the repo is and its subsystems (where they live), always-on checks, and the distilled concerns expressed as patterns with explicit "Skip unless:" gates and a "## Do NOT flag" carve-out section to prevent false positives. No contributor names, PR numbers, or time-sensitive phrasing. Aim for 80-250 lines.${guidance ? `\n\n## Skill-writing guidance to follow\n\n${guidance}` : ''}`;
  const { text } = await generateText({
    model: buildChatModel(config.models.curator),
    system,
    prompt: `${renderFacts(repo, facts)}\n\n## Distilled maintainer-essence points\n\n${essence || '(no past feedback was available; base the textbook on the structure above and general best practice for this stack)'}`,
    maxOutputTokens: config.limits.maxOutputTokens.distill,
  });
  return stripFence(text);
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export interface InitOptions {
  readonly config: ReviewerConfig;
  readonly repo: string;
  readonly maxPRs?: number;
}

export interface InitResult {
  readonly repo: string;
  readonly prsScanned: number;
  readonly textbookChars: number;
  readonly botLogin: string;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const { config, repo } = opts;
  const maxPRs = opts.maxPRs ?? 1000;
  const { octokit, token } = getOctokit(config.github);
  const botLogin = (await octokit.users.getAuthenticated()).data.login;

  // Fail fast if the store backend is unreachable, before the expensive backfill + LLM work.
  const store = await openStore(config, repo);

  const [owner, name] = repo.split('/');
  const cloneDir = join(config.review.workspaceDir, `${owner}__${name}`);
  console.log(`[init] cloning ${repo} …`);
  await cloneRepo(repo, token, cloneDir);

  console.log('[init] scanning repo structure …');
  const facts = scanRepo(cloneDir);

  console.log(`[init] backfilling up to ${maxPRs} PRs of review history …`);
  const corpus = await backfillReviewCorpus(octokit, repo, maxPRs, botLogin);
  console.log(`[init] collected feedback from ${corpus.length} PRs`);

  console.log('[init] distilling maintainer-essence …');
  const essence = await distillEssence(config, facts, repo, corpus);

  console.log('[init] composing reviewer textbook …');
  const textbook = await composeTextbook(config, repo, facts, essence);

  try {
    await store.writeTextbook(textbook);
  } finally {
    await store.close();
  }

  writeReviewer(config, { repo, botLogin });
  console.log(`[init] wrote textbook (${textbook.length} chars) and registered ${repo}`);

  return { repo, prsScanned: corpus.length, textbookChars: textbook.length, botLogin };
}
