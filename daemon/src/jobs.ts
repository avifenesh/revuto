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
import { runReview, unreviewedOutcome, describeOutcome, type ReviewOutcome } from '../../agents/common/src/run-agent.js';
import { runCurator } from '../../agents/curator/src/run-curator.js';
import { runDecay, type DecayStats } from '../../ops/src/decay.js';
import { pollOpenPRs, pollFeedback } from './poller.js';
import { readReviewer, writeReviewer, type ReviewerSettings } from './reviewers.js';
import { historicalReviewRounds, reserveReviewRound } from './review-rounds.js';
import { runQueuedReview } from './review-queue.js';
import { runQueuedForRepo } from './repo-queue.js';
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
  return runQueuedForRepo(config, `_review-poll/${settings.repo}`, () => reviewRepoSnapshot(config, settings, opts));
}

async function reviewRepoSnapshot(config: ReviewerConfig, settings: ReviewerSettings, opts: { force?: boolean }): Promise<ReviewJobResult> {
  const { octokit } = getOctokit(config.github);
  const store = await openStore(config, settings.repo);
  try {
    const cursor = await store.getCursor('review');
    if (!cursor && !opts.force) {
      await store.setCursor('review', nowIso());
      return { reviewed: 0, skipped: 0, initialized: true };
    }
    const pollStarted = nowIso();
    const prs = await pollOpenPRs(octokit, settings.repo, cursor ?? undefined);
    let skipped = 0;
    const eligible = prs.filter(pr => {
      if (pr.isDraft || (settings.authorAllowlist?.length && !settings.authorAllowlist.includes(pr.author))) { skipped++; return false; }
      return true;
    });
    const results = await Promise.allSettled(eligible.map(pr => reviewOnePr(config, settings.repo, pr.number, { expectedHeadSha: pr.headSha })));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(r => r.reason), `${errors.length} review(s) failed for ${settings.repo}`);
    const outcomes = results.filter((r): r is PromiseFulfilledResult<ReviewOutcome> => r.status === 'fulfilled').map(r => r.value);
    // Updates arriving while the batch runs must remain visible to the next poll.
    if (!outcomes.some(r => r.result.startsWith('Daily '))) await store.setCursor('review', pollStarted);
    return { reviewed: outcomes.filter(r => r.ranModel).length, skipped: skipped + outcomes.filter(r => !r.ranModel).length,
      ...(outcomes.some(r => !r.ranModel && /limit/.test(r.result)) ? { limited: 'review-limit' } : {}) };
  } finally { await store.close(); }
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
  return runQueuedReview(config, repo, prNumber, () => reviewOnePrAdmitted(config, repo, prNumber, opts));
}

async function reviewOnePrAdmitted(config: ReviewerConfig, repo: string, prNumber: number, opts: ReviewOnePrOptions): Promise<ReviewOutcome> {
  const githubApp = githubAppForRepo(config, repo);
  const auth = opts.githubAuth ?? (githubApp
    ? await getRepositoryInstallationOctokit(githubApp, repo)
    : getOctokit(config.github));
  const { octokit } = auth;
  const parts = repo.split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) throw new Error(`bad repo: ${repo} (expected owner/name)`);
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  if (pr.state !== 'open' && !opts.force) return unreviewedOutcome(`#${prNumber} is closed; ignoring the queued review`, pr.head.sha);
  if (opts.expectedHeadSha && pr.head.sha !== opts.expectedHeadSha) {
    return unreviewedOutcome(
      `#${prNumber} advanced from ${opts.expectedHeadSha} to ${pr.head.sha}; ignoring the stale delivery`,
      pr.head.sha,
    );
  }
  if (pr.draft && !opts.force) {
    // Rule: never touch drafts unless explicitly forced. They get reviewed once marked ready (updated_at bumps → next poll).
    return unreviewedOutcome(`#${prNumber} is a draft — drafts are never reviewed unless forced`, pr.head.sha);
  }
  // Reviewing surfaces the repo in the Obsidian index even if it wasn't init'd.
  if (!readReviewer(config, repo)) {
    if (opts.registeredOnly) {
      return unreviewedOutcome(`${repo} is no longer registered; ignoring the review request`, pr.head.sha);
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
      return unreviewedOutcome(
        `#${prNumber} at ${pr.head.sha} was already reviewed or is currently being reviewed`,
        pr.head.sha,
      );
    }
    if (opts.onClaimed) {
      await opts.onClaimed(pr.head.sha);
    } else if (githubApp) {
      managedCheckRunId = await createReviewCheck(auth, githubApp, managedTarget);
    }
    const day = dayKey();
    const round = await runQueuedForRepo(config, `_review-budget/${repo}`, async () => {
      if (config.limits.dailyReviews && await store.getCounter(counterKey('reviews', day)) >= config.limits.dailyReviews) {
        return { allowed: false, reason: 'Daily review limit reached' };
      }
      if (config.limits.dailyTokens && await store.getCounter(counterKey('tokens', day)) >= config.limits.dailyTokens) {
        return { allowed: false, reason: 'Daily token limit reached' };
      }
      const reserved = await reserveReviewRound(store, prNumber, config.review.maxRounds ?? 3,
        () => historicalReviewRounds(auth, repo, prNumber, readReviewer(config, repo)?.botLogin));
      if (reserved.allowed && config.limits.dailyReviews) await store.incrCounter(counterKey('reviews', day));
      return reserved;
    });
    const outcome = round.allowed
      ? await runReview({ repo, prNumber, headSha: pr.head.sha, config, store, embedder, githubAuth: auth })
      : unreviewedOutcome(round.reason, pr.head.sha);
    if (outcome.ranModel && config.limits.dailyTokens) await store.incrCounter(counterKey('tokens', day), outcome.tokens);
    assertReviewedHead(managedTarget, outcome);
    console.log(`[review] ${key}: ${describeOutcome(outcome)}`);
    if (outcome.terminal === 'none') {
      throw new Error(`review of ${repo}#${prNumber}@${pr.head.sha} ended without a terminal decision`);
    }
    if (round.reason.startsWith('Daily ')) await store.unclaim(key);
    else await store.mark(key);
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
