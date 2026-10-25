/**
 * The three per-repo jobs the scheduler runs: review (new PRs), learn (recent
 * feedback → concerns → graduation), decay (age out stale concerns). Each opens
 * the per-repo store, advances cursors, and uses idempotency keys so re-ticks
 * don't redo work.
 */
import type { ReviewerConfig } from '../../agents/common/src/config.js';
import { githubAppForRepo, githubAuthForRepo, type GithubAuth } from '../../agents/common/src/github-auth.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { maybeEmbedder } from '../../agents/common/src/memory/embedder.js';
import { runReview, unreviewedOutcome, describeOutcome, type ReviewOutcome } from '../../agents/common/src/run-agent.js';
import { GuardUnavailableError, runCurator, type FeedbackEvent } from '../../agents/curator/src/run-curator.js';
import { buildKnowledgeGuard } from '../../agents/common/src/knowledge-guard.js';
import { runDecay, type DecayStats } from '../../ops/src/decay.js';
import { pollReviewCandidates, pollFeedback } from './poller.js';
import { readReviewer, writeReviewer, type ReviewerSettings } from './reviewers.js';
import {
  counterKey,
  FINAL_REVIEW_HEADING,
  finalReviewUsed,
  finalReviewUsedReason,
  historicalReviewRounds,
  refundFinalReview,
  reserveReviewBudget,
  roundCapReached,
} from './review-rounds.js';
import { logIgnoredOnce, repoIgnored } from '../../agents/common/src/review-routing.js';
import { runQueuedReview } from './review-queue.js';
import { runQueuedForRepo } from './repo-queue.js';
import {
  assertReviewedHead,
  checkResultForError,
  checkResultForOutcome,
  completeReviewCheck,
  createReviewCheck,
  finalReviewCheckResult,
  type CheckResult,
  type ReviewCheckTarget,
} from './review-check.js';
import { getAppBotLogin } from '../../agents/common/src/github-auth.js';

const nowIso = (): string => new Date().toISOString();

export interface ReviewJobResult { reviewed: number; skipped: number; initialized?: boolean; limited?: string; }
export interface LearnJobResult { curated: number; seen: number; initialized?: boolean; limited?: string; }

const dayKey = (): string => new Date().toISOString().slice(0, 10);

export interface ReviewJobDependencies {
  readonly githubAuth?: GithubAuth;
  readonly openStore?: typeof openStore;
  readonly reviewOnePr?: typeof reviewOnePr;
}

export async function reviewRepo(config: ReviewerConfig, settings: ReviewerSettings, opts: { force?: boolean } = {}, deps: ReviewJobDependencies = {}): Promise<ReviewJobResult> {
  if (repoIgnored(config.github.app?.ignoredRepos, settings.repo)) {
    logIgnoredOnce(settings.repo, undefined, 'review');
    return { reviewed: 0, skipped: 0 };
  }
  return runQueuedForRepo(config, `_review-poll/${settings.repo}`, () => reviewRepoSnapshot(config, settings, opts, deps));
}

async function reviewRepoSnapshot(config: ReviewerConfig, settings: ReviewerSettings, opts: { force?: boolean }, deps: ReviewJobDependencies): Promise<ReviewJobResult> {
  const app = githubAppForRepo(config.github, settings.repo);
  const { octokit } = deps.githubAuth ?? await githubAuthForRepo(config.github, settings.repo);
  const store = await (deps.openStore ?? openStore)(config, settings.repo);
  try {
    const cursor = await store.getCursor('review');
    if (!cursor && !opts.force && !app) {
      await store.setCursor('review', nowIso());
      return { reviewed: 0, skipped: 0, initialized: true };
    }
    const pollStarted = nowIso();
    const initializing = !cursor && !opts.force;
    const prs = await pollReviewCandidates(octokit, settings.repo, cursor ?? (initializing ? pollStarted : undefined), app);
    let skipped = 0;
    const eligible = prs.filter(pr => {
      if (pr.isDraft || (settings.authorAllowlist?.length && !settings.authorAllowlist.includes(pr.author))) { skipped++; return false; }
      return true;
    });
    const results = await Promise.allSettled(eligible.map(pr => (deps.reviewOnePr ?? reviewOnePr)(config, settings.repo, pr.number, { expectedHeadSha: pr.headSha })));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const outcomes = results.filter((r): r is PromiseFulfilledResult<ReviewOutcome> => r.status === 'fulfilled').map(r => r.value);
    const retryPrs = eligible.filter((_pr, index) => {
      const result = results[index];
      return result.status === 'rejected' || result.value.result.startsWith('Daily ');
    });
    // Updates arriving while the batch runs must remain visible to the next poll.
    // A rescued head can predate the old cursor. If its first attempt creates
    // a run and then fails, the empty-suite test no longer finds it. Rewind so
    // normal delta discovery retries it under the usual exact-head claim.
    if (retryPrs.length) {
      const retrySince = Math.min(Date.parse(cursor ?? pollStarted), ...retryPrs.map((pr) => Date.parse(pr.updatedAt) - 1));
      await store.setCursor('review', new Date(retrySince).toISOString());
    } else {
      await store.setCursor('review', pollStarted);
    }
    if (errors.length) throw new AggregateError(errors.map(r => r.reason), `${errors.length} review(s) failed for ${settings.repo}`);
    return { reviewed: outcomes.filter(r => r.ranModel).length, skipped: skipped + outcomes.filter(r => !r.ranModel).length,
      ...(initializing ? { initialized: true } : {}),
      ...(outcomes.some(r => !r.ranModel && /limit/.test(r.result)) ? { limited: 'review-limit' } : {}) };
  } finally { await store.close(); }
}

