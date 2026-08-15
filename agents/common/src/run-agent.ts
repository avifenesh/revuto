/**
 * Review run loop — Vercel AI SDK over an OpenAI-compatible model.
 *
 * Replaces the Bedrock AgentCore container entrypoint + Strands stream loop.
 * `runReview()` is a plain async function the daemon/CLI call directly: prepare
 * the workspace, assemble tools, drive a multi-step tool-calling loop, and stop
 * when the agent calls a terminal tool (`post_review` / `skip_review`) or hits
 * the step cap.
 */
import { generateText, stepCountIs, hasToolCall, type ModelMessage } from 'ai';
import type { Octokit } from '@octokit/rest';

import type { ReviewerConfig } from './config.js';
import { buildChatModel, tokensFrom, needsToolUseEnforcement, TOOL_USE_ENFORCEMENT } from './model.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts/reviewer-system.js';
import { getOctokit, type GithubAuth } from './github-auth.js';
import { prepareWorkspace, renderPrOverview, type PrContext } from './workspace.js';
import { toAiSdkTools, type ToolDef } from './tool-def.js';
import { assembleCommonTools } from './tools/index.js';
import { startReviewTrace, isToolErrorOutput } from './trace.js';
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
  /** Installation-scoped auth for GitHub App webhook runs. */
  readonly githubAuth?: GithubAuth;
}

export interface ReviewOutcome {
  readonly terminal: 'post_review' | 'skip_review' | 'none';
  /** True when the run used a non-terminal finding tool such as post_issue_comment. */
  readonly hasFindings: boolean;
  readonly result: string;
  readonly headSha: string;
  readonly steps: number;
  /** Total tokens used by this review run (for daily-budget accounting). */
  readonly tokens: number;
  /**
   * Successful non-terminal, non-posting tool results (read/grep/glob/bash/lsp/git/gh).
   * Zero means the run never looked at the code, so a `skip_review` is not a clean
   * bill of health — see `checkResultForOutcome` in the daemon.
   */
  readonly inspections: number;
  /** Tool results that came back as errors (`ERROR ...`). */
  readonly toolErrors: number;
  /** True when the terminal decision came from the terminal-tools-only recovery pass. */
  readonly forcedTerminal: boolean;
  /** False for PRs the engine declined to review at all (draft, stale delivery, ...). */
  readonly ranModel: boolean;
  /** JSONL trace of the run, when one could be written. */
  readonly tracePath?: string;
}

/**
 * Outcome for a PR the engine decided not to run the model on at all: a draft, a
 * stale webhook delivery, an unregistered repo, or a head another run already
 * claimed. `ranModel: false` keeps these apart from a real run that inspected
 * nothing, which the daemon reports as a failed check.
 */
export function unreviewedOutcome(result: string, headSha: string): ReviewOutcome {
  return {
    terminal: 'skip_review',
    hasFindings: false,
    result,
    headSha,
    steps: 0,
    tokens: 0,
    inspections: 0,
    toolErrors: 0,
    forcedTerminal: false,
    ranModel: false,
  };
}

/** One-line log summary: what the run decided, and how much work is behind it. */
export function describeOutcome(o: ReviewOutcome): string {
  return [
    `terminal=${o.terminal}`,
    `findings=${o.hasFindings}`,
    `inspections=${o.inspections}`,
    `toolErrors=${o.toolErrors}`,
    ...(o.forcedTerminal ? ['forced=true'] : []),
    `steps=${o.steps}`,
    `tokens=${o.tokens}`,
    ...(o.tracePath ? [`trace=${o.tracePath}`] : []),
  ].join(' ');
}

/**
 * Step cap for the full-tool continuation pass: enough to finish an inspection
 * that stalled, small enough that a model looping on tool calls cannot double the
 * cost of the run.
 */
const CONTINUATION_MAX_STEPS = 25;

/**
 * Messages to replay into a recovery pass: the original request plus every model
 * turn each earlier pass produced.
 *
 * Take `responseMessages` (accumulated over all steps), never `response.messages`
 * (the final step only). A stalled review ends on an empty step, so replaying just
 * that step handed the recovery passes a transcript with no tool output in it -
 * which is why a forced `skip_review` could truthfully say it had inspected
 * nothing after 68 successful tool calls.
 */
export function reviewTranscript(
  userMessage: string,
  ...passes: ReadonlyArray<{ readonly responseMessages: readonly ModelMessage[] }>
): ModelMessage[] {
  return [{ role: 'user', content: userMessage }, ...passes.flatMap((pass) => [...pass.responseMessages])];
}

