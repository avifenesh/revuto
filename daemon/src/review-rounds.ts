
import type { KnowledgeStore } from '../../agents/common/src/store/store.js';
import type { GithubAuth } from '../../agents/common/src/github-auth.js';

type CounterStore = Pick<KnowledgeStore, 'getCounter' | 'incrCounter'>;

/** Title of the one review a PR head may get after its round cap (`revuto review --final`). */
export const FINAL_REVIEW_HEADING = 'Revuto final review (round cap reached)';

/** Per-repo daily counters (`reviews`, `learn`, `tokens`), keyed by UTC day. */
export const counterKey = (name: 'reviews' | 'learn' | 'tokens', day: string): string => `${name}:${day}`;

/** Count signed reviews by the configured reviewer, including earlier commits. */
export async function historicalReviewRounds(auth: GithubAuth, repo: string, prNumber: number, previousLogin?: string): Promise<number> {
  const login = auth.login ?? (await auth.octokit.users.getAuthenticated()).data.login;
  // Exact logins: a plain account named like the App (without "[bot]") must not count as it.
  const logins = new Set([login, previousLogin].filter((s): s is string => !!s).map((l) => l.toLowerCase()));
  const [owner, name] = repo.split('/');
  const reviews = await auth.octokit.paginate(auth.octokit.pulls.listReviews, { owner: owner!, repo: name!, pull_number: prNumber, per_page: 100 });
  const ours = (r: (typeof reviews)[number]): boolean => {
    const who = r.user?.login?.toLowerCase();
    if (!who || !logins.has(who)) return false;
    return !who.endsWith('[bot]') || r.user?.type === 'Bot';
  };
  return new Set(reviews.filter(r => r.submitted_at && ours(r) && r.body?.includes('<!-- revuto-signed -->')).map(r => r.id)).size;
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('review.maxRounds must be a positive integer');
}

/** Rounds this PR has used, seeded once from GitHub history when the store has none. */
async function seededRounds(store: CounterStore, prNumber: number, historical: () => Promise<number>): Promise<number> {
  const key = `review-rounds:${prNumber}`;
  let used = await store.getCounter(key);
  if (used === 0) {
    const prior = await historical();
    if (prior > 0) used = await store.incrCounter(key, prior);
  }
  return used;
}

/** True when the PR has no normal round left. Reserves nothing. */
export async function roundCapReached(store: CounterStore, prNumber: number, limit: number, historical: () => Promise<number>): Promise<boolean> {
  assertLimit(limit);
  return (await seededRounds(store, prNumber, historical)) >= limit;
}

/** Reserve before running the model, so errors and --force cannot create endless retries. */
export async function reserveReviewRound(store: CounterStore, prNumber: number, limit: number,
  historical: () => Promise<number>): Promise<{ allowed: boolean; round: number; reason: string }> {
  assertLimit(limit);
  const key = `review-rounds:${prNumber}`;
  let used = await seededRounds(store, prNumber, historical);
  if (used < limit) used = await store.incrCounter(key);
  else return { allowed: false, round: used, reason: `PR #${prNumber} reached the ${limit}-round review limit (${used} prior rounds). Automatic review/fix cycles stop here; remaining findings require manual review. This is not an approval.` };
  return { allowed: used <= limit, round: used,
    reason: used <= limit ? `Review round ${used}/${limit}` : `PR #${prNumber} reached the ${limit}-round review limit. Automatic review stops; this is not an approval.` };
}

export interface ReviewReservation {
  readonly allowed: boolean;
  readonly round: number;
  readonly reason: string;
  /** The reservation is the one review past the round cap (`--final`), not a normal round. */
  readonly final: boolean;
  /** Refused by a daily limit: nothing was spent, so the head may be retried later. */
  readonly daily: boolean;
}

/**
 * The one review a PR head may get after the round cap: one per head SHA, a new head
 * gets its own. Reserved before the model runs. A run that reaches a terminal decision
 * spends it; a run that fails before one gets it back through `refundFinalReview`.
 * Below the cap it is an ordinary round and spends one, and rounds are never refunded.
 */
