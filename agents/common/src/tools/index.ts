import type { Octokit } from '@octokit/rest';
import type { PrContext } from '../workspace.js';
import type { ToolDef } from '../tool-def.js';
import { buildHarnessTools } from './harness.js';
import { buildGitTool } from './git.js';
import { buildGhApiReadTool, buildPostReviewTool, buildPostIssueCommentTool, buildSkipTool } from './gh.js';

export interface CommonToolsOpts {
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  readonly token: string;
  readonly allowWrite?: boolean;
}

/**
 * Build the review-agent-agnostic tool set: harness read/grep/glob/bash/lsp
 * + allowlisted git + GitHub REST read + post_review / post_issue_comment
 * / skip_review.
 *
 * A per-repo reviewer can compose this with its own build/run tools (make,
 * cargo, mvn, pytest, …) before the run loop hands them to the model.
 */
export async function assembleCommonTools(opts: CommonToolsOpts): Promise<readonly ToolDef[]> {
  const harness = await buildHarnessTools({
    workspaceRoot: opts.ctx.workspacePath,
    allowWrite: opts.allowWrite ?? false,
  });

  const ghDeps = { ctx: opts.ctx, octokit: opts.octokit, token: opts.token };

  return [
    ...harness.tools,
    buildGitTool({ workspaceRoot: opts.ctx.workspacePath }),
    buildGhApiReadTool(ghDeps),
    buildPostReviewTool(ghDeps),
    buildPostIssueCommentTool(ghDeps),
    buildSkipTool(ghDeps),
  ];
}

// Re-exports so agents can import everything through the common barrel.
export { buildHarnessTools } from './harness.js';
export { buildGitTool } from './git.js';
export { buildGhApiReadTool, buildPostReviewTool, buildPostIssueCommentTool, buildSkipTool } from './gh.js';
