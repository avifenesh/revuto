/**
 * Native agent CLI review runner for Antigravity and Claude Code.
 *
 * AGY is an agent harness rather than an OpenAI-compatible model endpoint. The
 * review is therefore driven by AGY's supported headless interface, while the
 * final GitHub mutation still goes through Revuto's existing post_review tool.
 * Authentication is intentionally delegated to AGY's own OAuth/keyring flow.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { killReviewChild } from './review-worktree.js';
import { claudeEnvironment } from './claude-env.js';
import { z } from 'zod';
import type { Octokit } from '@octokit/rest';

import type { ModelSpec, ReviewerConfig } from './config.js';
import type { ReviewOutcome } from './run-agent.js';
import type { PrContext } from './workspace.js';
import { buildPostReviewTool, buildSkipTool } from './tools/gh.js';
import { isToolErrorOutput, startReviewTrace, type TraceWriter } from './trace.js';
import { ModelRefusalError } from './refusal.js';

const AGY_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const AGY_DOCTOR_TIMEOUT_MS = 90 * 1000;
const AGY_MAX_STDOUT_CHARS = 16 * 1024 * 1024;
const AGY_MAX_STDERR_CHARS = 16 * 1024;
/** Default Claude CLI output cap (CLAUDE_CODE_MAX_OUTPUT_TOKENS): the Opus 5.5 / Sonnet 5 ceiling. */
export const CLAUDE_DEFAULT_MAX_OUTPUT_TOKENS = 128000;
/** Claude Code's text when the API declines a request on usage-policy grounds. */
const CLAUDE_REFUSAL_TEXT = /unable to respond to this request, which appears to violate our Usage Policy/i;

/** Schema enforced on AGY's terminal result. Keep this in sync with the Zod validator below. */
export const AGY_REVIEW_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['post_review', 'skip_review'] },
    reason: { type: 'string', minLength: 1 },
    body: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          start_line: { type: 'integer', minimum: 1 },
          start_side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          body: { type: 'string', minLength: 1 },
        },
        required: ['path', 'line', 'body'],
      },
    },
  },
  required: ['decision', 'reason', 'body', 'comments'],
  if: { properties: { decision: { const: 'post_review' } } },
  then: { properties: { comments: { minItems: 1 } } },
  else: { properties: { comments: { maxItems: 0 } } },
});

const AgyComment = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  start_line: z.number().int().positive().optional(),
  start_side: z.enum(['LEFT', 'RIGHT']).optional(),
  body: z.string().min(1),
});

const AgyReviewResult = z.object({
  decision: z.enum(['post_review', 'skip_review']),
  reason: z.string().min(1),
  body: z.string(),
  comments: z.array(AgyComment),
});

type AgyReviewResult = z.infer<typeof AgyReviewResult>;

export interface AgyUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly thinking_tokens?: number;
  readonly total_tokens?: number;
}

export interface AgyCliResult {
  readonly conversation_id?: string;
  readonly status?: string;
  readonly response?: string;
  readonly error?: string;
  readonly structured_output?: unknown;
  readonly usage?: AgyUsage;
  /** Set when the model declined the request (Claude `stop_reason: "refusal"`). */
  readonly refusal?: { readonly category: string };
}

interface AgyToolInfo {
  readonly name?: string;
  readonly output?: unknown;
  readonly error?: { readonly message?: unknown } | unknown;
}

export interface AgyStepUpdate {
  readonly step_index?: number;
  readonly state?: string;
  readonly step_type?: string;
  readonly tool_name?: string;
  readonly text_delta?: string;
  readonly usage?: AgyUsage;
  readonly tool_info?: AgyToolInfo;
}

interface AgyToolStep {
  readonly name: string;
  readonly output?: unknown;
  readonly error?: unknown;
}

export interface AgyCliRun {
  readonly result: AgyCliResult;
  readonly stepCount: number;
  readonly inspections: number;
  readonly toolErrors: number;
  readonly toolSteps: readonly AgyToolStep[];
}

