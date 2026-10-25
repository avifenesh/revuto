import type { Octokit } from '@octokit/rest';
import type { PrContext } from '../workspace.js';
import type { ToolDef } from '../tool-def.js';
import { buildHarnessTools } from './harness.js';
import { buildPostReviewTool, buildPostIssueCommentTool, buildSkipTool } from './gh.js';
import { claudeInspectionTools } from '../claude-review-mcp.js';

export interface CommonToolsOpts {
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  readonly token: () => Promise<string>;
  readonly allowWrite?: boolean;
}

/**
 * The HTTP reviewer's tool set: the same guarded inspection tools the Claude
 * and Codex runners get (read/grep/glob confined to the PR worktree, the fixed
 * PR diff, the re-review diff), plus post_review / post_issue_comment /
 * skip_review. No shell, git, network or GitHub read access: the PR checkout
 * and its context are all a review needs, and the model reads attacker text.
 * `allowWrite` adds write/edit, still confined to the worktree.
 */
export async function assembleCommonTools(opts: CommonToolsOpts): Promise<readonly ToolDef[]> {
  const ghDeps = { ctx: opts.ctx, octokit: opts.octokit, token: opts.token };
  const inspection = await claudeInspectionTools(opts.ctx.workspacePath, opts.ctx.diffRefSpec, opts.ctx.incremental?.range);
  const writes = opts.allowWrite
    ? (await buildHarnessTools({ workspaceRoot: opts.ctx.workspacePath, allowWrite: true })).tools.filter((t) => t.name === 'write' || t.name === 'edit')
    : [];
  return [
    ...inspection,
    ...writes,
    buildPostReviewTool(ghDeps),
    buildPostIssueCommentTool(ghDeps),
    buildSkipTool(ghDeps),
  ];
}

// Re-exports so agents can import everything through the common barrel.
export { buildHarnessTools } from './harness.js';
export { buildPostReviewTool, buildPostIssueCommentTool, buildSkipTool } from './gh.js';