export async function reserveFinalReview(store: CounterStore, prNumber: number, headSha: string, limit: number,
  historical: () => Promise<number>): Promise<Omit<ReviewReservation, 'daily'>> {
  const round = await reserveReviewRound(store, prNumber, limit, historical);
  if (round.allowed) return { ...round, final: false };
  const used = await store.incrCounter(finalReviewKey(prNumber, headSha));
  return used === 1
    ? { allowed: true, round: round.round, final: true,
        reason: `Final review of PR #${prNumber} at ${headSha.slice(0, 7)}, requested after the ${limit}-round review limit` }
    : { allowed: false, round: round.round, final: true, reason: finalReviewUsedReason(prNumber, headSha) };
}

const finalReviewKey = (prNumber: number, headSha: string): string => `final-review:${prNumber}:${headSha}`;

/** True once this head's final review was reserved and not refunded (it runs, or it reached a decision). */
export async function finalReviewUsed(store: Pick<KnowledgeStore, 'getCounter'>, prNumber: number, headSha: string): Promise<boolean> {
  return (await store.getCounter(finalReviewKey(prNumber, headSha))) > 0;
}

/**
 * Give a head its final review back after a run that failed before a terminal decision
 * (nothing was posted as a verdict). Only one run of a head holds the reservation at a
 * time, and refused reservations never ran, so the counter is cleared, not decremented.
 */
export async function refundFinalReview(store: Pick<KnowledgeStore, 'resetCounter'>, prNumber: number, headSha: string): Promise<void> {
  await store.resetCounter(finalReviewKey(prNumber, headSha));
}

export function finalReviewUsedReason(prNumber: number, headSha: string): string {
  return `PR #${prNumber} already had its final review at ${headSha.slice(0, 7)}. A final review runs once per head after the round limit; push a new head to request another. This is not an approval.`;
}

export interface ReviewBudgetRequest {
  readonly prNumber: number;
  readonly headSha: string;
  /** `review.maxRounds`. */
  readonly maxRounds: number;
  /** `revuto review --final`: allow one review of this head past the round cap. */
  readonly final?: boolean;
  /** UTC day key for the daily counters. */
  readonly day: string;
  readonly dailyReviews?: number;
  readonly dailyTokens?: number;
  /** Max review runs per PR author per day (0 or unset = unlimited). */
  readonly dailyReviewsPerAuthor?: number;
  /** The PR author's login, for the per-author cap. */
  readonly author?: string;
  /**
   * The author has write access. Their PRs are counted but never refused by a daily
   * cap, so someone without access who spends the budget cannot block maintainers.
   */
  readonly maintainer?: boolean;
  readonly historical: () => Promise<number>;
}

/**
 * Everything a review run must clear before the model starts: the daily review and
 * token limits, then a round (or, with `final`, the one review past the cap). The
 * daily limits come first, so a refusal there spends no round and no final review.
 */
export async function reserveReviewBudget(store: CounterStore, req: ReviewBudgetRequest): Promise<ReviewReservation> {
  const authorKey = req.author ? `reviews-author:${req.author.toLowerCase()}:${req.day}` : undefined;
  if (!req.maintainer) {
    if (req.dailyReviews && await store.getCounter(counterKey('reviews', req.day)) >= req.dailyReviews) {
      return { allowed: false, round: 0, reason: 'Daily review limit reached', final: false, daily: true };
    }
    if (req.dailyTokens && await store.getCounter(counterKey('tokens', req.day)) >= req.dailyTokens) {
      return { allowed: false, round: 0, reason: 'Daily token limit reached', final: false, daily: true };
    }
    if (req.dailyReviewsPerAuthor && authorKey && await store.getCounter(authorKey) >= req.dailyReviewsPerAuthor) {
      return { allowed: false, round: 0, reason: `Daily review limit for ${req.author} reached`, final: false, daily: true };
    }
  }
  const reserved = req.final
    ? await reserveFinalReview(store, req.prNumber, req.headSha, req.maxRounds, req.historical)
    : { ...(await reserveReviewRound(store, req.prNumber, req.maxRounds, req.historical)), final: false };
  if (reserved.allowed && req.dailyReviews) await store.incrCounter(counterKey('reviews', req.day));
  if (reserved.allowed && req.dailyReviewsPerAuthor && authorKey) await store.incrCounter(authorKey);
  return { ...reserved, daily: false };
}
