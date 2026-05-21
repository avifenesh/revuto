import { spawn } from 'node:child_process';
import { z } from 'zod';
import { tool } from '../tool-def.js';
import type { Octokit } from '@octokit/rest';
import type { PrContext } from '../workspace.js';

function run(cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs: number; maxBytes: number }): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args as string[], { env: { ...process.env, ...opts.env } });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, opts.timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      if (out.length + b.length > opts.maxBytes) {
        child.kill('SIGTERM');
        return;
      }
      out = Buffer.concat([out, b]);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length + b.length > 64_000) return;
      err = Buffer.concat([err, b]);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.toString('utf8'), err: err.toString('utf8') });
    });
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Whitelisted `gh api` endpoint patterns. We run `gh api` (not `gh pr
 * view` etc.) and match the path against allowed shapes so the agent
 * can explore the REST surface without being able to mutate arbitrary
 * resources.
 */
const GH_API_READ_PATTERNS: ReadonlyArray<RegExp> = [
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/files(\?.*)?$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews(\?.*)?$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/\d+$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments(\?.*)?$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits(\?.*)?$/,
  /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments(\?.*)?$/,
  /^repos\/[^/]+\/[^/]+\/commits\/[a-f0-9]+$/,
  /^repos\/[^/]+\/[^/]+\/contents\/.+/,
  /^repos\/[^/]+\/[^/]+\/check-runs\/\d+$/,
  /^repos\/[^/]+\/[^/]+\/commits\/[a-f0-9]+\/check-runs(\?.*)?$/,
];

export interface GhToolsDeps {
  readonly token: string;
  readonly ctx: PrContext;
  readonly octokit: Octokit;
}

/** The revuto engine repo — the attribution footer links here. */
const REVUTO_URL = 'https://github.com/avifenesh/revuto';
const SIGNATURE = `\n\n---\n*This is an auto review done by [revuto](${REVUTO_URL}).*`;

/**
 * Append the attribution footer to anything revuto posts, so every comment is
 * marked as an automated review. Idempotent — skips if already signed.
 */
function sign(body: string): string {
  return body.includes(REVUTO_URL) ? body : `${body}${SIGNATURE}`;
}

interface InlineComment {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}

export function buildGhApiReadTool(deps: GhToolsDeps) {
  return tool({
    name: 'gh_api_read',
    description:
`Read from the GitHub REST API. Only GET is allowed, and only endpoint paths that match the reviewer's allowlist.

Allowed paths (pattern):
- repos/OWNER/REPO/pulls/NUMBER                          — PR object
- repos/OWNER/REPO/pulls/NUMBER/files                    — changed files + patch hunks (paginated)
- repos/OWNER/REPO/pulls/NUMBER/reviews                  — submitted reviews
- repos/OWNER/REPO/pulls/NUMBER/reviews/ID               — single review
- repos/OWNER/REPO/pulls/NUMBER/comments                 — inline review comments
- repos/OWNER/REPO/pulls/NUMBER/commits                  — PR commits
- repos/OWNER/REPO/issues/NUMBER/comments                — issue/PR comments
- repos/OWNER/REPO/commits/SHA                           — commit
- repos/OWNER/REPO/contents/PATH                         — file at ref
- repos/OWNER/REPO/commits/SHA/check-runs                — CI status
- repos/OWNER/REPO/check-runs/ID                         — CI detail

Do NOT include a leading slash. Append query strings inline, e.g. \`repos/OWNER/REPO/pulls/12/files?page=2&per_page=100\`.`,
    inputSchema: z.object({
      path: z.string().describe('API path without leading slash, e.g. "repos/OWNER/REPO/pulls/12"'),
    }),
    callback: async (input: { path: string }) => {
      const path = input.path.replace(/^\/+/, '');
      const matched = GH_API_READ_PATTERNS.some((r) => r.test(path));
      if (!matched) return `ERROR: path "${path}" is not on the allowlist.`;
      const r = await run('gh', ['api', path, '--method', 'GET'], {
        env: { GH_TOKEN: deps.token, GITHUB_TOKEN: deps.token },
        timeoutMs: 30_000,
        maxBytes: 2_000_000,
      });
      if (r.code !== 0) return `gh api failed (${r.code}): ${r.err}\n${r.out}`;
      return r.out;
    },
  });
}

/**
 * Post the review. Atomic: one call, summary body + N inline comments.
 * Mirrors POST /repos/:o/:r/pulls/:n/reviews exactly.
 */
export function buildPostReviewTool(deps: GhToolsDeps) {
  return tool({
    name: 'post_review',
    description:
`Post the final PR review atomically. Exactly one successful call per invocation. If you call this more than once, subsequent calls return an error.

Supply:
- \`body\`: the summary body (markdown). Can be empty if every point is inline.
- \`comments\`: an array of inline comments. Each item: { path, line, side?, body }. \`line\` is 1-indexed in the RIGHT file (side: "RIGHT" default). Use \`start_line\` + \`line\` for multi-line comments. Anchor only to lines present in the PR diff.

The review is posted as event="COMMENT". REQUEST_CHANGES and APPROVE are not available to the reviewer — block/approve decisions belong to humans. If no issues, call \`skip_review\` instead of posting an empty review.

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
      try {
        const resp = await deps.octokit.pulls.createReview({
          owner: deps.ctx.owner,
          repo: deps.ctx.repo,
          pull_number: deps.ctx.prNumber,
          commit_id: deps.ctx.headSha,
          event: 'COMMENT',
          body: sign(input.body),
          comments: (input.comments as InlineComment[]).map((c) => ({ ...c, body: sign(c.body) })),
        });
        return JSON.stringify({ ok: true, review_id: resp.data.id, url: resp.data.html_url });
      } catch (err: any) {
        const status = err?.status ?? '?';
        const msg = err?.message ?? String(err);
        const errors = err?.response?.data?.errors;
        return `ERROR status=${status}: ${msg}\n${errors ? JSON.stringify(errors) : ''}`;
      }
    },
  });
}

export function buildPostIssueCommentTool(deps: GhToolsDeps) {
  return tool({
    name: 'post_issue_comment',
    description:
`Post a plain (non-inline) comment on the PR. Use this only for always-on check failures (DCO, commands.def regen missing, etc.) — for all substantive findings, use \`post_review\` with inline comments.`,
    inputSchema: z.object({ body: z.string().min(1) }),
    callback: async (input) => {
      try {
        const resp = await deps.octokit.issues.createComment({
          owner: deps.ctx.owner,
          repo: deps.ctx.repo,
          issue_number: deps.ctx.prNumber,
          body: sign(input.body),
        });
        return JSON.stringify({ ok: true, comment_id: resp.data.id, url: resp.data.html_url });
      } catch (err: any) {
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

By default, does not post anything. The agent transcript is still retained server-side for auditing.`,
    inputSchema: z.object({
      reason: z.string().min(1).describe('One-sentence rationale; goes into logs, not GitHub.'),
    }),
    callback: async (input) => {
      return JSON.stringify({ ok: true, skipped: true, reason: input.reason, pr: `${deps.ctx.owner}/${deps.ctx.repo}#${deps.ctx.prNumber}` });
    },
  });
}
