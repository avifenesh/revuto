/**
 * Curator run loop — the learning agent. Replaces the AgentCore container
 * entrypoint. Called by the daemon's learn job (and the CLI) once per filtered
 * feedback event with the per-repo store + optional embedder.
 */
import { generateText, stepCountIs, hasToolCall } from 'ai';

import type { ReviewerConfig } from '../../common/src/config.js';
import { buildChatModel } from '../../common/src/model.js';
import type { KnowledgeStore } from '../../common/src/store/store.js';
import type { Embedder } from '../../common/src/memory/embedder.js';
import { CURATOR_SYSTEM_PROMPT } from './prompts/curator-system.js';
import { assembleCuratorTools } from './tools/index.js';
import { toAiSdkTools } from '../../common/src/tool-def.js';

export const GRADUATION_THRESHOLD = 4;
const CURATOR_MAX_STEPS = 40;
const CURATOR_MAX_OUTPUT_TOKENS = 16384;

export interface FeedbackEvent {
  readonly feedbackId: string;
  readonly kind: 'review_comment_reply' | 'issue_comment_reply' | 'reaction' | 'resolution';
  readonly body: string;
  readonly botComment: { body: string; path?: string; line?: number; prNumber: number; repo: string };
  readonly actor?: string;
  readonly touchedFiles: readonly string[];
}

export interface CuratorOutcome {
  readonly decision: string | null;
  readonly summary: string;
}

export interface RunCuratorOptions {
  readonly config: ReviewerConfig;
  readonly store: KnowledgeStore;
  readonly embedder: Embedder | null;
  readonly feedback: FeedbackEvent;
}

export async function runCurator(opts: RunCuratorOptions): Promise<CuratorOutcome> {
  const tools = toAiSdkTools(assembleCuratorTools({ store: opts.store, embedder: opts.embedder }));

  const { steps } = await generateText({
    model: buildChatModel(opts.config.models.curator),
    system: CURATOR_SYSTEM_PROMPT,
    prompt: renderFeedback(opts.feedback),
    tools,
    stopWhen: [stepCountIs(CURATOR_MAX_STEPS), hasToolCall('curator_done')],
    maxOutputTokens: CURATOR_MAX_OUTPUT_TOKENS,
  });

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
  return { decision, summary };
}

function renderFeedback(f: FeedbackEvent): string {
  const lines: string[] = [];
  lines.push(`# Feedback event ${f.feedbackId}`);
  lines.push('');
  lines.push(`- Kind: ${f.kind}`);
  lines.push(`- Repo / PR: ${f.botComment.repo} / #${f.botComment.prNumber}`);
  if (f.botComment.path) lines.push(`- Anchor: ${f.botComment.path}:${f.botComment.line ?? '?'}`);
  if (f.touchedFiles.length) lines.push(`- Touched files (up to 20): ${f.touchedFiles.slice(0, 20).join(', ')}`);
  lines.push('');
  lines.push('## Bot comment (what the human is responding to)', '', f.botComment.body.trim() || '(empty)', '');
  lines.push('## Human feedback', '', f.body.trim() || '(empty — reaction or resolution)', '');
  lines.push('---', '');
  lines.push(`Decide bump / merge / create / drop / graduation / noop. Graduation threshold is ${GRADUATION_THRESHOLD} reinforcements. Call \`curator_done\` once when finished.`);
  return lines.join('\n');
}