export interface RunAgyCliOptions {
  readonly spec: ModelSpec;
  readonly prompt: string;
  readonly cwd: string;
  readonly schema?: string;
  readonly timeoutMs?: number;
  readonly diffRange?: string;
  readonly maxSteps?: number;
  readonly maxOutputTokens?: number;
  readonly probe?: boolean;
  readonly signal?: AbortSignal;
  readonly onStep?: (step: AgyStepUpdate) => void;
}

/** Run one AGY headless turn using its own cached OAuth session. */
export function runAgyCli(opts: RunAgyCliOptions): Promise<AgyCliRun> {
  opts.signal?.throwIfAborted();
  const claude = opts.spec.api === 'claude';
  const command = opts.spec.command?.trim() || (claude ? 'claude' : process.env.REVUTO_AGY_COMMAND?.trim() || 'agy');
  const timeoutMs = opts.timeoutMs ?? AGY_DEFAULT_TIMEOUT_MS;
  const maxSteps = opts.maxSteps ?? 150;
  const maxOutputTokens = opts.maxOutputTokens ?? CLAUDE_DEFAULT_MAX_OUTPUT_TOKENS;
  if (claude && (![maxSteps, maxOutputTokens].every(n => Number.isSafeInteger(n) && n > 0))) {
    return Promise.reject(new Error('Claude review step and output limits must be positive integers'));
  }
  const args = [
    '-p',
    ...(claude ? [] : [opts.prompt]),
    '--model',
    opts.spec.model,
    '--output-format',
    'stream-json',
  ];
  if (claude) {
    args.push('--verbose', '--bare', '--restricted', '--setting-sources', '', '--no-session-persistence',
      '--input-format', 'text',
      '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: opts.probe ? {} : { revuto: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./claude-review-mcp.js', import.meta.url)), opts.cwd, opts.diffRange ?? ''],
      } } }),
      '--permission-mode', 'dontAsk', '--tools', '',
      '--max-turns', String(maxSteps),
      '--allowedTools', opts.probe ? '' : 'mcp__revuto__read,mcp__revuto__grep,mcp__revuto__glob,mcp__revuto__pr_diff');
    if (opts.spec.reasoningEffort) args.push('--effort', opts.spec.reasoningEffort);
  } else {
    args.push('--print-timeout', timeoutArg(timeoutMs));
  }
  if (opts.schema) args.push('--json-schema', opts.schema);
  if (!claude && opts.spec.permissionMode === 'bypass') args.push('--dangerously-skip-permissions');

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        detached: process.platform !== 'win32',
        cwd: opts.cwd,
        env: claude ? { ...claudeEnvironment(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) } : { ...process.env, AGY_CLI_HIDE_LOGO: 'true' },
        stdio: [claude ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    let aborted = false;
    let pendingError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      killReviewChild(child);
      killTimer ??= setTimeout(() => killReviewChild(child, 'SIGKILL'), 2000);
    };
    const abort = () => { aborted = true; terminate(); };
    opts.signal?.addEventListener('abort', abort, { once: true });
    let lineBuffer = '';
    const decoder = new StringDecoder('utf8');
    let stdoutChars = 0;
    let stderr = '';
    let result: AgyCliResult | undefined;
    let refusal: { category: string } | undefined;
    let stepCount = 0;
    let inspections = 0;
    let toolErrors = 0;
    const toolSteps: AgyToolStep[] = [];

    const timer = setTimeout(() => {
      stopWithError(new Error(`AGY timed out after ${timeoutArg(timeoutMs)}`));
    }, timeoutMs);

    const stopWithError = (error: Error): void => {
      pendingError ??= error;
      clearTimeout(timer);
      terminate();
    };

    const finishError = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      reject(err);
    };

    const stdout = child.stdout;
    const stderrStream = child.stderr;
    if (!stdout || !stderrStream) {
      stopWithError(new Error('AGY was not started with piped stdout/stderr'));
      return;
    }

    const toolNames = new Map<string, string>();
    const handleRecord = (record: Record<string, unknown>): void => {
      if (record.event === 'step_update') {
        const update = record.step_update;
        if (!update || typeof update !== 'object') return;
        const step = update as AgyStepUpdate;
        stepCount++;
        opts.onStep?.(step);
        if (step.step_type !== 'tool') return;
        const info = step.tool_info;
        const name = step.tool_name || info?.name || 'agy_tool';
        // Producing the verdict is not an inspection of repository evidence.
        if (claude && !['mcp__revuto__read', 'mcp__revuto__grep', 'mcp__revuto__glob', 'mcp__revuto__pr_diff'].includes(name)) return;
        const error = info?.error;
        toolSteps.push({ name, output: info?.output, error });
        if (error === undefined || error === null) inspections++;
        else toolErrors++;
        return;
      }
      if (record.event === 'refusal') {
        refusal ??= { category: String(record.category ?? 'unknown') };
        return;
      }
      if (record.event === 'result' && record.result && typeof record.result === 'object') {
        result = record.result as AgyCliResult;
        if (result.refusal) refusal ??= { category: result.refusal.category };
      }
    };

    const handleLine = (line: string): void => {
      if (!line.trim() || settled || pendingError) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        stopWithError(new Error('Native CLI emitted a non-JSON line in stream-json mode'));
        return;
      }
      if (!event || typeof event !== 'object') return;
      const record = event as Record<string, unknown>;
      for (const normalized of claude ? normalizeClaudeEvents(record, toolNames) : [record]) {
        handleRecord(normalized);
      }
    };

    stdout.on('data', (chunk: Buffer) => {
      if (settled || pendingError) return;
      stdoutChars += chunk.length;
      if (stdoutChars > AGY_MAX_STDOUT_CHARS) {
        stopWithError(new Error(`AGY output exceeded ${AGY_MAX_STDOUT_CHARS} bytes`));
        return;
      }
      lineBuffer += decoder.write(chunk);
      let newline: number;
      while ((newline = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newline + 1);
        handleLine(line);
        if (settled) return;
      }
    });
    stderrStream.on('data', (chunk: Buffer) => {
      if (stderr.length < AGY_MAX_STDERR_CHARS) stderr += chunk.toString('utf8').slice(0, AGY_MAX_STDERR_CHARS - stderr.length);
    });
    child.on('error', (err) => finishError(err));
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', abort);
      if (settled) return;
      if (aborted) { finishError(opts.signal?.reason ?? new Error('Review cancelled')); return; }
      if (pendingError) { finishError(pendingError); return; }
      lineBuffer += decoder.end();
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (settled) return;
      // A refusal comes back as a normal (or error) result; branch on it first so
      // the caller can try the next configured model.
      if (refusal) {
        finishError(new ModelRefusalError(opts.spec.model, refusal.category));
        return;
      }
      if (code !== 0) {
        const detail = result?.error || stderr.trim().slice(-1000);
        finishError(new Error(`AGY exited with status ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (!result) {
        finishError(new Error('AGY exited without a result event'));
        return;
      }
      if (result.status !== 'SUCCESS') {
        finishError(new Error(`AGY run failed${result.error ? `: ${result.error}` : ''}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ result, stepCount, inspections, toolErrors, toolSteps });
    });
    if (claude) {
      child.stdin!.on('error', stopWithError);
      child.stdin!.end(opts.prompt);
    }
    if (opts.signal?.aborted) abort();
  });
}