export async function runReview(opts: RunReviewOptions): Promise<ReviewOutcome> {
  const { config } = opts;
  const startedAt = new Date();
  const { octokit, token } = opts.githubAuth ?? getOctokit(config.github);

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
  // Opened before the first call so a run that is killed mid-review still leaves
  // every step it completed on disk.
  const trace = startReviewTrace({
    vaultPath: config.vaultPath,
    repo: opts.repo,
    prNumber: opts.prNumber,
    headSha: ctx.headSha,
    model: config.models.review.model,
    startedAt,
  });
  const main = await generateText({
    model,
    system,
    prompt: userMessage,
    tools,
    stopWhen: [stepCountIs(config.review.maxSteps), hasToolCall('post_review'), hasToolCall('skip_review')],
    maxOutputTokens,
    onStepFinish: (step) => trace.step('main', step),
  });

  let { terminal, result, hasFindings, inspections, toolErrors } = summarizeReviewSteps(main.steps);
  let tokens = tokensFrom(main.usage);
  let stepCount = main.steps.length;
  let forcedTerminal = false;
  let transcript = reviewTranscript(userMessage, main);

  // The model ended with prose instead of a terminal tool, so nothing was posted.
  // Recovery is two stages, in this order on purpose:
  //
  //   1. Continue with the FULL tool set, so a review that stalled mid-inspection
  //      can finish the work it started.
  //   2. Only if that also ends in prose, replay with the terminal tools alone and
  //      toolChoice "required".
  //
  // Stage 2 first is what produced green checks with no review behind them: a model
  // handed only post_review/skip_review truthfully reports it has nothing to inspect
  // with and calls skip_review. A decision made there is flagged `forcedTerminal`,
  // and `inspections` stays at whatever the earlier passes actually did.
  if (terminal === 'none') {
    const continued = await generateText({
      model,
      system,
      messages: [
        ...transcript,
        { role: 'user', content: 'You stopped before calling a terminal tool, so nothing was posted and the review does not count. You still have the full tool set: finish the inspection you need, then call exactly one of `post_review` or `skip_review`. Communicate only through tool calls.' },
      ],
      tools,
      stopWhen: [stepCountIs(CONTINUATION_MAX_STEPS), hasToolCall('post_review'), hasToolCall('skip_review')],
      maxOutputTokens,
      onStepFinish: (step) => trace.step('continuation', step),
    });
    const c = summarizeReviewSteps(continued.steps);
    terminal = c.terminal;
    result = c.result;
    hasFindings ||= c.hasFindings;
    inspections += c.inspections;
    toolErrors += c.toolErrors;
    tokens += tokensFrom(continued.usage);
    stepCount += continued.steps.length;
    transcript = reviewTranscript(userMessage, main, continued);
  }

  if (terminal === 'none') {
    const forced = await generateText({
      model,
      system,
      messages: [
        ...transcript,
        {
          role: 'user',
          content: [
            'You ended without posting, which wastes the review. Call exactly one of `post_review` (with your findings) or `skip_review` (if nothing clears the bar) now — respond only with that tool call.',
            `This run already made ${inspections} successful inspection tool call(s); their output is in this conversation. Base the call on it.`,
            'You have no inspection tools in this turn, so do not claim you read nothing when the transcript above shows otherwise.',
          ].join(' '),
        },
      ],
      tools: { post_review: tools.post_review, skip_review: tools.skip_review },
      toolChoice: 'required',
      stopWhen: [stepCountIs(2), hasToolCall('post_review'), hasToolCall('skip_review')],
      maxOutputTokens,
      onStepFinish: (step) => trace.step('forced', step),
    });
    const f = summarizeReviewSteps(forced.steps);
    terminal = f.terminal;
    result = f.result;
    hasFindings ||= f.hasFindings;
    toolErrors += f.toolErrors;
    tokens += tokensFrom(forced.usage);
    stepCount += forced.steps.length;
    forcedTerminal = terminal !== 'none';
  }

  const outcome: ReviewOutcome = {
    terminal,
    hasFindings,
    result,
    headSha: ctx.headSha,
    steps: stepCount,
    tokens,
    inspections,
    toolErrors,
    forcedTerminal,
    ranModel: true,
  };
  const tracePath = trace.finish({ ...outcome, result: outcome.result.slice(0, 8000) });

  return { ...outcome, ...(tracePath ? { tracePath } : {}) };
}

type StepLike = {
  toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown }>;
  content?: Array<{ type?: string }>;
};

/** Tools that end the run. Neither counts as inspecting the diff. */
const TERMINAL_TOOLS = new Set(['post_review', 'skip_review']);
/** Tools that put something on the PR. Findings, not inspection. */
const POSTING_TOOLS = new Set(['post_review', 'post_issue_comment']);

/**
 * Pull the terminal decision, any non-terminal findings, and how much the run
 * actually inspected out of a run's steps.
 */
export function summarizeReviewSteps(
  steps: readonly StepLike[],
): Pick<ReviewOutcome, 'terminal' | 'result' | 'hasFindings' | 'inspections' | 'toolErrors'> {
  let terminal: ReviewOutcome['terminal'] = 'none';
  let result = '';
  let hasFindings = false;
  let inspections = 0;
  let toolErrors = 0;
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      const payload = tr.output ?? tr.result ?? {};
      if (isToolErrorOutput(payload)) {
        toolErrors++;
      } else if (!TERMINAL_TOOLS.has(tr.toolName) && !POSTING_TOOLS.has(tr.toolName)) {
        inspections++;
      }
      if (POSTING_TOOLS.has(tr.toolName)) hasFindings = true;
      if (TERMINAL_TOOLS.has(tr.toolName)) {
        terminal = tr.toolName as ReviewOutcome['terminal'];
        result = typeof payload === 'string' ? payload : JSON.stringify(payload);
      }
    }
    // A call the SDK rejected outright (unknown tool, schema mismatch) never reaches
    // toolResults, so count it here or the run looks cleaner than it was.
    for (const part of step.content ?? []) if (part?.type === 'tool-error') toolErrors++;
  }
  return { terminal, result, hasFindings, inspections, toolErrors };
}

const defaultAssembleTools: AssembleTools = async (opts) =>
  assembleCommonTools({ ctx: opts.ctx, octokit: opts.octokit, token: opts.token, allowWrite: opts.allowWrite });
