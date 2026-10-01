/**
 * Re-reviews look at what changed since revuto's last review of the PR.
 *
 * The last reviewed head is the commit of revuto's newest signed review on an
 * earlier head. When that commit is still an ancestor of the new head, the
 * re-review gets the range `<last>..<head>` limited to the PR's own files (so a
 * merge from the base branch does not count) and is routed by that size. Any
 * other case (no earlier review, a force-push that rewrote it, a file list cut
 * at one page) is a full review.
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
  readonly commitId?: string | null;
  readonly body?: string | null;
  readonly submittedAt?: string | null;
}

/** revuto's newest signed review on a head other than `headSha`, if any. */
export function lastReviewedHead(reviews: readonly PriorReview[], headSha: string): string | undefined {
  const prior = reviews
    .filter((r) => r.commitId && /^[a-f0-9]{40}$/.test(r.commitId) && r.commitId !== headSha && (r.body ?? '').includes(REVUTO_SIGNATURE_MARK))
    .sort((a, b) => Date.parse(b.submittedAt ?? '') - Date.parse(a.submittedAt ?? ''));
  return prior[0]?.commitId ?? undefined;
}

/** Parse `git diff --numstat` output; binary files (`-`) count as zero lines. */
export function parseNumstat(text: string): FileChange[] {
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    const [additions, deletions, ...path] = line.split('\t');
    return { path: path.join('\t'), additions: Number(additions) || 0, deletions: Number(deletions) || 0 };
  });
}

export interface IncrementalInput {
  readonly reviews: readonly PriorReview[];
  readonly headSha: string;
  /** The PR's changed files as GitHub listed them. */
  readonly prFiles: readonly string[];
  /** The PR's own changed-file count; a longer count than the list means the list was cut. */
  readonly changedFiles: number;
  /** Runs git in the repository that holds the PR head; rejects on a non-zero exit. */
  readonly git: (args: string[], discard?: boolean) => Promise<string>;
}

/** The range since revuto's last review, or undefined when the re-review must be a full one. */
export async function findIncrementalReview(input: IncrementalInput): Promise<IncrementalReview | undefined> {
  const fromSha = lastReviewedHead(input.reviews, input.headSha);
  if (!fromSha) return undefined;
  if (input.prFiles.length < input.changedFiles) return undefined;
  try {
    await input.git(['fetch', '--filter=tree:0', 'origin', fromSha]);
    await input.git(['merge-base', '--is-ancestor', fromSha, input.headSha]);
  } catch {
    return undefined;
  }
  const range = `${fromSha}..${input.headSha}`;
  if (input.prFiles.length === 0) return { fromSha, range, fileChanges: [] };
  const paths = input.prFiles.map((file) => `:(literal)${file}`);
  const fileChanges = parseNumstat(await input.git(['diff', '--numstat', '--no-renames', range, '--', ...paths]));
  // The reviewer runs without credentials; fetch the blobs it will diff now.
  await input.git(['diff', '--no-ext-diff', '--no-textconv', range, '--', ...paths], true);
  return { fromSha, range, fileChanges };
}