/** Small live probe used by `revuto doctor` without creating a review trace. */
export async function probeAgy(spec: ModelSpec, cwd: string): Promise<AgyCliRun> {
  const result = await runAgyCli({
    spec: spec.api === 'claude' ? { ...spec, reasoningEffort: 'low' } : spec,
    cwd,
    prompt: 'Return exactly AGY_REVUTO_DOCTOR_OK and nothing else.',
    timeoutMs: AGY_DOCTOR_TIMEOUT_MS,
    probe: true,
    maxSteps: 1,
    maxOutputTokens: 32,
  });
  if (result.result.response?.trim() !== 'AGY_REVUTO_DOCTOR_OK') throw new Error('Native doctor probe returned an unexpected response');
  return result;
}

export interface RunAgyReviewOptions {
  readonly signal?: AbortSignal;
  readonly config: ReviewerConfig;
  readonly ctx: PrContext;
  readonly octokit: Octokit;
  readonly token: () => Promise<string>;
  readonly skillMarkdown: string;
  readonly startedAt: Date;
  /** Model label for the signed footer and the outcome; defaults to the spec's name or id. */
  readonly reviewedBy?: string;
}

/** Run the full Revuto review through AGY, then post via Revuto's GitHub tool. */
export async function runAgyReview(opts: RunAgyReviewOptions): Promise<ReviewOutcome> {
  const spec = opts.config.models.review;
  const trace = startReviewTrace({
    vaultPath: opts.config.vaultPath,
    repo: `${opts.ctx.owner}/${opts.ctx.repo}`,
    prNumber: opts.ctx.prNumber,
    headSha: opts.ctx.headSha,
    model: spec.model,
    startedAt: opts.startedAt,
  });

  let run: AgyCliRun;
  try {
    run = await runAgyCli({
      spec,
      cwd: opts.ctx.workspacePath,
      schema: AGY_REVIEW_SCHEMA,
      diffRange: opts.ctx.diffRefSpec,
      maxSteps: opts.config.review.maxSteps,
      maxOutputTokens: opts.config.limits.maxOutputTokens.review,
      signal: opts.signal,
      prompt: buildAgyReviewPrompt(opts.ctx, opts.skillMarkdown, spec.api === 'claude' ? 'claude' : 'agy'),
      onStep: (step) => traceAgyStep(trace, step, spec.api === 'claude' ? 'claude' : 'agy'),
    });
  } catch (err) {
    trace.finish({ terminal: 'none', result: '', inspections: 0, toolErrors: 1, error: errorText(err) });
    throw err;
  }

  let output: AgyReviewResult;
  try {
    opts.signal?.throwIfAborted();
    if (run.inspections === 0) throw new Error('Native review returned without inspecting repository evidence');
    output = AgyReviewResult.parse(run.result.structured_output);
    if (output.decision === 'post_review' && output.comments.length === 0) {
      throw new Error('post_review requires at least one inline comment');
    }
    if (output.decision === 'skip_review' && output.comments.length > 0) {
      throw new Error('skip_review cannot include inline comments');
    }
  } catch (err) {
    const message = `AGY review result was invalid: ${errorText(err)}`;
    trace.finish({ terminal: 'none', result: '', inspections: run.inspections, toolErrors: run.toolErrors + 1, error: message });
    throw new Error(message);
  }

  const reviewedBy = opts.reviewedBy?.trim() || spec.name?.trim() || spec.model;
  const deps = { ctx: opts.ctx, octokit: opts.octokit, token: opts.token, reviewedBy };
  let terminal: ReviewOutcome['terminal'] = 'none';
  let hasFindings = false;
  let result = '';
  let postFailures = 0;
  let toolErrors = run.toolErrors;

  try {
    const payload = output.decision === 'post_review'
      ? await buildPostReviewTool(deps).callback({ body: output.body, comments: output.comments })
      : await buildSkipTool(deps).callback({ reason: output.reason });
    result = resultText(payload);
    if (isToolErrorOutput(payload)) {
      toolErrors++;
      if (output.decision === 'post_review') postFailures++;
    } else {
      terminal = output.decision;
      hasFindings = output.decision === 'post_review';
    }
  } catch (err) {
    result = `ERROR: ${errorText(err)}`;
    toolErrors++;
    if (output.decision === 'post_review') postFailures++;
  }

  const outcome: ReviewOutcome = {
    terminal,
    hasFindings,
    result,
    headSha: opts.ctx.headSha,
    steps: run.stepCount,
    tokens: run.result.usage?.total_tokens ?? 0,
    inspections: run.inspections,
    toolErrors,
    postFailures,
    forcedTerminal: false,
    ranModel: true,
    model: reviewedBy,
  };
  const tracePath = trace.finish({ ...outcome, result: outcome.result.slice(0, 8000), reason: output.reason });
  return { ...outcome, ...(tracePath ? { tracePath } : {}) };
}

