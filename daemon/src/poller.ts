/**
 * GitHub polling. Local has no public webhook, so each cron tick polls the
 * delta since the per-repo cursor:
 *   - pollOpenPRs:  open PRs updated since the review cursor (→ review).
 *   - pollFeedback: human replies to the reviewer's own review comments since
 *     the learn cursor, noise-filtered (→ learn).
 */
import type { Octokit } from '@octokit/rest';
import { classifyCommentBody } from '../../webhook/src/heuristics.js';
import type { FeedbackEvent } from '../../agents/curator/src/run-curator.js';

export interface OpenPR {
  readonly number: number;
  readonly author: string;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly isBot: boolean;
}

/** Retry a GitHub call on primary/secondary rate limits, honoring reset headers + jitter. */
async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const headers = err?.response?.headers ?? {};
      const secondary = /secondary rate limit/i.test(err?.message ?? '');
      const rateLimited = status === 403 || status === 429;
      if (!rateLimited || attempt >= maxRetries) throw err;

      const retryAfter = Number(headers['retry-after']);
      const reset = Number(headers['x-ratelimit-reset']);
      let waitMs: number;
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000;
      else if (Number.isFinite(reset) && reset > 0) waitMs = Math.max(0, reset * 1000 - Date.now());
      else waitMs = 1000 * 2 ** attempt;
      waitMs = Math.min(waitMs, 60_000) + Math.floor(Math.random() * 1000); // jitter

      console.warn(`[poller] ${label} rate-limited (status=${status}${secondary ? ', secondary' : ''}); retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Open PRs with updated_at strictly after `sinceISO` (all open PRs if unset). */
export async function pollOpenPRs(octokit: Octokit, repo: string, sinceISO?: string): Promise<OpenPR[]> {
  const [owner, name] = repo.split('/');
  const since = sinceISO ? Date.parse(sinceISO) : 0;
  const out: OpenPR[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await withRateLimitRetry(
      () => octokit.pulls.list({ owner, repo: name, state: 'open', sort: 'updated', direction: 'desc', per_page: 100, page }),
      'pulls.list',
    );
    if (data.length === 0) break;
    let stop = false;
    for (const pr of data) {
      if (Date.parse(pr.updated_at) <= since) { stop = true; break; }
      const login = pr.user?.login ?? '';
      const isBot = pr.user?.type === 'Bot' || /\[bot\]$/i.test(login);
      out.push({ number: pr.number, author: login, headSha: pr.head.sha, updatedAt: pr.updated_at, isBot });
    }
    if (stop || data.length < 100) break;
  }
  return out;
}

function prNumberFromUrl(url: string): number {
  const m = url.match(/\/pulls\/(\d+)/) ?? url.match(/\/issues\/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Human replies to the reviewer's review comments, created since `sinceISO`,
 * with noise filtered out. Each becomes a FeedbackEvent the curator can learn
 * from; `botComment` is the reviewer's parent comment being replied to.
 */
export async function pollFeedback(
  octokit: Octokit,
  repo: string,
  botLogin: string,
  sinceISO?: string,
): Promise<FeedbackEvent[]> {
  const [owner, name] = repo.split('/');
  const since = sinceISO ?? new Date(0).toISOString();
  const comments = (await withRateLimitRetry(
    () => octokit.paginate(octokit.pulls.listReviewCommentsForRepo, { owner, repo: name, sort: 'created', direction: 'asc', since, per_page: 100 }),
    'listReviewCommentsForRepo',
  )) as Array<any>;

  const out: FeedbackEvent[] = [];
  for (const c of comments) {
    const body: string = c.body ?? '';
    if (!body.trim()) continue;
    if ((c.user?.login ?? '') === botLogin) continue;        // skip the reviewer's own comments
    if (!c.in_reply_to_id) continue;                          // only thread replies
    if (classifyCommentBody(body).noise) continue;            // drop ack/ditto/emoji/etc.

    let parentLogin = '';
    let parentBody = '';
    try {
      const parent = await withRateLimitRetry(
        () => octokit.pulls.getReviewComment({ owner, repo: name, comment_id: c.in_reply_to_id }),
        'getReviewComment',
      );
      parentLogin = parent.data.user?.login ?? '';
      parentBody = parent.data.body ?? '';
    } catch {
      continue;
    }
    if (parentLogin !== botLogin) continue;                   // only replies to the reviewer

    out.push({
      feedbackId: `rc-${c.id}`,
      kind: 'review_comment_reply',
      body,
      botComment: {
        body: parentBody,
        path: c.path,
        line: c.line ?? undefined,
        prNumber: prNumberFromUrl(c.pull_request_url ?? ''),
        repo,
      },
      actor: c.user?.login,
      touchedFiles: c.path ? [c.path] : [],
    });
  }
  return out;
}
