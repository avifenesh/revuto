/**
 * Curator run loop — the learning agent. Replaces the AgentCore container
 * entrypoint. Called by the daemon's learn job (and the CLI) once per filtered
 * feedback event with the per-repo store + optional embedder.
 */
import { generateText, stepCountIs, hasToolCall } from 'ai';

import type { ReviewerConfig } from '../../common/src/config.js';
import { buildChatModel, tokensFrom, needsToolUseEnforcement, TOOL_USE_ENFORCEMENT } from '../../common/src/model.js';
import type { KnowledgeStore } from '../../common/src/store/store.js';
import type { Embedder } from '../../common/src/memory/embedder.js';
import { CURATOR_SYSTEM_PROMPT } from './prompts/curator-system.js';
import { assembleCuratorTools } from './tools/index.js';
import { toAiSdkTools } from '../../common/src/tool-def.js';

export const GRADUATION_THRESHOLD = 4;
const CURATOR_MAX_STEPS = 40;

export interface FeedbackEvent {
  readonly feedbackId: string;
  /** A maintainer's own review comment, or a reply to one of the reviewer's comments. */
  readonly kind: 'review_comment' | 'review_comment_reply';
  readonly body: string;
  readonly repo: string;
  readonly prNumber: number;
  /** File/line the comment is anchored to (if a review comment). */
  readonly anchorPath?: string;
  readonly anchorLine?: number;
  /** The reviewer's comment being replied to — present only for review_comment_reply. */
  readonly inReplyToBot?: string;
  readonly actor?: string;
  readonly touchedFiles: readonly string[];
}

export interface CuratorOutcome {
  readonly decision: string | null;
  readonly summary: string;
  /** Total tokens used by this curator run (for daily-budget accounting). */
  readonly tokens: number;
}

export interface RunCuratorOptions {
  readonly config: ReviewerConfig;
  readonly store: KnowledgeStore;
  readonly embedder: Embedder | null;
  readonly feedback: FeedbackEvent;
  readonly autoActivate?: boolean;
}

export async function runCurator(opts: RunCuratorOptions): Promise<CuratorOutcome> {
  const tools = toAiSdkTools(assembleCuratorTools({
    store: opts.store,
    embedder: opts.embedder,
    autoActivate: opts.autoActivate,
  }));

  const model = buildChatModel(opts.config.models.curator);
  const maxOutputTokens = opts.config.limits.maxOutputTokens.curator;
  let system = CURATOR_SYSTEM_PROMPT;
  // Tool-shy models (GLM, etc.) tend to end with prose instead of calling curator_done.
  if (needsToolUseEnforcement(opts.config.models.curator)) system += TOOL_USE_ENFORCEMENT;
  const prompt = renderFeedback(opts.feedback);

  const main = await generateText({
    model,
    system,
    prompt,
    tools,
    stopWhen: [stepCountIs(CURATOR_MAX_STEPS), hasToolCall('curator_done')],
    maxOutputTokens,
  });

  let steps: Array<{ toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown }> }> = [...main.steps];
  let tokens = tokensFrom(main.usage);

  // Force a decision if the model ended without recording one (see run-agent for the GLM rationale).
  if (!hasCuratorDone(main.steps)) {
    const forced = await generateText({
      model,
      system,
      messages: [
        { role: 'user', content: prompt },
        ...main.response.messages,
        { role: 'user', content: 'You ended without recording a decision. Call `curator_done` now with your decision and summary — respond only with that tool call.' },
      ],
      tools: { curator_done: tools.curator_done },
      toolChoice: 'required',
      stopWhen: [stepCountIs(2), hasToolCall('curator_done')],
      maxOutputTokens,
    });
    steps = [...main.steps, ...forced.steps];
    tokens += tokensFrom(forced.usage);
  }

  let decision: string | null = null;
  let summary = '';
  for (const step of steps) {
    for (const tr of (step.toolResults ?? []) as Array<{ toolName: string; output?: unknown; result?: unknown }>) {
      if (tr.toolName !== 'curator_done') continue;
      const payload = tr.output ?? tr.result ?? {};
      try {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : (payload as any);
        decision = parsed.decision ?? null;
        summary = parsed.summary ?? '';
      } catch { /* leave defaults */ }
    }
  }
  return { decision, summary, tokens };
}

/** Whether any step called the curator's terminal tool. */
function hasCuratorDone(steps: ReadonlyArray<{ toolResults?: Array<{ toolName: string }> }>): boolean {
  return steps.some((s) => (s.toolResults ?? []).some((tr) => tr.toolName === 'curator_done'));
}

function renderFeedback(f: FeedbackEvent): string {
  const lines: string[] = [];
  lines.push(`# Review feedback ${f.feedbackId}`);
  lines.push('');
  lines.push(`- Kind: ${f.kind === 'review_comment_reply' ? 'reply to the reviewer\'s comment' : 'maintainer review comment'}`);
  lines.push(`- Repo / PR: ${f.repo} / #${f.prNumber}`);
  if (f.anchorPath) lines.push(`- Anchor: ${f.anchorPath}:${f.anchorLine ?? '?'}`);
  if (f.actor) lines.push(`- Author: ${f.actor}`);
  if (f.touchedFiles.length) lines.push(`- Touched files (up to 20): ${f.touchedFiles.slice(0, 20).join(', ')}`);
  lines.push('');
  if (f.inReplyToBot) {
    lines.push("## The reviewer's comment being replied to", '', f.inReplyToBot.trim() || '(empty)', '');
    lines.push('## The reply', '', f.body.trim() || '(empty)', '');
  } else {
    lines.push('## Maintainer review comment', '', f.body.trim() || '(empty)', '');
    lines.push('Treat this as observed institutional signal: does it reveal a durable concern, invariant, or intentional carve-out the reviewer should remember? Most comments are routine and should be dropped.', '');
  }
  lines.push('---', '');
  lines.push(`Decide bump / merge / create / drop / graduation / noop. Graduation threshold is ${GRADUATION_THRESHOLD} reinforcements. Call \`curator_done\` once when finished.`);
  return lines.join('\n');
}
