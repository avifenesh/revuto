/**
 * Review run loop — Vercel AI SDK over an OpenAI-compatible model.
 *
 * Replaces the Bedrock AgentCore container entrypoint + Strands stream loop.
 * `runReview()` is a plain async function the daemon/CLI call directly: prepare
 * the workspace, assemble tools, drive a multi-step tool-calling loop, and stop
 * when the agent calls a terminal tool (`post_review` / `skip_review`) or hits
 * the step cap.
 */
import { generateText, stepCountIs, hasToolCall } from 'ai';
import type { Octokit } from '@octokit/rest';

import type { ReviewerConfig } from './config.js';
import { buildChatModel, tokensFrom } from './model.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts/reviewer-system.js';
import { getOctokit } from './github-auth.js';
import { prepareWorkspace, renderPrOverview, type PrContext } from './workspace.js';
import { toAiSdkTools, type ToolDef } from './tool-def.js';
import { assembleCommonTools } from './tools/index.js';
import { selectSkills } from './skills/select.js';
import type { KnowledgeStore } from './store/store.js';
import type { Embedder } from './memory/embedder.js';

export interface AssembleBaseOpts {
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  readonly token: string;
  readonly allowWrite: boolean;
  readonly config: ReviewerConfig;
}

export type AssembleTools = (opts: AssembleBaseOpts) => Promise<readonly ToolDef[]>;

export interface RunReviewOptions {
  readonly repo: string; // "owner/name"
  readonly prNumber: number;
  readonly config: ReviewerConfig;
  /** Per-repo skill ("textbook") + selected topic skills, appended to the system prompt. */
  readonly skillMarkdown?: string;
  /** When set (and skillMarkdown is not), skills are selected from the store by touched files. */
  readonly store?: KnowledgeStore;
  readonly embedder?: Embedder | null;
  /** Override the tool set (per-repo build tools). Defaults to the common read/review tools. */
  readonly assembleTools?: AssembleTools;
}

export interface ReviewOutcome {
  readonly terminal: 'post_review' | 'skip_review' | 'none';
  readonly result: string;
  readonly headSha: string;
  readonly steps: number;
  /** Total tokens used by this review run (for daily-budget accounting). */
  readonly tokens: number;
}

export async function runReview(opts: RunReviewOptions): Promise<ReviewOutcome> {
  const { config } = opts;
  const { octokit, token } = getOctokit(config.github);

  const [owner, name] = opts.repo.split('/');
  if (!owner || !name) throw new Error(`bad repo: ${opts.repo}`);
  const workspaceRoot = `${config.review.workspaceDir}/${owner}__${name}`;

  const ctx = await prepareWorkspace(
    { repo: opts.repo, pr_number: opts.prNumber },
    octokit,
    token,
    workspaceRoot,
  );

  let skillMd = opts.skillMarkdown?.trim() ?? '';
  if (!skillMd && opts.store) {
    skillMd = (await selectSkills(opts.store, opts.embedder ?? null, ctx.fileList)).trim();
  }
  const system = skillMd
    ? `${REVIEWER_SYSTEM_PROMPT}\n\n---\n\n## Repository knowledge\n\n${skillMd}`
    : REVIEWER_SYSTEM_PROMPT;

  const assemble = opts.assembleTools ?? defaultAssembleTools;
  const toolDefs = await assemble({ ctx, octokit, token, allowWrite: config.review.allowWrite, config });
  const tools = toAiSdkTools(toolDefs);

  const userMessage = [
    renderPrOverview(ctx),
    '',
    '---',
    '',
    'The workspace is checked out at the PR head. Follow the method in the system prompt. When done, call exactly one of `post_review` or `skip_review`. Communicate only through tool calls.',
  ].join('\n');

  const { steps, usage } = await generateText({
    model: buildChatModel(config.models.review),
    system,
    prompt: userMessage,
    tools,
    stopWhen: [stepCountIs(config.review.maxSteps), hasToolCall('post_review'), hasToolCall('skip_review')],
    maxOutputTokens: config.limits.maxOutputTokens.review,
  });

  let terminal: ReviewOutcome['terminal'] = 'none';
  let result = '';
  for (const step of steps) {
    for (const tr of (step.toolResults ?? []) as Array<{ toolName: string; output?: unknown; result?: unknown }>) {
      if (tr.toolName === 'post_review' || tr.toolName === 'skip_review') {
        terminal = tr.toolName;
        const payload = tr.output ?? tr.result ?? {};
        result = typeof payload === 'string' ? payload : JSON.stringify(payload);
      }
    }
  }

  return { terminal, result, headSha: ctx.headSha, steps: steps.length, tokens: tokensFrom(usage) };
}

const defaultAssembleTools: AssembleTools = async (opts) =>
  assembleCommonTools({ ctx: opts.ctx, octokit: opts.octokit, token: opts.token, allowWrite: opts.allowWrite });
