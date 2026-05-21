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
import { buildChatModel, tokensFrom, needsToolUseEnforcement, TOOL_USE_ENFORCEMENT } from './model.js';
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
  let system = skillMd
    ? `${REVIEWER_SYSTEM_PROMPT}\n\n---\n\n## Repository knowledge\n\n${skillMd}`
    : REVIEWER_SYSTEM_PROMPT;
  // Tool-shy models (GLM, etc.) tend to end with prose instead of a terminal tool — steer them.
  if (needsToolUseEnforcement(config.models.review)) system += TOOL_USE_ENFORCEMENT;

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

  const model = buildChatModel(config.models.review);
  const maxOutputTokens = config.limits.maxOutputTokens.review;
  const main = await generateText({
    model,
    system,
    prompt: userMessage,
    tools,
    stopWhen: [stepCountIs(config.review.maxSteps), hasToolCall('post_review'), hasToolCall('skip_review')],
    maxOutputTokens,
  });

  let { terminal, result } = findTerminal(main.steps);
  let tokens = tokensFrom(main.usage);
  let stepCount = main.steps.length;

  // GLM-style failure: the model ended with prose instead of a terminal tool, so nothing
  // was posted. Force a decision — replay the conversation with only the terminal tools and
  // toolChoice "required" so the model must post_review or skip_review.
  if (terminal === 'none') {
    const forced = await generateText({
      model,
      system,
      messages: [
        { role: 'user', content: userMessage },
        ...main.response.messages,
        { role: 'user', content: 'You ended without posting, which wastes the review. Call exactly one of `post_review` (with your findings) or `skip_review` (if nothing clears the bar) now — respond only with that tool call.' },
      ],
      tools: { post_review: tools.post_review, skip_review: tools.skip_review },
      toolChoice: 'required',
      stopWhen: [stepCountIs(2), hasToolCall('post_review'), hasToolCall('skip_review')],
      maxOutputTokens,
    });
    const f = findTerminal(forced.steps);
    terminal = f.terminal;
    result = f.result;
    tokens += tokensFrom(forced.usage);
    stepCount += forced.steps.length;
  }

  return { terminal, result, headSha: ctx.headSha, steps: stepCount, tokens };
}

type StepLike = { toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown }> };

/** Pull the terminal tool's outcome from a run's steps, if it called one. */
function findTerminal(steps: readonly StepLike[]): { terminal: ReviewOutcome['terminal']; result: string } {
  let terminal: ReviewOutcome['terminal'] = 'none';
  let result = '';
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      if (tr.toolName === 'post_review' || tr.toolName === 'skip_review') {
        terminal = tr.toolName;
        const payload = tr.output ?? tr.result ?? {};
        result = typeof payload === 'string' ? payload : JSON.stringify(payload);
      }
    }
  }
  return { terminal, result };
}

const defaultAssembleTools: AssembleTools = async (opts) =>
  assembleCommonTools({ ctx: opts.ctx, octokit: opts.octokit, token: opts.token, allowWrite: opts.allowWrite });
