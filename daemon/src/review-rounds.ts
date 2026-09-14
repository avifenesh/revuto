import type { KnowledgeStore } from '../../agents/common/src/store/store.js';
import type { GithubAuth } from '../../agents/common/src/github-auth.js';

/** Count signed reviews by the configured reviewer, including earlier commits. */
export async function historicalReviewRounds(auth: GithubAuth, repo: string, prNumber: number, previousLogin?: string): Promise<number> {
  const login = auth.login ?? (await auth.octokit.users.getAuthenticated()).data.login;
  const normalize = (value: string) => value.replace(/\[bot\]$/, '').toLowerCase();
  const logins = new Set([login, previousLogin].filter((s): s is string => !!s).map(normalize));
  const [owner, name] = repo.split('/');
  const reviews = await auth.octokit.paginate(auth.octokit.pulls.listReviews, { owner: owner!, repo: name!, pull_number: prNumber, per_page: 100 });
  return new Set(reviews.filter(r => r.submitted_at && r.user?.login && logins.has(normalize(r.user.login))
    && r.body?.includes('<!-- revuto-signed -->')).map(r => r.id)).size;
}

/** Reserve before running the model, so errors and --force cannot create endless retries. */
export async function reserveReviewRound(store: Pick<KnowledgeStore, 'getCounter' | 'incrCounter'>, prNumber: number, limit: number,
  historical: () => Promise<number>): Promise<{ allowed: boolean; round: number; reason: string }> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('review.maxRounds must be a positive integer');
  const key = `review-rounds:${prNumber}`;
  let used = await store.getCounter(key);
  if (used === 0) {
    const prior = await historical();
    if (prior > 0) used = await store.incrCounter(key, prior);
  }
  if (used < limit) used = await store.incrCounter(key);
  else return { allowed: false, round: used, reason: `PR #${prNumber} reached the ${limit}-round review limit (${used} prior rounds). Automatic review/fix cycles stop here; remaining findings require manual review. This is not an approval.` };
  return { allowed: used <= limit, round: used,
    reason: used <= limit ? `Review round ${used}/${limit}` : `PR #${prNumber} reached the ${limit}-round review limit. Automatic review stops; this is not an approval.` };
}
