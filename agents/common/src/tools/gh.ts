import { z } from 'zod';
import { tool } from '../tool-def.js';
import type { Octokit } from '@octokit/rest';
import type { PrContext } from '../workspace.js';
import { REVUTO_SIGNATURE_MARK } from '../incremental.js';
import { sanitizeOutbound } from '../outbound.js';

/** GitHub rejects a review body or comment over 65,536 characters. */
const MAX_POST_CHARS = 60_000;
/** More inline comments than this is noise, or a model posting on someone's behalf. */
const MAX_INLINE_COMMENTS = 50;

/** Model text as it may leave: defused, redacted, within GitHub's size limit. */
function outbound(text: string): string {
  const clean = sanitizeOutbound(text);
  return clean.length > MAX_POST_CHARS ? `${clean.slice(0, MAX_POST_CHARS)}\n\n[truncated]` : clean;
}



export interface GhToolsDeps {
  /** Resolved per call - see GithubAuth.token: a review outlives its token. */
  readonly token: () => Promise<string>;
  readonly ctx: PrContext;
  readonly octokit: Octokit;
}

/** The revuto engine repo — the attribution header links here. */
const REVUTO_URL = 'https://github.com/avifenesh/revuto';
/** Hidden HTML-comment sentinel (invisible when rendered) used to detect an already-signed body. */
const SIGNATURE_MARK = REVUTO_SIGNATURE_MARK;
const SIGNATURE = `${SIGNATURE_MARK}\n*This is an auto review done by [revuto](${REVUTO_URL}).*`;

/**
 * Prefix the attribution header to anything revuto posts, so every comment is
 * marked as an automated review. Idempotent — detected via the hidden sentinel.
 * The footer never names the model behind the review.
 */
export function signReviewBody(body: string): string {
  if (body.includes(SIGNATURE_MARK)) return body;
  return body.trim() ? `${SIGNATURE}\n\n---\n\n${body}` : SIGNATURE;
}

/** The body revuto posted, without its attribution header (for quoting it back as context). */
export function unsignReviewBody(body: string): string {
  if (!body.startsWith(SIGNATURE)) return body.replaceAll(SIGNATURE_MARK, '').trim();
  return body.slice(SIGNATURE.length).replace(/^\s*---\s*/, '').trim();
}

/** Put `heading` in bold on top of a review summary; the body is unchanged without one. */
export function withReviewHeading(body: string, heading?: string): string {
  const title = heading?.trim();
  if (!title) return body;
  return body.trim() ? `**${title}**\n\n${body}` : `**${title}**`;
}

interface InlineComment {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}


/**
 * Error code for a `post_review` the empty-review guard turned away. The engine
 * tells this apart from a posting call that failed with content in hand: this one
 * dropped nothing, so a `skip_review` after it is still a clean decision.
 */
export const POST_REVIEW_NO_COMMENTS_CODE = 'no_inline_comments';

/** True for the one posting failure that lost nothing: an empty review, refused. */
export function refusedEmptyReview(payload: unknown): boolean {
  return typeof payload === 'string' && payload.includes(`ERROR ${POST_REVIEW_NO_COMMENTS_CODE}:`);
}

/**
 * Post the review. Atomic: one call, summary body + N inline comments.
 * Mirrors POST /repos/:o/:r/pulls/:n/reviews exactly.
 */
