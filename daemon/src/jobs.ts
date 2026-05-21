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

export interface ReviewJobResult { reviewed: number; skipped: number; initialized?: boolean; }
export interface LearnJobResult { curated: number; seen: number; initialized?: boolean; }

export async function reviewRepo(config: ReviewerConfig, settings: ReviewerSettings): Promise<ReviewJobResult> {
  const { octokit } = getOctokit(config.github);
  const store = await openStore(config, settings.repo);
  const embedder = maybeEmbedder(config);
  try {
    const cursor = await store.getCursor('review');
    if (!cursor) {
      await store.setCursor('review', nowIso());
      return { reviewed: 0, skipped: 0, initialized: true };
    }
    const prs = await pollOpenPRs(octokit, settings.repo, cursor);
    let reviewed = 0, skipped = 0;
    for (const pr of prs) {
      if (pr.isBot) { skipped++; continue; }                                                   // never review bot-authored PRs
      if (settings.authorAllowlist?.length && !settings.authorAllowlist.includes(pr.author)) { skipped++; continue; }
      const key = `${settings.repo}#${pr.number}@${pr.headSha}`;
      if (await store.seen(key)) { skipped++; continue; }                                       // already reviewed this head — no re-iterate
      await runReview({ repo: settings.repo, prNumber: pr.number, config, store, embedder });   // one review agent per new PR
      await store.mark(key);
      reviewed++;
    }
    await store.setCursor('review', nowIso());
    return { reviewed, skipped };
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
    const feedback = await pollFeedback(octokit, settings.repo, botLogin, cursor);
    let curated = 0;
    for (const fb of feedback) {
      if (await store.seen(fb.feedbackId)) continue;
      await runCurator({ config, store, embedder, feedback: fb });
      await store.mark(fb.feedbackId);
      curated++;
    }
    await store.setCursor('learn', nowIso());
    return { curated, seen: feedback.length };
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

/** On-demand single-PR review (CLI `reviewer review <repo> <pr>`). */
export async function reviewOnePr(config: ReviewerConfig, repo: string, prNumber: number): Promise<ReviewOutcome> {
  const { octokit } = getOctokit(config.github);
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

/** On-demand single learn pass (CLI `reviewer learn <repo>`). */
export async function learnOnce(config: ReviewerConfig, settings: ReviewerSettings): Promise<LearnJobResult> {
  return learnRepo(config, settings);
}