/**
 * Review prompt for a native CLI runner. The two runners have different tools:
 * AGY gets the workspace's native read/search/git/command tools, Claude Code
 * gets only the guarded revuto MCP tools. Each prompt names only its own.
 */
export function buildAgyReviewPrompt(ctx: PrContext, skillMarkdown: string, runner: 'agy' | 'claude' = 'agy'): string {
  const setup = runner === 'claude'
    ? [
        `You are Revuto's autonomous pull-request reviewer running inside Claude Code CLI.`,
        `Review exactly the single PR described below. Your tools are mcp__revuto__pr_diff, which returns the PR diff, and mcp__revuto__read, mcp__revuto__grep and mcp__revuto__glob, which read the checked-out PR head. There is no shell, network, or Git access.`,
        `Do not ask questions and do not stop at a plan. Read the diff first, trace impact and callers, apply the repository knowledge, and then decide.`,
        `This is a read-only review. Do not print credentials or remote URLs.`,
      ]
    : [
        `You are Revuto's autonomous pull-request reviewer running inside the Antigravity CLI.`,
        `Review exactly the single PR described below using the native read/search/git/command tools available in this workspace.`,
        `Do not ask questions and do not stop at a plan. Inspect the diff first, trace impact and callers, apply the repository knowledge, and then decide.`,
        `This is a read-only review: do not create, edit, delete, reset, checkout, commit, push, or otherwise mutate files; do not print credentials or remote URLs.`,
      ];
  return [
    ...setup,
    `Post only evidence-backed correctness, safety, or design findings. Do not post style or speculative concerns.`,
    `Inline comments must use a changed file and a line present in the PR diff on the RIGHT side.`,
    `If nothing clears the bar, set decision to skip_review, provide a one-sentence reason, set body to an empty string, and return no comments.`,
    `If there are findings, set decision to post_review, put a concise summary in body, and include one or more precise inline comments.`,
    `Return only the enforced structured result with decision, reason, body, and comments. Never return a simulated GitHub post or an empty findings review.`,
    '',
    renderPrOverviewForAgy(ctx),
    skillMarkdown.trim() ? `\n## Repository knowledge\n\n${skillMarkdown.trim()}` : '',
  ].filter(Boolean).join('\n');
}

