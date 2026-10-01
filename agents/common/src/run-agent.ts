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

import { DEFAULT_RISK_REVIEW, isNativeRunner, reviewOutputTokens, type ModelSpec, type ReviewerConfig } from './config.js';
import { buildChatModel, tokensFrom, needsToolUseEnforcement, TOOL_USE_ENFORCEMENT } from './model.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts/reviewer-system.js';
import { getOctokit, type GithubAuth } from './github-auth.js';
import { prepareWorkspace, renderPrOverview, type PrContext } from './workspace.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { toAiSdkTools, type ToolDef } from './tool-def.js';
import { assembleCommonTools } from './tools/index.js';
import { refusedEmptyReview } from './tools/gh.js';
import { startReviewTrace, isToolErrorOutput } from './trace.js';
import { selectSkills } from './skills/select.js';
import { renderEscalation, renderReReview, ReviewEscalation, runAgyReview } from './agy-review.js';
import type { KnowledgeStore } from './store/store.js';
import type { Embedder } from './memory/embedder.js';
import { withReviewWorktree } from './review-worktree.js';
import { chooseReviewModel, modelLabel, routeInputFor, withReviewModel, type Hotspot } from './review-routing.js';
import { isModelRefusal, refusalAllowsFallback, type ModelRefusalError } from './refusal.js';
import { runQueuedForRepo } from '../../../daemon/src/repo-queue.js';

export interface AssembleBaseOpts {
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  readonly token: () => Promise<string>;
  readonly allowWrite: boolean;
  readonly config: ReviewerConfig;
}

export type AssembleTools = (opts: AssembleBaseOpts) => Promise<readonly ToolDef[]>;

export interface RunReviewOptions {
  readonly repo: string; // "owner/name"
  readonly prNumber: number;
  readonly headSha?: string;
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
  /**
   * revuto's own GitHub login(s). Only their signed reviews mark a head as
   * reviewed for a re-review. Defaults to the auth's login, then the token's user.
   */
  readonly reviewerLogins?: readonly string[];
}