export function buildPostReviewTool(deps: GhToolsDeps) {
  let posted = false;
  return tool({
    name: 'post_review',
    description:
`Post the final PR review atomically. Exactly one successful call per invocation. If you call this more than once, subsequent calls return an error.

Supply:
- \`body\`: the summary body (markdown). Can be empty if every point is inline.
- \`comments\`: an array of inline comments, and it must not be empty. Each item: { path, line, side?, body }. \`line\` is 1-indexed in the RIGHT file (side: "RIGHT" default). Use \`start_line\` + \`line\` for multi-line comments. Anchor only to lines present in the PR diff. A review with no anchored finding is refused: call \`skip_review\` for a clean diff, and anchor a concern you cannot place exactly to the nearest changed line instead of leaving it in the body alone.

The review is posted as event="COMMENT". REQUEST_CHANGES and APPROVE are not available to the model. If no issues, call \`skip_review\`; the GitHub App will submit a clean approval after the review run succeeds.

The review is anchored at the PR head SHA already loaded in the workspace context (${deps.ctx.headSha}). You do not pass it.`,
    inputSchema: z.object({
      body: z.string(),
      comments: z.array(z.object({
        path: z.string(),
        line: z.number().int().positive(),
        side: z.enum(['LEFT', 'RIGHT']).optional(),
        start_line: z.number().int().positive().optional(),
        start_side: z.enum(['LEFT', 'RIGHT']).optional(),
        body: z.string(),
      })).default([]),
    }),
    callback: async (input) => {
      // A post with nothing anchored is not a findings review, and the check has no
      // way to tell a "nothing to flag" body from one carrying concerns — so it read
      // the call itself as findings and failed the check on a clean review. The clean
      // path is `skip_review`, which is what lets the App submit the approval.
      if (input.comments.length === 0) {
        return `ERROR ${POST_REVIEW_NO_COMMENTS_CODE}: post_review needs at least one inline comment. If the diff is clean, call skip_review instead. If a concern cannot be placed exactly, anchor it to the nearest changed line and explain the scope in the comment body.`;
      }
      if (posted) return 'ERROR post_review: the review is already posted; one review per run.';
      if (input.comments.length > MAX_INLINE_COMMENTS) {
        return `ERROR post_review: ${input.comments.length} inline comments; at most ${MAX_INLINE_COMMENTS}. Merge related findings.`;
      }
      // Claimed before the request, so two calls in one step cannot both post.
      posted = true;
      try {
        const resp = await deps.octokit.pulls.createReview({
          owner: deps.ctx.owner,
          repo: deps.ctx.repo,
          pull_number: deps.ctx.prNumber,
          commit_id: deps.ctx.headSha,
          event: 'COMMENT',
          body: signReviewBody(withReviewHeading(outbound(input.body), deps.ctx.reviewHeading)),
          comments: (input.comments as InlineComment[]).map((c) => ({ ...c, body: signReviewBody(outbound(c.body)) })),
        });
        return JSON.stringify({
          ok: true,
          review_id: resp.data.id,
          url: resp.data.html_url,
          inline_comments: input.comments.length,
        });
      } catch (err: any) {
        posted = false;
        const status = err?.status ?? '?';
        const msg = err?.message ?? String(err);
        const errors = err?.response?.data?.errors;
        return `ERROR status=${status}: ${msg}\n${errors ? JSON.stringify(errors) : ''}`;
      }
    },
  });
}

export function buildPostIssueCommentTool(deps: GhToolsDeps) {
  let posted = false;
  return tool({
    name: 'post_issue_comment',
    description:
`Post a plain (non-inline) comment on the PR. Use this only for always-on check failures (DCO, commands.def regen missing, etc.) — for all substantive findings, use \`post_review\` with inline comments.`,
    inputSchema: z.object({ body: z.string().min(1) }),
    callback: async (input) => {
      if (posted) return 'ERROR post_issue_comment: one issue comment per run.';
      posted = true;
      try {
        const resp = await deps.octokit.issues.createComment({
          owner: deps.ctx.owner,
          repo: deps.ctx.repo,
          issue_number: deps.ctx.prNumber,
          body: signReviewBody(outbound(input.body)),
        });
        return JSON.stringify({ ok: true, comment_id: resp.data.id, url: resp.data.html_url });
      } catch (err: any) {
        posted = false;
        return `ERROR: ${err?.message ?? String(err)}`;
      }
    },
  });
}

/**
 * Agent signal for "no review warranted — silent exit". We still emit a
 * short issue-comment by default so the maintainer knows the reviewer
 * ran; pass \`post_marker: false\` to truly stay silent.
 */
export function buildSkipTool(deps: GhToolsDeps) {
  return tool({
    name: 'skip_review',
    description:
`Terminate the review with no posted content. Call this when the diff has no evidence-backed concerns AND nothing warrants an inline comment. Do NOT use this as cover for missing findings.

Posts nothing. Every run writes a local trace of its tool calls and results, so a skip is auditable after the fact: skipping without having inspected the diff fails the review check instead of passing it.`,
    inputSchema: z.object({
      reason: z.string().min(1).describe('One-sentence rationale; goes into logs, not GitHub.'),
    }),
    callback: async (input) => {
      return JSON.stringify({ ok: true, skipped: true, reason: input.reason, pr: `${deps.ctx.owner}/${deps.ctx.repo}#${deps.ctx.prNumber}` });
    },
  });
}