function renderPrOverviewForAgy(ctx: PrContext): string {
  const lines = [
    `# PR #${ctx.prNumber}: ${ctx.title}`,
    '',
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Author: ${ctx.author}`,
    `Head: ${ctx.headRef} @ ${ctx.headSha}`,
    `Base: ${ctx.baseRef} @ ${ctx.baseSha}`,
    `Merge-base: ${ctx.mergeBaseSha}`,
    `Diff range: ${ctx.diffRefSpec}`,
    `Workspace: ${ctx.workspacePath} (HEAD is already checked out at the PR tip)`,
    `Size: +${ctx.additions} / -${ctx.deletions} across ${ctx.changedFiles} files`,
    '',
    '## Body',
    ctx.body.trim() || '(empty)',
    '',
    `## Changed files (${ctx.fileList.length})`,
    ...ctx.fileList.map((file) => `- ${file}`),
  ];
  if (ctx.existingReviews.length > 0) {
    lines.push('', `## Existing reviews (${ctx.existingReviews.length})`);
    for (const review of ctx.existingReviews) lines.push(`- ${review.user} (${review.state}) at ${review.submittedAt ?? '?'}: ${review.body.slice(0, 240).replace(/\n/g, ' ')}`);
  }
  if (ctx.existingReviewComments.length > 0) {
    lines.push('', `## Existing inline comments (${ctx.existingReviewComments.length})`);
    for (const comment of ctx.existingReviewComments) lines.push(`- ${comment.user} on ${comment.path}:${comment.line ?? comment.originalLine ?? '?'}: ${comment.body.slice(0, 240).replace(/\n/g, ' ')}`);
  }
  if (ctx.existingIssueComments.length > 0) {
    lines.push('', `## Existing PR comments (${ctx.existingIssueComments.length})`);
    for (const comment of ctx.existingIssueComments) lines.push(`- ${comment.user}: ${comment.body.slice(0, 240).replace(/\n/g, ' ')}`);
  }
  return lines.join('\n');
}

