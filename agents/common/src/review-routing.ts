/**
 * Two admission decisions made before a review runs:
 *
 * 1. Is the repository on the ignore list? (`github.app.ignoredRepos`). Such a PR
 *    is never enqueued, never counted against any limit, and gets no check run.
 * 2. Which review model handles this PR? A docs-only or small diff goes to
 *    `models.reviewSmall` when one is configured; everything else, and every PR
 *    when it is absent, goes to `models.review`.
 *
 * Both are pure functions of the config plus data the daemon already holds, so
 * they are unit-tested without a network.
 */
import { DEFAULT_SMALL_REVIEW, type ModelSpec, type ReviewerConfig, type SmallReviewConfig } from './config.js';

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
  readonly additions: number;
  readonly deletions: number;
  /** The PR's own changed-file count (`pr.changed_files`). Absent = trust `fileList` as complete. */
  readonly changedFiles?: number;
}

export interface ReviewRoute {
  readonly spec: ModelSpec;
  /** True when `models.reviewSmall` was chosen. */
  readonly small: boolean;
  /** Human-readable label for logs, the review footer and the check summary. */
  readonly label: string;
  readonly reason: string;
}

/** The label a review is signed with: the spec's `name`, else its model id. */
export function modelLabel(spec: ModelSpec): string {
  return (spec.name?.trim() || spec.model).trim();
}

/**
 * Pick the review model for one PR. `reviewSmall` wins when every changed file is
 * documentation (and `review.small.docsOnly` is on) or when the diff is at most
 * `review.small.maxChangedLines` lines (additions + deletions). Without a
 * `reviewSmall` model the answer is always `models.review`, so existing configs
 * behave exactly as before.
 */
export function chooseReviewModel(config: ReviewerConfig, input: RouteInput): ReviewRoute {
  const full = config.models.review;
  const smallSpec = config.models.reviewSmall;
  if (!smallSpec) return { spec: full, small: false, label: modelLabel(full), reason: 'no models.reviewSmall configured' };
  const small = config.review.small ?? DEFAULT_SMALL_REVIEW;
  const changed = Math.max(0, input.additions) + Math.max(0, input.deletions);
  const files = input.fileList.filter((f) => f.trim());
  // GitHub returns one page of files (100), so a long PR's list is a prefix of the
  // truth: the docs-only rule needs the whole list, and a size of 0 with files in
  // it means the size fields were missing, not that the diff is empty. Either way
  // the answer is the full model.
  const listComplete = input.changedFiles === undefined || files.length >= input.changedFiles;
  const sizeKnown = changed > 0 || (input.changedFiles ?? files.length) === 0;
  if (!listComplete) {
    return { spec: full, small: false, label: modelLabel(full), reason: `file list truncated (${files.length} of ${input.changedFiles} files listed)` };
  }
  if (!sizeKnown) {
    return { spec: full, small: false, label: modelLabel(full), reason: `diff size unknown for ${files.length} file(s)` };
  }
  if (small.docsOnly && files.length > 0 && files.every((f) => isDocsFile(f, small))) {
    return { spec: smallSpec, small: true, label: modelLabel(smallSpec), reason: `docs only (${files.length} file(s))` };
  }
  if (small.maxChangedLines > 0 && changed <= small.maxChangedLines) {
    return { spec: smallSpec, small: true, label: modelLabel(smallSpec), reason: `small diff (${changed} <= ${small.maxChangedLines} changed lines)` };
  }
  return { spec: full, small: false, label: modelLabel(full), reason: `${changed} changed lines across ${files.length} file(s)` };
}

/** The config with `models.review` replaced by the routed spec, for code paths that read `config.models.review`. */
export function withReviewModel(config: ReviewerConfig, spec: ModelSpec): ReviewerConfig {
  if (spec === config.models.review) return config;
  return { ...config, models: { ...config.models, review: spec } };
}