export interface ReviewOutcome {
  readonly terminal: 'post_review' | 'skip_review' | 'none';
  /**
   * True when a posting tool actually put findings on the pull request. A posting
   * call that came back `ERROR` posted nothing and does not set this — see
   * `postFailures` for that case.
   */
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
  /**
   * Posting calls that came back as errors. The run tried to put something on the
   * pull request and failed, so a later clean `skip_review` is not a clean bill of
   * health: the findings it meant to post never reached anyone.
   */
  readonly postFailures: number;
  /** True when the terminal decision came from the terminal-tools-only recovery pass. */
  readonly forcedTerminal: boolean;
  /** False for PRs the engine declined to review at all (draft, stale delivery, ...). */
  readonly ranModel: boolean;
  /** Label of the model that ran (models.review or models.reviewSmall), when one did. */
  readonly model?: string;
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
    postFailures: 0,
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
    ...(o.postFailures > 0 ? [`postFailures=${o.postFailures}`] : []),
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
 * How many full-tool continuation passes a stalled review gets. Each pass ends the
 * same way the one before it did - on the per-turn output cap, mid-thought - but
 * with the inspection it managed in between, so retrying is worth more than jumping
 * straight to the terminal-only pass.
 */
const CONTINUATION_ATTEMPTS = 3;

/**
 * True when the pass died on the per-turn output limit without calling a tool.
 *
 * This is how reviews actually stall: the provider caps a turn at 8k output tokens,
 * the model spends the whole cap reasoning, and `generateText` sees a step with no
 * tool call and stops. Nothing is wrong with the review - it just never got to say
 * anything - so the continuation is told to keep its turns short.
 */
export function stalledOnOutputCap(steps: readonly StepLike[]): boolean {
  const last = steps.at(-1);
  return !!last && last.finishReason === 'length' && (last.toolCalls?.length ?? 0) === 0;
}

function continuationPrompt(truncated: boolean): string {
  return [
    'You stopped before calling a terminal tool, so nothing was posted and the review does not count.',
    truncated
      ? 'Your last turn was cut off by the per-turn output limit before you could call anything, so keep every turn short from here: no long prose, call the tool instead.'
      : null,
    'You still have the full tool set: finish the inspection you need, then call exactly one of `post_review` or `skip_review`. Communicate only through tool calls.',
  ]
    .filter(Boolean)
    .join(' ');
}

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

/**
 * The spec to retry a refused review on: the first configured fallback, which
 * inherits the rest of the chain. Undefined when the error is not a refusal,
 * the refusal must not be retried (reasoning_extraction), or no fallback exists.
 */
export function refusalFallback(spec: ModelSpec, err: unknown): ModelSpec | undefined {
  if (!isModelRefusal(err) || !refusalAllowsFallback(err)) return undefined;
  const [next, ...rest] = spec.fallbacks ?? [];
  if (!next) return undefined;
  const chain = [...(next.fallbacks ?? []), ...rest];
  const { fallbacks: _drop, ...single } = next;
  return chain.length ? { ...single, fallbacks: chain } : single;
}

/** Areas of learned concerns strong enough to send a PR touching them to the large tier. */
async function hotspotsFor(config: ReviewerConfig, store?: KnowledgeStore): Promise<Hotspot[]> {
  const min = (config.review.risk ?? DEFAULT_RISK_REVIEW).hotspotMinReinforcement;
  if (!store || min <= 0) return [];
  try {
    return (await store.allConcerns())
      .filter((c) => c.reinforcementCount >= min)
      .flatMap((c) => c.area.map((glob) => ({ glob, subject: c.subject })));
  } catch (err) {
    console.warn(`[review] hotspots unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Logins whose signed reviews count as revuto's; empty when none can be established (then no re-review range). */
async function reviewerLoginsFor(opts: RunReviewOptions, auth: GithubAuth): Promise<string[]> {
  const given = (opts.reviewerLogins ?? []).filter((l) => l?.trim());
  if (given.length) return given;
  if (auth.login) return [auth.login];
  try {
    return [(await auth.octokit.users.getAuthenticated()).data.login];
  } catch {
    // An App installation token cannot read /user; without a login there is no trusted baseline.
    return [];
  }
}

export async function runReview(opts: RunReviewOptions): Promise<ReviewOutcome> {
  return withReviewWorktree(opts.config, opts.repo, opts.prNumber,
    (workspace, cache, signal) => runReviewInWorkspace(opts, workspace, cache, signal));
}

async function runReviewInWorkspace(opts: RunReviewOptions, workspaceRoot: string, cacheRoot: string, signal: AbortSignal): Promise<ReviewOutcome> {
  const startedAt = new Date();
  let config = opts.config;
  const auth = opts.githubAuth ?? getOctokit(config.github);
  const { octokit, token } = auth;

  const [owner, name] = opts.repo.split('/');
  if (!owner || !name) throw new Error(`bad repo: ${opts.repo}`);
  const resolvedToken = await token();
  const reviewerLogins = config.review.incremental === false ? [] : await reviewerLoginsFor(opts, auth);
  const ctx = await runQueuedForRepo(config, `_review-cache/${opts.repo}`, () => prepareWorkspace(
    { repo: opts.repo, pr_number: opts.prNumber, headSha: opts.headSha },
    octokit,
    // Clone/fetch run here at the top of the review, so one resolve is enough;
    // the tools below get the getter, since they run for the next half hour.
    resolvedToken,
    workspaceRoot,
    { cacheRoot, signal, incremental: config.review.incremental !== false, reviewerLogins },
  ));

  // Small, medium and large PRs go to their tier's model when one is configured.
  // From here on `config.models.review` IS the routed model, for every code path below.
  // A re-review is sized by what changed since revuto's last reviewed head.
  const route = chooseReviewModel(config, { ...routeInputFor(ctx), hotspots: await hotspotsFor(config, opts.store) });
  config = withReviewModel(config, route.spec);
  const since = ctx.incremental ? `re-review since ${ctx.incremental.fromSha.slice(0, 7)}, ` : '';
  console.log(`[review] ${opts.repo}#${opts.prNumber}: model ${route.label} (${route.tier} tier): ${since}${route.reason}`);

  let skillMd = opts.skillMarkdown?.trim() ?? '';
  if (!skillMd && opts.store) {
    skillMd = (await selectSkills(opts.store, opts.embedder ?? null, ctx.fileList)).trim();
  }
  let reviewedBy = route.label;
  // A small or medium tier may hand the PR to the large tier once. The first
  // pass's cost is added to the outcome, so daily token limits see both passes.
  let escalateTo = route.tier !== 'large' && config.review.escalate !== false && opts.config.models.review !== route.spec
    ? opts.config.models.review : undefined;
  let escalationNote: string | undefined;
  // What an escalated pass did that the final outcome must keep: its cost, and
  // anything it already put on the PR (an HTTP pass can post an issue comment
  // before escalating), so a clean large-tier pass cannot turn that into a pass.
  const carried = { tokens: 0, steps: 0, hasFindings: false, postFailures: 0 };
  const withCarried = (outcome: ReviewOutcome): ReviewOutcome => ({
    ...outcome,
    tokens: outcome.tokens + carried.tokens,
    steps: outcome.steps + carried.steps,
    hasFindings: outcome.hasFindings || carried.hasFindings,
    postFailures: outcome.postFailures + carried.postFailures,
  });
  // A sampled small or medium review also runs on the large tier, posting
  // nothing, to measure what the cheaper tier misses. Never changes the outcome.
  const finish = async (outcome: ReviewOutcome): Promise<ReviewOutcome> => {
    const final = withCarried(outcome);
    const large = opts.config.models.review;
    if (route.tier !== 'large' && !escalationNote && final.ranModel && shouldShadow(opts.config.review.shadowSample ?? 0)) {
      if (!isNativeRunner(large)) {
        console.log(`[shadow] ${opts.repo}#${opts.prNumber}: skipped, the large tier is not a native runner`);
      } else {
        try {
          const shadow = await runAgyReview({ config: withReviewModel(opts.config, large), ctx, octokit, token, skillMarkdown: skillMd,
            startedAt: new Date(), signal, reviewedBy: modelLabel(large), dryRun: true });
          const record = shadowRecord({ repo: opts.repo, prNumber: opts.prNumber, headSha: ctx.headSha, tier: route.tier, cheap: final, large: shadow });
          writeShadowRecord(opts.config.vaultPath, record);
          console.log(`[shadow] ${opts.repo}#${opts.prNumber}: ${route.tier} tier ${record.cheap.findings ? 'posted findings' : 'passed'}, large tier ${record.large.decision === 'post_review' ? `found ${record.large.comments.length}` : 'passed'}: ${record.agree ? 'agree' : 'DISAGREE'}`);
        } catch (err) {
          console.warn(`[shadow] ${opts.repo}#${opts.prNumber}: failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return final;
  };
  // One loop over passes: a cheap tier that escalates continues with the large tier,
  // native or HTTP.
  for (;;) {
    // Native CLI reviewers. A refusal moves the run to the next configured
    // fallback (CLI or HTTP) instead of failing it; any other error still fails.
    while (isNativeRunner(config.models.review)) {
      try {
        return await finish(await runAgyReview({ config, ctx, octokit, token, skillMarkdown: skillMd, startedAt, signal, reviewedBy,
          allowEscalation: escalateTo !== undefined, ...(escalationNote ? { escalationNote } : {}) }));
      } catch (err) {
        if (err instanceof ReviewEscalation && escalateTo) {
          console.warn(`[review] ${opts.repo}#${opts.prNumber}: ${reviewedBy} escalated to ${modelLabel(escalateTo)}: ${err.reason}`);
          carried.tokens += err.tokens;
          carried.steps += err.steps;
          config = withReviewModel(config, escalateTo);
          reviewedBy = modelLabel(escalateTo);
          escalationNote = err.reason;
          escalateTo = undefined;
          continue;
        }
        const next = refusalFallback(config.models.review, err);
        if (!next) throw err;
        console.warn(`[review] ${opts.repo}#${opts.prNumber}: ${reviewedBy} refused (category=${(err as ModelRefusalError).category}); falling back to ${modelLabel(next)}`);
        config = withReviewModel(config, next);
        reviewedBy = modelLabel(next);
      }
    }
    let system = skillMd
      ? `${REVIEWER_SYSTEM_PROMPT}\n\n---\n\n## Repository knowledge\n\n${skillMd}`
      : REVIEWER_SYSTEM_PROMPT;
    // Tool-shy models (GLM, etc.) tend to end with prose instead of a terminal tool — steer them.
    if (needsToolUseEnforcement(config.models.review)) system += TOOL_USE_ENFORCEMENT;

    const assemble = opts.assembleTools ?? defaultAssembleTools;
    const toolDefs = await assemble({ ctx, octokit, token, allowWrite: config.review.allowWrite, config });
    // A cheap HTTP tier escalates through a tool that posts nothing.
    const tools = toAiSdkTools(escalateTo ? [...toolDefs, ESCALATE_TOOL] : toolDefs);

    const userMessage = [
      renderPrOverview(ctx),
      renderReReview(ctx, 'git'),
      renderEscalation(escalationNote ? { note: escalationNote } : escalateTo ? { allow: true, via: 'tool' } : {}),
      '',
      '---',
      '',
      'The workspace is checked out at the PR head. When done, call exactly one of `post_review` or `skip_review`. Communicate only through tool calls.',
    ].join('\n');

    const model = buildChatModel(config.models.review);
    const maxOutputTokens = reviewOutputTokens(config);
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
      abortSignal: signal,
      model,
      system,
      prompt: userMessage,
      tools,
      stopWhen: [stepCountIs(config.review.maxSteps), hasToolCall('post_review'), hasToolCall('skip_review'), hasToolCall(ESCALATE_TOOL.name)],
      maxOutputTokens,
      onStepFinish: (step) => trace.step('main', step),
    });

    let { terminal, result, hasFindings, inspections, toolErrors, postFailures } = summarizeReviewSteps(main.steps);
    let tokens = tokensFrom(main.usage);
    let stepCount = main.steps.length;
    // An escalation ends this pass: nothing was posted, the large tier takes over.
    const escalateNow = (steps: readonly StepLike[]): boolean => {
      const reason = escalateTo ? escalationReason(steps) : undefined;
      if (!reason || !escalateTo) return false;
      trace.finish({ terminal: 'none', result: '', inspections, toolErrors, reason, error: `escalated: ${reason}` });
      console.warn(`[review] ${opts.repo}#${opts.prNumber}: ${reviewedBy} escalated to ${modelLabel(escalateTo)}: ${reason}`);
      carried.tokens += tokens;
      carried.steps += stepCount;
      carried.hasFindings ||= hasFindings;
      carried.postFailures += postFailures;
      config = withReviewModel(config, escalateTo);
      reviewedBy = modelLabel(escalateTo);
      escalationNote = reason;
      escalateTo = undefined;
      return true;
    };
    if (escalateNow(main.steps)) continue;
    let escalatedMidway = false;
    let forcedTerminal = false;
    const passes: Array<{ readonly responseMessages: readonly ModelMessage[] }> = [main];
    let transcript = reviewTranscript(userMessage, main);
    let lastSteps: readonly StepLike[] = main.steps;

    // The model ended without a terminal tool, so nothing was posted. Recovery is
    // two stages, in this order on purpose:
    //
    //   1. Continue with the FULL tool set - up to CONTINUATION_ATTEMPTS times, since
    //      a pass that dies on the per-turn output cap usually gets real work done
    //      first and dies again on the next cap rather than on the decision.
    //   2. Only if those also end without a decision, replay with the terminal tools
    //      alone and toolChoice "required".
    //
    // Stage 2 first is what produced green checks with no review behind them: a model
    // handed only post_review/skip_review reports it has nothing to inspect with and
    // calls skip_review. A decision made there is flagged `forcedTerminal`, and
    // `inspections` stays at whatever the earlier passes actually did.
    for (let attempt = 1; terminal === 'none' && attempt <= CONTINUATION_ATTEMPTS; attempt++) {
      const phase = attempt === 1 ? 'continuation' : `continuation-${attempt}`;
      const continued = await generateText({
        abortSignal: signal,
        model,
        system,
        messages: [...transcript, { role: 'user', content: continuationPrompt(stalledOnOutputCap(lastSteps)) }],
        tools,
        stopWhen: [stepCountIs(CONTINUATION_MAX_STEPS), hasToolCall('post_review'), hasToolCall('skip_review'), hasToolCall(ESCALATE_TOOL.name)],
        maxOutputTokens,
        onStepFinish: (step) => trace.step(phase, step),
      });
      const c = summarizeReviewSteps(continued.steps);
      terminal = c.terminal;
      result = c.result;
      hasFindings ||= c.hasFindings;
      inspections += c.inspections;
      toolErrors += c.toolErrors;
      postFailures += c.postFailures;
      tokens += tokensFrom(continued.usage);
      stepCount += continued.steps.length;
      passes.push(continued);
      transcript = reviewTranscript(userMessage, ...passes);
      lastSteps = continued.steps;
      if (escalateNow(continued.steps)) { escalatedMidway = true; break; }
    }
    if (escalatedMidway) continue;

    if (terminal === 'none') {
      const forced = await generateText({
        abortSignal: signal,
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
        // Claude on Converse rejects forced tool use; the adapter sends auto,
        // names these two tools, and retries once. Responses keeps 'required'.
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
      postFailures += f.postFailures;
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
      postFailures,
      forcedTerminal,
      ranModel: true,
      model: reviewedBy,
    };
    const tracePath = trace.finish({ ...outcome, result: outcome.result.slice(0, 8000) });

    return await finish({ ...outcome, ...(tracePath ? { tracePath } : {}) });
  }
}

export type StepLike = {
  finishReason?: string;
  toolCalls?: Array<{ toolName?: string; input?: unknown }>;
  toolResults?: Array<{ toolName: string; input?: unknown; output?: unknown; result?: unknown }>;
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
/** True for a sampled review; `share` is `review.shadowSample`. */
export function shouldShadow(share: number, random: () => number = Math.random): boolean {
  return share > 0 && random() < share;
}

export interface ShadowRecord {
  readonly at: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly tier: string;
  readonly cheap: { readonly model?: string; readonly terminal: string; readonly findings: boolean; readonly tokens: number };
  readonly large: { readonly model?: string; readonly decision: string; readonly comments: ReadonlyArray<{ path: string; line: number }>; readonly tokens: number };
  /** Both found something, or both passed. */
  readonly agree: boolean;
}

/** Compare a cheap tier's outcome with the large tier's dry-run verdict. */
export function shadowRecord(input: { repo: string; prNumber: number; headSha: string; tier: string; cheap: ReviewOutcome; large: ReviewOutcome }): ShadowRecord {
  let verdict: { decision?: string; comments?: Array<{ path: string; line: number }> } = {};
  try { verdict = JSON.parse(input.large.result); } catch { /* recorded as unknown below */ }
  const decision = verdict.decision ?? input.large.terminal;
  return {
    at: new Date().toISOString(), repo: input.repo, prNumber: input.prNumber, headSha: input.headSha, tier: input.tier,
    cheap: { model: input.cheap.model, terminal: input.cheap.terminal, findings: input.cheap.hasFindings, tokens: input.cheap.tokens },
    large: { model: input.large.model, decision, comments: verdict.comments ?? [], tokens: input.large.tokens },
    agree: input.cheap.hasFindings === (decision === 'post_review'),
  };
}

/** Append to <vault>/.shadow/<YYYY-MM>.jsonl. */
export function writeShadowRecord(vaultPath: string, record: ShadowRecord): string {
  const dir = join(vaultPath, '.shadow');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.at.slice(0, 7)}.jsonl`);
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

/** HTTP escalation: a terminal tool that posts nothing; the dispatch loop hands the PR to the large tier. */
const ESCALATE_TOOL: ToolDef = {
  name: 'escalate_review',
  description: 'Hand this PR to the full reviewer when you cannot settle part of it with the evidence you can gather. Posts nothing. Give the reason: what needs the deeper look.',
  inputSchema: z.object({ reason: z.string().min(1) }),
  callback: async (input: { reason: string }) => JSON.stringify({ ok: true, escalated: true, reason: input.reason }),
};

/** The reason of a successful escalate_review call in these steps, if any. */
export function escalationReason(steps: readonly StepLike[]): string | undefined {
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      if (tr.toolName !== ESCALATE_TOOL.name) continue;
      const payload = tr.output ?? tr.result;
      if (isToolErrorOutput(payload)) continue;
      const reason = (tr.input as { reason?: unknown } | undefined)?.reason;
      if (typeof reason === 'string' && reason.trim()) return reason.trim();
    }
  }
  return undefined;
}

export function summarizeReviewSteps(
  steps: readonly StepLike[],
): Pick<ReviewOutcome, 'terminal' | 'result' | 'hasFindings' | 'inspections' | 'toolErrors' | 'postFailures'> {
  let terminal: ReviewOutcome['terminal'] = 'none';
  let result = '';
  let hasFindings = false;
  let inspections = 0;
  let toolErrors = 0;
  let postFailures = 0;
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      const payload = tr.output ?? tr.result ?? {};
      const posting = POSTING_TOOLS.has(tr.toolName);
      const isTerminal = TERMINAL_TOOLS.has(tr.toolName);
      // A call that failed did not do its job, so it decides nothing: it is neither
      // an inspection, nor a finding, nor a terminal decision. Reading findings out
      // of the attempt rather than the result is what reported a `post_review` the
      // API rejected — and a clean one carrying no comments — as posted findings.
      if (isToolErrorOutput(payload)) {
        toolErrors++;
        // One posting failure loses nothing: the empty-review guard turning away a
        // post that carried no findings. A `skip_review` after that is a real clean
        // decision, so counting it here would fail the check on a clean review —
        // the very thing this reports on.
        if (posting && !refusedEmptyReview(payload)) postFailures++;
        continue;
      }
      if (!isTerminal && !posting) inspections++;
      if (posting) hasFindings = true;
      if (isTerminal) {
        terminal = tr.toolName as ReviewOutcome['terminal'];
        result = typeof payload === 'string' ? payload : JSON.stringify(payload);
      }
    }
    // A call the SDK rejected outright (unknown tool, schema mismatch) never reaches
    // toolResults, so count it here or the run looks cleaner than it was.
    for (const part of step.content ?? []) if (part?.type === 'tool-error') toolErrors++;
  }
  return { terminal, result, hasFindings, inspections, toolErrors, postFailures };
}

const defaultAssembleTools: AssembleTools = async (opts) =>
  assembleCommonTools({ ctx: opts.ctx, octokit: opts.octokit, token: opts.token, allowWrite: opts.allowWrite });