function traceAgyStep(trace: TraceWriter, step: AgyStepUpdate, phase = 'agy'): void {
  const info = step.tool_info;
  const toolName = step.tool_name || info?.name;
  const toolResults = step.step_type === 'tool'
    ? [{
        toolName: toolName || 'agy_tool',
        output: info?.error === undefined || info.error === null
          ? info?.output ?? ''
          : `ERROR: ${errorText(info.error)}`,
      }]
    : undefined;
  trace.step(phase, {
    text: step.text_delta,
    usage: {
      inputTokens: step.usage?.input_tokens,
      outputTokens: step.usage?.output_tokens,
    },
    ...(toolResults ? { toolResults } : {}),
  });
}

/** Adapt Claude Code's documented stream-json events to the native runner contract. */
export function normalizeClaudeEvents(record: Record<string, unknown>, tools: Map<string, string>): Record<string, unknown>[] {
  if (record.type === 'result') {
    const usage = record.usage as Record<string, number> | undefined;
    const refusal = claudeRefusal(record);
    return [{ event: 'result', result: {
      ...(refusal ? { refusal } : {}),
      status: record.subtype === 'success' && record.is_error !== true ? 'SUCCESS' : 'ERROR',
      conversation_id: record.session_id,
      response: record.result,
      error: record.is_error === true || record.subtype !== 'success'
        ? JSON.stringify(record.errors ?? record.result ?? record.subtype) : undefined,
      structured_output: record.structured_output,
      usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0,
        total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
          + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) },
    } }];
  }
  if (record.type === 'system' && record.subtype === 'init') {
    return [{ event: 'step_update', step_update: { step_type: 'text', text_delta: `Claude CLI model: ${String(record.model)}` } }];
  }
  const message = record.message as { content?: Array<Record<string, unknown>>; stop_reason?: unknown; stop_details?: unknown } | undefined;
  const events: Record<string, unknown>[] = [];
  if (record.type === 'assistant' && message?.stop_reason === 'refusal') {
    events.push({ event: 'refusal', category: refusalCategory(message.stop_details) });
  }
  const content = message?.content;
  if (!Array.isArray(content)) return events;
  for (const block of content) {
    if (record.type === 'assistant' && block.type === 'tool_use') {
      tools.set(String(block.id), String(block.name));
    } else if (record.type === 'assistant' && block.type === 'text') {
      events.push({ event: 'step_update', step_update: { step_type: 'text', text_delta: block.text } });
    } else if (record.type === 'user' && block.type === 'tool_result') {
      const id = String(block.tool_use_id);
      events.push({ event: 'step_update', step_update: { step_type: 'tool', tool_name: tools.get(id) ?? 'claude_tool',
        tool_info: { output: block.content, ...(block.is_error ? { error: block.content } : {}) } } });
      tools.delete(id);
    }
  }
  return events;
}

/** A refusal on Claude Code's result event: `stop_reason: "refusal"`, or its usage-policy error text. */
function claudeRefusal(record: Record<string, unknown>): { category: string } | undefined {
  if (record.stop_reason === 'refusal') return { category: refusalCategory(record.stop_details) };
  const text = typeof record.result === 'string' ? record.result : '';
  if (record.is_error === true && CLAUDE_REFUSAL_TEXT.test(text)) return { category: refusalCategory(record.stop_details) };
  return undefined;
}

function refusalCategory(details: unknown): string {
  const category = (details as { category?: unknown } | undefined)?.category;
  return typeof category === 'string' && category.trim() ? category : 'unknown';
}

function timeoutArg(timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

function resultText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
