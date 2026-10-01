/**
 * Two admission decisions made before a review runs:
 *
 * 1. Is the repository on the ignore list? (`github.app.ignoredRepos`). Such a PR
 *    is never enqueued, never counted against any limit, and gets no check run.
 * 2. Which review tier handles this PR? A docs-only or small diff goes to
 *    `models.reviewSmall`, a diff with few changed code lines to
 *    `models.reviewMedium`, everything else to `models.review`. A tier with no
 *    configured model falls through to the next one.
 *
 * Both are pure functions of the config plus data the daemon already holds, so
 * they are unit-tested without a network.
 */
import { DEFAULT_MEDIUM_REVIEW, DEFAULT_SMALL_REVIEW, type ModelSpec, type ReviewerConfig, type SmallReviewConfig } from './config.js';
import type { FileChange } from './workspace.js';

/** True when `repo` ("owner/name") matches an ignore entry: an exact full name or "owner/*". Case-insensitive. */
export function repoIgnored(ignoredRepos: readonly string[] | undefined, repo: string): boolean {
  if (!ignoredRepos?.length) return false;
  const full = repo.trim().toLowerCase();
  const owner = full.split('/')[0] ?? '';
  return ignoredRepos.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e.endsWith('/*')) return e.slice(0, -2) === owner;
    return e === full;
  });
}

const ignoredLogged = new Set<string>();

/**
 * Log "skipped: repo ignored" once per PR (or once per repo when no PR is given),
 * so a poller ticking every few minutes does not repeat itself. Returns true the
 * first time, false afterwards.
 */
export function logIgnoredOnce(repo: string, prNumber?: number, source = 'review'): boolean {
  const key = prNumber === undefined ? repo : `${repo}#${prNumber}`;
  if (ignoredLogged.has(key)) return false;
  ignoredLogged.add(key);
  console.log(`[${source}] ${key}: skipped: repo ignored (github.app.ignoredRepos)`);
  return true;
}

/** Test hook: forget which ignored PRs were already logged. */
export function resetIgnoredLog(): void {
  ignoredLogged.clear();
}

/** A file counts as documentation when its extension or its path prefix says so. */
export function isDocsFile(path: string, small: SmallReviewConfig): boolean {
  const p = path.trim().toLowerCase();
  if (!p) return false;
  if (small.docsExtensions.some((ext) => p.endsWith(ext.toLowerCase()))) return true;
  return small.docsPaths.some((prefix) => {
    const pre = prefix.toLowerCase();
    return p.startsWith(pre) || p.includes(`/${pre}`);
  });
}

export interface RouteInput {
  /** Changed file paths as listed by GitHub; one page, so possibly shorter than `changedFiles`. */
  readonly fileList: readonly string[];
  /** Per-file line counts for `fileList`. Absent = code lines fall back to the PR total. */
  readonly fileChanges?: readonly FileChange[];
  readonly additions: number;
  readonly deletions: number;
  /** The PR's own changed-file count (`pr.changed_files`). Absent = trust `fileList` as complete. */
  readonly changedFiles?: number;
}

export type ReviewTier = 'small' | 'medium' | 'large';

export interface ReviewRoute {
  readonly spec: ModelSpec;
  readonly tier: ReviewTier;
  /** True when `models.reviewSmall` was chosen. */
  readonly small: boolean;
  /** Human-readable label for the daemon log. */
  readonly label: string;
  readonly reason: string;
}

/** The label a review is signed with: the spec's `name`, else its model id. */
export function modelLabel(spec: ModelSpec): string {
  return (spec.name?.trim() || spec.model).trim();
}

