/**
 * Re-reviews look at what changed since revuto's last review of the PR.
 *
 * The last reviewed head is the commit of revuto's newest signed review, by
 * revuto's own login, on an earlier head. When that commit is still an ancestor
 * of the new head, the re-review gets the range `<last>..<head>` limited to the
 * PR's files (so a merge from the base branch does not count) and is routed by
 * that size. Any other case (no earlier review, a force-push that rewrote it, a
 * git failure) is a full review.
 */
import type { FileChange } from './workspace.js';

/** Hidden sentinel at the top of everything revuto posts (see `signReviewBody`). */
export const REVUTO_SIGNATURE_MARK = '<!-- revuto-signed -->';

export interface IncrementalReview {
  /** The head revuto reviewed last. */
  readonly fromSha: string;
  /** `<fromSha>..<headSha>`. */
  readonly range: string;
  /** Changes since `fromSha`, in the PR's files only. */
  readonly fileChanges: readonly FileChange[];
}

export interface PriorReview {
  /** Login of the review's author. */
  readonly user?: string | null;
  readonly commitId?: string | null;
  readonly body?: string | null;
  readonly submittedAt?: string | null;
}

const normalizeLogin = (login: string) => login.trim().replace(/\[bot\]$/, '').toLowerCase();

/**
 * The newest signed review on a head other than `headSha` written by one of
 * `reviewerLogins`. The signature alone proves nothing: anyone can paste it.
 */
export function lastReviewedHead(reviews: readonly PriorReview[], headSha: string, reviewerLogins: readonly string[]): string | undefined {
  const logins = new Set(reviewerLogins.filter((l) => l.trim()).map(normalizeLogin));
  if (logins.size === 0) return undefined;
  const prior = reviews
    .filter((r) => r.user && logins.has(normalizeLogin(r.user)))
    .filter((r) => r.commitId && /^[a-f0-9]{40}$/.test(r.commitId) && r.commitId !== headSha && (r.body ?? '').includes(REVUTO_SIGNATURE_MARK))
    .sort((a, b) => Date.parse(b.submittedAt ?? '') - Date.parse(a.submittedAt ?? ''));
  return prior[0]?.commitId ?? undefined;
}

/** Parse `git diff --numstat -z --no-renames`; binary files (`-`) count as zero lines. */
export function parseNumstat(text: string): FileChange[] {
  return text.split('\0').filter((record) => record.trim()).map((record) => {
    const [additions, deletions, ...path] = record.split('\t');
    return { path: path.join('\t'), additions: Number(additions) || 0, deletions: Number(deletions) || 0 };
  });
}

/** Runs git and returns stdout; rejects on a non-zero exit. */
export type GitRunner = (args: string[], discard?: boolean) => Promise<string>;

const names = async (git: GitRunner, range: string): Promise<string[]> =>
  (await git(['diff', '--name-only', '-z', '--no-renames', range])).split('\0').filter(Boolean);

/**
 * Paths a re-review covers: the files the PR changes now, plus the files it
 * changed at the reviewed head. The second set keeps a file the PR has since
 * reverted to the base version, which drops out of the PR's own file list.
 * A merge from the base branch adds neither.
 */
export async function reReviewPaths(git: GitRunner, mergeBaseSha: string, fromSha: string, headSha: string): Promise<string[]> {
  const fromBase = (await git(['merge-base', fromSha, mergeBaseSha])).trim();
  const paths = new Set([...await names(git, `${mergeBaseSha}..${headSha}`), ...await names(git, `${fromBase}..${fromSha}`)]);
  return [...paths].sort();
}

export interface IncrementalInput {
  readonly reviews: readonly PriorReview[];
  readonly headSha: string;
  readonly mergeBaseSha: string;
  /** revuto's own login(s); a review by anyone else never marks a head as reviewed. */
  readonly reviewerLogins: readonly string[];
  readonly git: GitRunner;
}

/** The range since revuto's last review, or undefined when the re-review must be a full one. */
export async function findIncrementalReview(input: IncrementalInput): Promise<IncrementalReview | undefined> {
  const fromSha = lastReviewedHead(input.reviews, input.headSha, input.reviewerLogins);
  if (!fromSha) return undefined;
  try {
    await input.git(['fetch', '--filter=tree:0', 'origin', fromSha]);
    await input.git(['merge-base', '--is-ancestor', fromSha, input.headSha]);
    const range = `${fromSha}..${input.headSha}`;
    const paths = await reReviewPaths(input.git, input.mergeBaseSha, fromSha, input.headSha);
    if (paths.length === 0) return { fromSha, range, fileChanges: [] };
    const pathspecs = paths.map((path) => `:(literal)${path}`);
    const fileChanges = parseNumstat(await input.git(['diff', '--numstat', '-z', '--no-renames', range, '--', ...pathspecs]));
    // The reviewer runs without credentials; fetch the blobs it will diff now.
    await input.git(['diff', '--no-ext-diff', '--no-textconv', range, '--', ...pathspecs], true);
    return { fromSha, range, fileChanges };
  } catch {
    return undefined;
  }
}
