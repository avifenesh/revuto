/**
 * The three per-repo jobs the scheduler runs: review (new PRs), learn (recent
 * feedback → concerns → graduation), decay (age out stale concerns). Each opens
 * the per-repo store, advances cursors, and uses idempotency keys so re-ticks
 * don't redo work.
 */
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { getOctokit, getRepositoryInstallationOctokit, type GithubAuth } from '../../agents/common/src/github-auth.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { maybeEmbedder } from '../../agents/common/src/memory/embedder.js';
import { runReview, type ReviewOutcome } from '../../agents/common/src/run-agent.js';
import { runCurator } from '../../agents/curator/src/run-curator.js';
import { runDecay, type DecayStats } from '../../ops/src/decay.js';
import { pollOpenPRs, pollFeedback } from './poller.js';
import { readReviewer, writeReviewer, type ReviewerSettings } from './reviewers.js';
import {
  assertReviewedHead,
  checkResultForError,
  checkResultForOutcome,
  completeReviewCheck,
  createReviewCheck,
  type ReviewCheckTarget,
} from './review-check.js';

const nowIso = (): string => new Date().toISOString();

export interface ReviewJobResult { reviewed: number; skipped: number; initialized?: boolean; limited?: string; }
export interface LearnJobResult { curated: number; seen: number; initialized?: boolean; limited?: string; }

const dayKey = (): string => new Date().toISOString().slice(0, 10);
const counterKey = (name: 'reviews' | 'learn' | 'tokens', day: string): string => `${name}:${day}`;

function githubAppForRepo(config: ReviewerConfig, repo: string) {
  const app = config.github.app;
  if (!app) return undefined;
  const owner = repo.split('/')[0]?.toLowerCase();
  if (!owner) return undefined;
  if (app.allowedOwners.length === 0 || app.allowedOwners.some((candidate) => candidate.toLowerCase() === owner)) return app;
  return undefined;
}

