/**
 * The three per-repo jobs the scheduler runs: review (new PRs), learn (recent
 * feedback → concerns → graduation), decay (age out stale concerns). Each opens
 * the per-repo store, advances cursors, and uses idempotency keys so re-ticks
 * don't redo work.
 */
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { getOctokit } from '../../agents/common/src/github-auth.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { maybeEmbedder } from '../../agents/common/src/memory/embedder.js';
import { runReview, type ReviewOutcome } from '../../agents/common/src/run-agent.js';
import { runCurator } from '../../agents/curator/src/run-curator.js';
import { runDecay, type DecayStats } from '../../ops/src/decay.js';
import { pollOpenPRs, pollFeedback } from './poller.js';
import { readReviewer, writeReviewer, type ReviewerSettings } from './reviewers.js';

const nowIso = (): string => new Date().toISOString();

export interface ReviewJobResult { reviewed: number; skipped: number; initialized?: boolean; limited?: string; }
export interface LearnJobResult { curated: number; seen: number; initialized?: boolean; limited?: string; }

const dayKey = (): string => new Date().toISOString().slice(0, 10);
const counterKey = (name: 'reviews' | 'learn' | 'tokens', day: string): string => `${name}:${day}`;

export async function reviewRepo(config: ReviewerConfig, settings: ReviewerSettings, opts: { force?: boolean } = {}): Promise<ReviewJobResult> {
  const { octokit } = getOctokit(config.github);
  const store = await openStore(config, settings.repo);
  const embedder = maybeEmbedder(config);
  try {
    const cursor = await store.getCursor('review');
    if (!cursor && !opts.force) {
      // First scheduled tick: don't review the whole open backlog — start from now.
      // (A manual `trigger` passes force to review the current open PRs.)
      await store.setCursor('review', nowIso());
      return { reviewed: 0, skipped: 0, initialized: true };
    }
    const prs = await pollOpenPRs(octokit, settings.repo, cursor ?? undefined);
    const day = dayKey();
    const { dailyReviews, dailyTokens } = config.limits;
    let reviewsToday = dailyReviews ? await store.getCounter(counterKey('reviews', day)) : 0;
    let tokensToday = dailyTokens ? await store.getCounter(counterKey('tokens', day)) : 0;
    let reviewed = 0, skipped = 0;
    let limited: string | undefined;
    for (const pr of prs) {
      if (pr.isBot) { skipped++; continue; }                                                   // never review bot-authored PRs
      if (!pr.isDraft) { skipped++; continue; }                                                 // never touch drafts; reviewed once they're marked ready (updated_at bumps)
      if (settings.authorAllowlist?.length && !settings.authorAllowlist.includes(pr.author)) { skipped++; continue; }
      const key = `${settings.repo}#${pr.number}@${pr.headSha}`;
      if (await store.seen(key)) { skipped++; continue; }                                       // already reviewed this head — no re-iterate
      if (dailyReviews && reviewsToday >= dailyReviews) { limited = 'daily-reviews'; break; }
      if (dailyTokens && tokensToday >= dailyTokens) { limited = 'daily-tokens'; break; }
      const outcome = await runReview({ repo: settings.repo, prNumber: pr.number, config, store, embedder }); // one review agent per new PR
      await store.mark(key);
      reviewed++;
      if (dailyReviews) reviewsToday = await store.incrCounter(counterKey('reviews', day));
      if (dailyTokens) tokensToday = await store.incrCounter(counterKey('tokens', day), outcome.tokens);   // shared daily token budget
    }
    await store.setCursor('review', nowIso());
    return { reviewed, skipped, ...(limited ? { limited } : {}) };
  } finally {
    await store.close();
  }
}

export async function learnRepo(config: ReviewerConfig, settings: ReviewerSettings): Promise<LearnJobResult> {
  const { octokit } = getOctokit(config.github);
  const store = await openStore(config, settings.repo);
  const embedder = maybeEmbedder(config);
  try {
    const cursor = await store.getCursor('learn');
    if (!cursor) {
      await store.setCursor('learn', nowIso());
      return { curated: 0, seen: 0, initialized: true };
    }
    const botLogin = settings.botLogin ?? (await octokit.users.getAuthenticated()).data.login;
    let feedback = await pollFeedback(octokit, settings.repo, botLogin, cursor);
    if (config.limits.learnBatch) feedback = feedback.slice(0, config.limits.learnBatch);       // per-batch cap
    const day = dayKey();
    const { dailyLearn, dailyTokens } = config.limits;
    let learnedToday = dailyLearn ? await store.getCounter(counterKey('learn', day)) : 0;
    let tokensToday = dailyTokens ? await store.getCounter(counterKey('tokens', day)) : 0;
    let curated = 0;
    let limited: string | undefined;
    for (const fb of feedback) {
      if (await store.seen(fb.feedbackId)) continue;
      if (dailyLearn && learnedToday >= dailyLearn) { limited = 'daily-learn'; break; }
      if (dailyTokens && tokensToday >= dailyTokens) { limited = 'daily-tokens'; break; }
      const out = await runCurator({ config, store, embedder, feedback: fb });
      await store.mark(fb.feedbackId);
      curated++;
      if (dailyLearn) learnedToday = await store.incrCounter(counterKey('learn', day));
      if (dailyTokens) tokensToday = await store.incrCounter(counterKey('tokens', day), out.tokens);        // shared daily token budget
    }
    await store.setCursor('learn', nowIso());
    return { curated, seen: feedback.length, ...(limited ? { limited } : {}) };
  } finally {
    await store.close();
  }
}

export async function decayRepo(config: ReviewerConfig, repo: string): Promise<DecayStats> {
  const store = await openStore(config, repo);
  try {
    return await runDecay(store);
  } finally {
    await store.close();
  }
}

/** On-demand single-PR review (CLI `revuto review <repo> <pr>`). */
export async function reviewOnePr(config: ReviewerConfig, repo: string, prNumber: number): Promise<ReviewOutcome> {
  const { octokit } = getOctokit(config.github);
  const parts = repo.split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) throw new Error(`bad repo: ${repo} (expected owner/name)`);
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  if (pr.draft) {
    // Rule: never touch drafts. They get reviewed once marked ready (updated_at bumps → next poll).
    return { terminal: 'skip_review', result: `#${prNumber} is a draft — drafts are never reviewed`, headSha: pr.head.sha, steps: 0, tokens: 0 };
  }
  // Reviewing surfaces the repo in the Obsidian index even if it wasn't init'd.
  if (!readReviewer(config, repo)) {
    writeReviewer(config, { repo, botLogin: (await octokit.users.getAuthenticated()).data.login });
  }
  const store = await openStore(config, repo);
  const embedder = maybeEmbedder(config);
  try {
    return await runReview({ repo, prNumber, config, store, embedder });
  } finally {
    await store.close();
  }
}

/** On-demand single learn pass (CLI `revuto learn <repo>`). */
export async function learnOnce(config: ReviewerConfig, settings: ReviewerSettings): Promise<LearnJobResult> {
  return learnRepo(config, settings);
}