/** Test sources and fixtures: test directories, `*.test.*` / `*.spec.*`, `*_test.*`. */
export function isTestFile(path: string): boolean {
  const p = path.trim().toLowerCase();
  if (!p) return false;
  if (/(^|\/)(tests?|__tests__|spec|specs|testdata|fixtures)\//.test(p)) return true;
  return /[._-](test|spec)\.[a-z0-9]+$/.test(p) || /_test\.[a-z0-9]+$/.test(p);
}

/**
 * Changed lines in files that are neither documentation nor tests. Without
 * per-file counts for the whole list, the PR total stands in, which can only
 * push a PR to a bigger tier.
 */
export function changedCodeLines(input: RouteInput, small: SmallReviewConfig): number {
  const files = input.fileList.filter((f) => f.trim());
  const changes = input.fileChanges;
  if (!changes || changes.length < files.length) return Math.max(0, input.additions) + Math.max(0, input.deletions);
  return changes
    .filter((c) => !isDocsFile(c.path, small) && !isTestFile(c.path))
    .reduce((sum, c) => sum + Math.max(0, c.additions) + Math.max(0, c.deletions), 0);
}

/**
 * Pick the review tier for one PR, from data the daemon already holds.
 *
 * - small (`models.reviewSmall`): every changed file is documentation (with
 *   `review.small.docsOnly`), or the diff is at most `review.small.maxChangedLines`.
 * - medium (`models.reviewMedium`): at most `review.medium.maxCodeLines` changed
 *   code lines (docs and tests excluded).
 * - large (`models.review`): everything else, and any PR whose size is unknown.
 *
 * A tier without a configured model falls through to the next one. When the
 * medium rule matches but `models.reviewMedium` is unset, the reason says so,
 * so the daemon log shows what the medium tier would take before it is enabled.
 */
export function chooseReviewModel(config: ReviewerConfig, input: RouteInput): ReviewRoute {
  const full = config.models.review;
  const large = (reason: string): ReviewRoute => ({ spec: full, tier: 'large', small: false, label: modelLabel(full), reason });
  const smallSpec = config.models.reviewSmall;
  const mediumSpec = config.models.reviewMedium;
  const small = config.review.small ?? DEFAULT_SMALL_REVIEW;
  const medium = config.review.medium ?? DEFAULT_MEDIUM_REVIEW;
  const changed = Math.max(0, input.additions) + Math.max(0, input.deletions);
  const files = input.fileList.filter((f) => f.trim());
  // GitHub returns one page of files (100), so a long PR's list is a prefix of the
  // truth: the docs-only rule needs the whole list, and a size of 0 with files in
  // it means the size fields were missing, not that the diff is empty. Either way
  // the answer is the full model.
  const listComplete = input.changedFiles === undefined || files.length >= input.changedFiles;
  const sizeKnown = changed > 0 || (input.changedFiles ?? files.length) === 0;
  if (!listComplete) return large(`file list truncated (${files.length} of ${input.changedFiles} files listed)`);
  if (!sizeKnown) return large(`diff size unknown for ${files.length} file(s)`);
  if (smallSpec) {
    const route = (reason: string): ReviewRoute => ({ spec: smallSpec, tier: 'small', small: true, label: modelLabel(smallSpec), reason });
    if (small.docsOnly && files.length > 0 && files.every((f) => isDocsFile(f, small))) return route(`docs only (${files.length} file(s))`);
    if (small.maxChangedLines > 0 && changed <= small.maxChangedLines) return route(`small diff (${changed} <= ${small.maxChangedLines} changed lines)`);
  }
  const code = changedCodeLines(input, small);
  const size = `${changed} changed lines, ${code} in code, across ${files.length} file(s)`;
  if (medium.maxCodeLines > 0 && code <= medium.maxCodeLines) {
    if (mediumSpec) return { spec: mediumSpec, tier: 'medium', small: false, label: modelLabel(mediumSpec), reason: `${size} (<= ${medium.maxCodeLines} code lines)` };
    return large(`${size}; the medium tier would take it, but models.reviewMedium is not set`);
  }
  return large(size);
}

/** The config with `models.review` replaced by the routed spec, for code paths that read `config.models.review`. */
export function withReviewModel(config: ReviewerConfig, spec: ModelSpec): ReviewerConfig {
  if (spec === config.models.review) return config;
  return { ...config, models: { ...config.models, review: spec } };
}