export async function reviewRepo(config: ReviewerConfig, settings: ReviewerSettings, opts: { force?: boolean } = {}): Promise<ReviewJobResult> {
  const pollingAuth = getOctokit(config.github);
  const { octokit } = pollingAuth;
  const githubApp = githubAppForRepo(config, settings.repo);
  let appAuth: GithubAuth | undefined;
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
      if (pr.isDraft) { skipped++; continue; }                                                  // never touch drafts; reviewed once they're marked ready (updated_at bumps)
      if (settings.authorAllowlist?.length && !settings.authorAllowlist.includes(pr.author)) { skipped++; continue; }
      const key = `${settings.repo}#${pr.number}@${pr.headSha}`;
      if (dailyReviews && reviewsToday >= dailyReviews) { limited = 'daily-reviews'; break; }
      if (dailyTokens && tokensToday >= dailyTokens) { limited = 'daily-tokens'; break; }
      if (!(await store.claim(key))) { skipped++; continue; }                                   // already reviewing/reviewed this head — no duplicate posts
      let outcome: ReviewOutcome;
      let checkRunId: number | undefined;
      let reviewAuth = pollingAuth;
      const target: ReviewCheckTarget = {
        repo: settings.repo,
        prNumber: pr.number,
        headSha: pr.headSha,
        detailsUrl: `https://github.com/${settings.repo}/pull/${pr.number}`,
      };
      try {
        if (githubApp) {
          appAuth ??= await getRepositoryInstallationOctokit(githubApp, settings.repo);
          reviewAuth = appAuth;
          checkRunId = await createReviewCheck(reviewAuth, githubApp, target);
        }
        outcome = await runReview({
          repo: settings.repo,
          prNumber: pr.number,
          config,
          store,
          embedder,
          githubAuth: reviewAuth,
        });
        assertReviewedHead(target, outcome);
        if (outcome.terminal === 'none') throw new Error(`review of ${key} ended without a terminal decision`);
      } catch (err) {
        if (githubApp && checkRunId !== undefined) {
          try {
            await completeReviewCheck(reviewAuth, githubApp, target, checkRunId, checkResultForError(err));
          } catch (updateErr) {
            console.error(`[review] could not complete check ${checkRunId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
          }
        }
        await store.unclaim(key);                                                                // release the claim so a transient failure can be retried
        throw err;
      }
      await store.mark(key);
      if (githubApp && checkRunId !== undefined) {
        try {
          await completeReviewCheck(reviewAuth, githubApp, target, checkRunId, checkResultForOutcome(outcome));
        } catch (err) {
          console.error(`[review] could not complete check ${checkRunId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
      const out = await runCurator({ config, store, embedder, feedback: fb, autoActivate: settings.autoActivate });
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
export interface ReviewOnePrOptions {
  readonly force?: boolean;
  readonly githubAuth?: GithubAuth;
  /** Skip instead of auto-registering when the reviewer note is absent. */
  readonly registeredOnly?: boolean;
  /** Ignore a stale webhook if the PR has advanced since GitHub sent it. */
  readonly expectedHeadSha?: string;
  /** Called after this exact PR head is claimed and before the model run begins. */
  readonly onClaimed?: (headSha: string) => Promise<void>;
}

export async function reviewOnePr(config: ReviewerConfig, repo: string, prNumber: number, opts: ReviewOnePrOptions = {}): Promise<ReviewOutcome> {
  const githubApp = githubAppForRepo(config, repo);
  const auth = opts.githubAuth ?? (githubApp
    ? await getRepositoryInstallationOctokit(githubApp, repo)
    : getOctokit(config.github));
  const { octokit } = auth;
  const parts = repo.split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) throw new Error(`bad repo: ${repo} (expected owner/name)`);
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  if (opts.expectedHeadSha && pr.head.sha !== opts.expectedHeadSha) {
    return {
      terminal: 'skip_review',
      result: `#${prNumber} advanced from ${opts.expectedHeadSha} to ${pr.head.sha}; ignoring the stale delivery`,
      headSha: pr.head.sha,
      steps: 0,
      tokens: 0,
    };
  }
  if (pr.draft) {
    // Rule: never touch drafts. They get reviewed once marked ready (updated_at bumps → next poll).
    return { terminal: 'skip_review', result: `#${prNumber} is a draft — drafts are never reviewed`, headSha: pr.head.sha, steps: 0, tokens: 0 };
  }
  // Reviewing surfaces the repo in the Obsidian index even if it wasn't init'd.
  if (!readReviewer(config, repo)) {
    if (opts.registeredOnly) {
      return {
        terminal: 'skip_review',
        result: `${repo} is no longer registered; ignoring the review request`,
        headSha: pr.head.sha,
        steps: 0,
        tokens: 0,
      };
    }
    let botLogin = auth.login;
    if (!botLogin) {
      try {
        botLogin = (await octokit.users.getAuthenticated()).data.login;
      } catch {
        // Installation tokens do not represent a user. App auth normally supplies login.
      }
    }
    writeReviewer(config, { repo, ...(botLogin ? { botLogin } : {}) });
  }
  const store = await openStore(config, repo);
  const embedder = maybeEmbedder(config);
  const key = `${repo}#${prNumber}@${pr.head.sha}`;
  const managedTarget: ReviewCheckTarget = {
    repo,
    prNumber,
    headSha: pr.head.sha,
    detailsUrl: pr.html_url,
  };
  let managedCheckRunId: number | undefined;
  try {
    if (!opts.force && !(await store.claim(key))) {
      return {
        terminal: 'skip_review',
        result: `#${prNumber} at ${pr.head.sha} was already reviewed or is currently being reviewed`,
        headSha: pr.head.sha,
        steps: 0,
        tokens: 0,
      };
    }
    if (opts.onClaimed) {
      await opts.onClaimed(pr.head.sha);
    } else if (githubApp) {
      managedCheckRunId = await createReviewCheck(auth, githubApp, managedTarget);
    }
    const outcome = await runReview({ repo, prNumber, config, store, embedder, githubAuth: auth });
    assertReviewedHead(managedTarget, outcome);
    if (outcome.terminal === 'none') {
      throw new Error(`review of ${repo}#${prNumber}@${pr.head.sha} ended without a terminal decision`);
    }
    await store.mark(key);
    if (githubApp && managedCheckRunId !== undefined) {
      try {
        await completeReviewCheck(auth, githubApp, managedTarget, managedCheckRunId, checkResultForOutcome(outcome));
      } catch (err) {
        console.error(`[review] could not complete check ${managedCheckRunId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return outcome;
  } catch (err) {
    if (githubApp && managedCheckRunId !== undefined) {
      try {
        await completeReviewCheck(auth, githubApp, managedTarget, managedCheckRunId, checkResultForError(err));
      } catch (updateErr) {
        console.error(`[review] could not complete check ${managedCheckRunId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
      }
    }
    if (!opts.force) await store.unclaim(key);                                                   // release the claim so a transient failure can be retried
    throw err;
  } finally {
    await store.close();
  }
}

/** On-demand single learn pass (CLI `revuto learn <repo>`). */
export async function learnOnce(config: ReviewerConfig, settings: ReviewerSettings): Promise<LearnJobResult> {
  return learnRepo(config, settings);
}