/** Attempts at one feedback event before the learn loop drops it (outages do not count). */
const LEARN_MAX_ATTEMPTS = 3;

/**
 * A model service that is down or overloaded, not a problem with the feedback:
 * network failures, timeouts, rate limits and 5xx, and a fallback chain where
 * every model failed that way.
 */
const OUTAGE = /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|timed? ?out|\b429\b|rate.?limit|overloaded|\b5\d\d\b|service unavailable/i;
const FALLBACK_PREFIX = 'all model fallbacks failed: ';

export function isServiceOutage(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // An exhausted fallback chain is an outage only when every model in it failed that way;
  // a 400 for an oversized input fails the same way everywhere and belongs to the event.
  if (message.startsWith(FALLBACK_PREFIX)) {
    return message.slice(FALLBACK_PREFIX.length).split(' | ').every((part) => OUTAGE.test(part));
  }
  const text = err instanceof Error ? `${err.name} ${message} ${String((err as { cause?: unknown }).cause ?? '')}` : message;
  return OUTAGE.test(text);
}

/**
 * Every login revuto posts or has posted as on this repo: the registered login
 * (a personal token's user, from before the App), the current credential's
 * login, and the App's bot. A personal token is asked for its user only when
 * nothing else names one.
 */
export async function reviewerIdentities(config: ReviewerConfig, settings: ReviewerSettings, auth: GithubAuth): Promise<string[]> {
  const logins = [settings.botLogin, auth.login].filter((l): l is string => !!l);
  const app = githubAppForRepo(config.github, settings.repo);
  if (app) {
    try { logins.push(await getAppBotLogin(app)); }
    catch (err) { console.warn(`[learn] ${settings.repo}: App login unavailable: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (!logins.length) logins.push((await auth.octokit.users.getAuthenticated()).data.login);
  return [...new Set(logins)];
}

/** Authors with write access to the repository. */
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export async function learnRepo(config: ReviewerConfig, settings: ReviewerSettings): Promise<LearnJobResult> {
  const auth = await githubAuthForRepo(config.github, settings.repo);
  const { octokit } = auth;
  const store = await openStore(config, settings.repo);
  const embedder = maybeEmbedder(config);
  try {
    const cursor = await store.getCursor('learn');
    if (!cursor) {
      await store.setCursor('learn', nowIso());
      return { curated: 0, seen: 0, initialized: true };
    }
    const identities = await reviewerIdentities(config, settings, auth);
    // The cursor moves to when this poll started, not when it finished: comments posted during a long run come next time.
    const pollStarted = nowIso();
    // Already-processed comments come back when the cursor rewinds; they never take a batch slot.
    const polled: FeedbackEvent[] = [];
    for (const f of await pollFeedback(octokit, settings.repo, identities, cursor)) if (!(await store.seen(f.feedbackId))) polled.push(f);
    const feedback = config.limits.learnBatch ? polled.slice(0, config.limits.learnBatch) : polled;       // per-batch cap
    /**
     * The cursor that re-polls `polled[i]` and everything after it, the batch's capped
     * tail included. Comments are listed by creation, the cursor filters by update, so
     * the earliest update among them is the bound.
     */
    const resumeBefore = (i: number): string => {
      const times = polled.slice(i).map((f) => Date.parse(f.updatedAt ?? '')).filter(Number.isFinite);
      return times.length ? new Date(Math.min(...times) - 1).toISOString() : cursor;
    };
    const day = dayKey();
    const { dailyLearn, dailyTokens } = config.limits;
    let learnedToday = dailyLearn ? await store.getCounter(counterKey('learn', day)) : 0;
    let tokensToday = dailyTokens ? await store.getCounter(counterKey('tokens', day)) : 0;
    let curated = 0;
    let limited: string | undefined;
    const guard = buildKnowledgeGuard(config);
    let resumeAt: string | undefined;
    for (const [i, fb] of feedback.entries()) {
      if (await store.seen(fb.feedbackId)) continue;
      // A limit stops the pass, but the cursor stays before what was not processed, so nothing is skipped for good.
      if (dailyLearn && learnedToday >= dailyLearn) { limited = 'daily-learn'; resumeAt = resumeBefore(i); break; }
      if (dailyTokens && tokensToday >= dailyTokens) { limited = 'daily-tokens'; resumeAt = resumeBefore(i); break; }
      let out: Awaited<ReturnType<typeof runCurator>>;
      try {
        out = await runCurator({ config, store, embedder, feedback: fb, autoActivate: settings.autoActivate, guard });
      } catch (err) {
        // The feedback stays pending for the next tick, but what the run spent still counts.
        if (err instanceof GuardUnavailableError && dailyTokens && err.tokens) await store.incrCounter(counterKey('tokens', day), err.tokens);
        // Only a failure this event causes counts toward dropping it; an outage just retries.
        const failures = err instanceof GuardUnavailableError || isServiceOutage(err) ? 0 : await store.incrCounter(`learn-fail:${fb.feedbackId}`);
        if (failures < LEARN_MAX_ATTEMPTS) {
          await store.setCursor('learn', resumeBefore(i));
          throw err;
        }
        // One comment that always breaks the curator must not stall the repo's learning.
        console.warn(`[learn] ${settings.repo} ${fb.feedbackId}: dropped after ${failures} failed attempts: ${err instanceof Error ? err.message : String(err)}`);
        await store.mark(fb.feedbackId);
        continue;
      }
      await store.mark(fb.feedbackId);
      curated++;
      if (dailyLearn) learnedToday = await store.incrCounter(counterKey('learn', day));
      if (dailyTokens) tokensToday = await store.incrCounter(counterKey('tokens', day), out.tokens);        // shared daily token budget
    }
    // A batch cut short by learnBatch leaves its tail for the next pass.
    await store.setCursor('learn', resumeAt ?? (polled.length > feedback.length ? resumeBefore(feedback.length) : pollStarted));
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
  /**
   * `revuto review --final`: once the round cap is reached, allow exactly one more
   * review of the current head (reserved under `final-review:<pr>:<headSha>`).
   * Below the cap it is a normal round. Daily limits still apply.
   */
  readonly final?: boolean;
  readonly githubAuth?: GithubAuth;
  /** Skip instead of auto-registering when the reviewer note is absent. */
  readonly registeredOnly?: boolean;
  /** Ignore a stale webhook if the PR has advanced since GitHub sent it. */
  readonly expectedHeadSha?: string;
  /** Called after this exact PR head is claimed and before the model run begins. */
  readonly onClaimed?: (headSha: string) => Promise<void>;
  /** The delivery reported a base change (pull_request.edited with changes.base). */
  readonly retarget?: boolean;
  /** The model run; replaceable in tests. */
  readonly runReview?: typeof runReview;
}

export async function reviewOnePr(config: ReviewerConfig, repo: string, prNumber: number, opts: ReviewOnePrOptions = {}): Promise<ReviewOutcome> {
  return runQueuedReview(config, repo, prNumber, () => reviewOnePrAdmitted(config, repo, prNumber, opts));
}

async function reviewOnePrAdmitted(config: ReviewerConfig, repo: string, prNumber: number, opts: ReviewOnePrOptions): Promise<ReviewOutcome> {
  const githubApp = githubAppForRepo(config.github, repo);
  const auth = opts.githubAuth ?? await githubAuthForRepo(config.github, repo);
  const { octokit } = auth;
  const parts = repo.split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) throw new Error(`bad repo: ${repo} (expected owner/name)`);
  const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: prNumber });
  if (!opts.force && repoIgnored(config.github.app?.ignoredRepos, repo)) {
    // Never enqueued, never counted, no check run: the repo is on github.app.ignoredRepos.
    logIgnoredOnce(repo, prNumber, 'review');
    return unreviewedOutcome(`${repo}#${prNumber}: skipped: repo ignored (github.app.ignoredRepos)`, pr.head.sha);
  }
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
  // The webhook path reaches here too, so the repo's pause and author allowlist apply to it.
  const reviewer = readReviewer(config, repo);
  if (!opts.force && reviewer?.paused) return unreviewedOutcome(`${repo} is paused; ignoring the review request`, pr.head.sha);
  if (!opts.force && reviewer?.authorAllowlist?.length && !reviewer.authorAllowlist.includes(pr.user?.login ?? '')) {
    return unreviewedOutcome(`#${prNumber} by ${pr.user?.login ?? 'unknown'} is not on ${repo}'s author allowlist`, pr.head.sha);
  }
  const store = await openStore(config, repo);
  const embedder = maybeEmbedder(config);
  // A PR is reviewed against its base. The base of the PR's last completed review is
  // recorded (only once that review finished), so a later base change is seen on
  // any head: the same head, a new push, or a retry after a failed or refused run.
  // A retarget means a full review (no incremental baseline from the old base), and
  // a head whose review is already done gets a new claim generation, so the done
  // marker of a review against another base cannot stand for this one. A webhook
  // that reports the base change counts even for heads reviewed before this record
  // existed.
  const baseRef = pr.base?.ref ?? '';
  const baseMarker = `reviewed-base:${prNumber}`;
  const reviewedBase = baseRef ? await store.getCursor(baseMarker) : null;
  const retargeted = !!baseRef && (opts.retarget === true || (reviewedBase !== null && reviewedBase !== baseRef));
  const generationKey = `retarget:${prNumber}@${pr.head.sha}`;
  const keyFor = (g: number): string => `${repo}#${prNumber}@${pr.head.sha}${g ? `~base${g}` : ''}`;
  let generation = await store.getCounter(generationKey);
  // Only a finished generation moves on: one still claimed (in progress) dedupes as usual.
  if (retargeted && await store.seen(keyFor(generation))) generation = await store.incrCounter(generationKey);
  const key = keyFor(generation);
  if (retargeted) console.log(`[review] ${key}: base is ${baseRef}, last reviewed against ${reviewedBase ?? 'another base'}; full review`);
  const managedTarget: ReviewCheckTarget = {
    repo,
    prNumber,
    headSha: pr.head.sha,
    detailsUrl: pr.html_url,
  };
  let managedCheckRunId: number | undefined;
  const maxRounds = config.review.maxRounds ?? 3;
  const historical = () => historicalReviewRounds(auth, repo, prNumber, readReviewer(config, repo)?.botLogin);
  // The head a --final review is asked for was usually handled already: the daemon
  // saw it, the round cap refused it, and the head was marked done. Past the cap a
  // --final takes its own claim on that head, so the done marker does not block it.
  // A head that is mid-review, or one still under the cap, is refused as before.
  // Whichever claim a final review ran under, `<key>:final` is marked done after it.
  const finalKey = `${key}:final`;
  let claimKey = key;
  let finalRun = false;
  // Set once the run reached a terminal decision (a verdict posted or a clean skip).
  // A final run that throws before one gets the head's final review back.
  let decided = false;
  let tokensCounted = false;
  const labelled = (result: CheckResult): CheckResult => finalRun ? finalReviewCheckResult(result) : result;
  try {
    // A duplicate --final is refused before any claim or check run, so it cannot
    // replace the check the final review already completed on this head.
    if (opts.final && await finalReviewUsed(store, prNumber, pr.head.sha)) {
      return unreviewedOutcome(finalReviewUsedReason(prNumber, pr.head.sha), pr.head.sha);
    }
    if (!opts.force && !(await store.claim(key))) {
      const capped = opts.final && await store.seen(key)
        && await runQueuedForRepo(config, `_review-budget/${repo}`, () => roundCapReached(store, prNumber, maxRounds, historical));
      if (!capped) {
        return unreviewedOutcome(
          `#${prNumber} at ${pr.head.sha} was already reviewed or is currently being reviewed`,
          pr.head.sha,
        );
      }
      claimKey = finalKey;
      if (!(await store.claim(claimKey))) {
        return unreviewedOutcome(
          `PR #${prNumber} already had its final review at ${pr.head.sha.slice(0, 7)}, or one is running now. A final review runs once per head; push a new head to request another. This is not an approval.`,
          pr.head.sha,
        );
      }
    }
    if (opts.onClaimed) {
      await opts.onClaimed(pr.head.sha);
    } else if (githubApp) {
      managedCheckRunId = await createReviewCheck(auth, githubApp, managedTarget);
    }
    const day = dayKey();
    const round = await runQueuedForRepo(config, `_review-budget/${repo}`, () => reserveReviewBudget(store, {
      prNumber,
      headSha: pr.head.sha,
      maxRounds,
      final: opts.final === true,
      day,
      dailyReviews: config.limits.dailyReviews,
      dailyTokens: config.limits.dailyTokens,
      dailyReviewsPerAuthor: config.limits.dailyReviewsPerAuthor,
      ...(pr.user?.login ? { author: pr.user.login } : {}),
      maintainer: MAINTAINER_ASSOCIATIONS.has(pr.author_association ?? ''),
      historical,
    }));
    finalRun = round.allowed && round.final;
    if (finalRun) console.log(`[review] ${key}: ${round.reason}`);
    const ran = round.allowed
      ? await (opts.runReview ?? runReview)({ repo, prNumber, headSha: pr.head.sha, config, store, embedder, githubAuth: auth,
          ...(retargeted ? { fullReview: true } : {}),
          reviewerLogins: [auth.login, readReviewer(config, repo)?.botLogin].filter((l): l is string => !!l),
          ...(finalRun ? { reviewHeading: FINAL_REVIEW_HEADING } : {}) })
      : unreviewedOutcome(round.reason, pr.head.sha);
    const outcome: ReviewOutcome = finalRun ? { ...ran, finalReview: true } : ran;
    decided = outcome.terminal !== 'none';
    if (outcome.ranModel && config.limits.dailyTokens) await store.incrCounter(counterKey('tokens', day), outcome.tokens);
    tokensCounted = true;
    assertReviewedHead(managedTarget, outcome);
    console.log(`[review] ${key}: ${describeOutcome(outcome)}`);
    if (outcome.terminal === 'none') {
      throw new Error(`review of ${repo}#${prNumber}@${pr.head.sha} ended without a terminal decision`);
    }
    if (round.daily) await store.unclaim(claimKey);
    else {
      await store.mark(claimKey);
      // The PR now stands reviewed against this base; until then a retarget stays pending.
      if (baseRef && outcome.ranModel) await store.setCursor(baseMarker, baseRef);
    }
    if (finalRun && claimKey !== finalKey) await store.mark(finalKey);
    if (githubApp && managedCheckRunId !== undefined) {
      try {
        await completeReviewCheck(auth, githubApp, managedTarget, managedCheckRunId, labelled(checkResultForOutcome(outcome)),
          finalRun ? { reviewHeading: FINAL_REVIEW_HEADING } : {});
      } catch (err) {
        console.error(`[review] could not complete check ${managedCheckRunId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return outcome;
  } catch (err) {
    // A run that failed after spending tokens (a step-limit stop, say) still counts against the day.
    const spent = (err as { tokens?: unknown } | null)?.tokens;
    if (!tokensCounted && typeof spent === 'number' && spent > 0 && config.limits.dailyTokens) {
      await store.incrCounter(counterKey('tokens', dayKey()), spent).catch(() => {});
    }
    if (githubApp && managedCheckRunId !== undefined) {
      try {
        await completeReviewCheck(auth, githubApp, managedTarget, managedCheckRunId, labelled(checkResultForError(err, config)));
      } catch (updateErr) {
        console.error(`[review] could not complete check ${managedCheckRunId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`);
      }
    }
    // A final review that reached a decision spent this head's final review even if
    // the job failed afterwards. One that failed before a decision posted no verdict,
    // so the head gets it back: the counter is refunded and the claim released below.
    if (finalRun && decided) await store.mark(finalKey);
    else if (finalRun) {
      try {
        await runQueuedForRepo(config, `_review-budget/${repo}`, () => refundFinalReview(store, prNumber, pr.head.sha));
        console.log(`[review] ${key}: final review failed before a decision; refunded, retry with --final`);
      } catch (refundErr) {
        console.error(`[review] ${key}: could not refund the final review: ${refundErr instanceof Error ? refundErr.message : String(refundErr)}`);
      }
    }
    if (!opts.force) await store.unclaim(claimKey);                                             // release the claim so a transient failure can be retried
    throw err;
  } finally {
    await store.close();
  }
}

/** On-demand single learn pass (CLI `revuto learn <repo>`). */
export async function learnOnce(config: ReviewerConfig, settings: ReviewerSettings): Promise<LearnJobResult> {
  return learnRepo(config, settings);
}
