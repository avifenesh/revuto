/**
 * Codex CLI adapter for the native review runner.
 *
 * Codex runs headless (`codex exec --json`) against Amazon Bedrock with no user
 * config, no rules, no shell tool and a read-only sandbox. Its only inspection
 * surface is the same guarded revuto MCP server the Claude runner gets: the
 * fixed PR diff plus read/grep/glob over the checked-out head. The verdict is
 * the final agent message, constrained by `--output-schema`.
 */
import type { ModelSpec } from './config.js';

/** Bedrock region for Codex when the spec sets none: the GPT-6 family is served from us-east-1. */
export const CODEX_DEFAULT_REGION = 'us-east-1';
/**
 * Context window passed to Codex. Its bundled catalog lists 272K for every GPT
 * model and has no entry for newer ids; GPT-6.1 Sol on Bedrock accepts 868K
 * input tokens, and the hard input cap is 922K.
 */
export const CODEX_CONTEXT_WINDOW = 900_000;
/**
 * Codex compacts the conversation past this size. A request over 272K input
 * tokens is billed at the long-context rate for the whole request, so the
 * review keeps each request under that step.
 */
export const CODEX_AUTO_COMPACT_TOKENS = 250_000;

/** The revuto MCP tools, in the names Codex reports them as (`server.tool`). */
const CODEX_INSPECTION_TOOLS = new Map([
  ['revuto.read', 'mcp__revuto__read'],
  ['revuto.grep', 'mcp__revuto__grep'],
  ['revuto.glob', 'mcp__revuto__glob'],
  ['revuto.pr_diff', 'mcp__revuto__pr_diff'],
  ['revuto.new_changes', 'mcp__revuto__new_changes'],
]);

/**
 * Strict structured-output schema for Codex. OpenAI strict mode needs every
 * property required and no conditionals, so optional comment fields are
 * nullable here and dropped before the shared verdict validator runs.
 */
export const CODEX_REVIEW_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['post_review', 'skip_review'] },
    reason: { type: 'string' },
    body: { type: 'string' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: 'integer' },
          side: { type: ['string', 'null'], enum: ['LEFT', 'RIGHT', null] },
          start_line: { type: ['integer', 'null'] },
          start_side: { type: ['string', 'null'], enum: ['LEFT', 'RIGHT', null] },
          body: { type: 'string' },
        },
        required: ['path', 'line', 'side', 'start_line', 'start_side', 'body'],
      },
    },
  },
  required: ['decision', 'reason', 'body', 'comments'],
});

const PASSTHROUGH_KEYS = ['HOME', 'USER', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;
// Bedrock authentication only. No GitHub token, no OpenAI key, no shell settings.
const AWS_KEYS = [
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
] as const;

/** The environment a Codex review runs with: a private CODEX_HOME plus Bedrock credentials. */
export function codexEnvironment(codexHome: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const key of [...PASSTHROUGH_KEYS, ...AWS_KEYS]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}

export interface CodexArgsOptions {
  readonly spec: ModelSpec;
  readonly cwd: string;
  /** Path of the guarded MCP server script; omitted for the doctor probe. */
  readonly mcpServer?: { readonly command: string; readonly args: readonly string[] };
  readonly schemaPath?: string;
}

/** `codex exec` arguments for one review turn. The prompt is read from stdin (`-`). */
export function codexExecArgs(opts: CodexArgsOptions): string[] {
  const toml = (value: string) => JSON.stringify(value);
  const region = opts.spec.awsRegion?.trim() || CODEX_DEFAULT_REGION;
  const args = [
    'exec',
    '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool',
    '-c', `web_search=${toml('disabled')}`,
    '-c', `approval_policy=${toml('never')}`,
    '-c', `model_provider=${toml('amazon-bedrock')}`,
    '-c', `model_providers.amazon-bedrock.aws.region=${toml(region)}`,
    '-m', opts.spec.model,
    '-c', `model_context_window=${CODEX_CONTEXT_WINDOW}`,
    '-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKENS}`,
  ];
  if (opts.spec.reasoningEffort) args.push('-c', `model_reasoning_effort=${toml(opts.spec.reasoningEffort)}`);
  if (opts.mcpServer) {
    args.push(
      '-c', `mcp_servers.revuto.command=${toml(opts.mcpServer.command)}`,
      '-c', `mcp_servers.revuto.args=[${opts.mcpServer.args.map(toml).join(',')}]`,
    );
  }
  args.push('--skip-git-repo-check', '-C', opts.cwd, '--sandbox', 'read-only', '--ephemeral', '--json');
  if (opts.schemaPath) args.push('--output-schema', opts.schemaPath);
  args.push('-');
  return args;
}

/** Codex error codes for a request the provider declined on policy grounds. */
const CODEX_POLICY_CODES = /\b(cyber_policy|bio_policy|misalignment_policy_violation|invalid_prompt|content_policy|policy_violation)\b/i;
/**
 * Policy wording in a failed turn's message. Only phrases tied to a policy or
 * safety decision: transport errors ("Connection refused", ECONNREFUSED) must
 * stay ordinary failures, not switch the review to another model.
 */
const CODEX_POLICY_TEXT = /\busage polic(y|ies)\b|\bsafety (system|check|polic(y|ies))\b|\bflagged\b.{0,60}\b(policy|safety|moderation)\b|\bviolat(es|ed|ion of)\b.{0,40}\bpolic(y|ies)\b|\b(request|prompt|content) (was )?refused\b/i;
/** A final message that declines instead of returning the verdict. */
const CODEX_REFUSAL_TEXT = /^\s*(i['’]m sorry|sorry)?[,.]?\s*(but\s+)?i\s+(can(no|['’])t|am unable to|won['’]t)\s+(help|assist|comply|do that|review|continue)/i;

/** What the Codex adapter carries across events of one run. */
export interface CodexStreamState {
  threadId?: string;
  lastMessage?: string;
}

/** Adapt `codex exec --json` events to the native runner contract (`step_update` / `result`). */
export function normalizeCodexEvents(record: Record<string, unknown>, state: CodexStreamState): Record<string, unknown>[] {
  if (record.type === 'thread.started') {
    if (typeof record.thread_id === 'string') state.threadId = record.thread_id;
    return [];
  }
  if (record.type === 'item.completed') {
    const item = record.item as Record<string, unknown> | undefined;
    if (!item) return [];
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      state.lastMessage = item.text;
      return [{ event: 'step_update', step_update: { step_type: 'text', text_delta: item.text } }];
    }
    if (item.type === 'mcp_tool_call') {
      const raw = `${String(item.server ?? '')}.${String(item.tool ?? '')}`;
      const output = toolOutput(item.result);
      const failed = item.status === 'failed' || (item.error !== undefined && item.error !== null) || /^ERROR:/.test(output);
      return [{ event: 'step_update', step_update: { step_type: 'tool', tool_name: CODEX_INSPECTION_TOOLS.get(raw) ?? raw,
        tool_info: { output, ...(failed ? { error: item.error ?? output } : {}) } } }];
    }
    // Reasoning summaries, config warnings and other items are not inspection evidence.
    return [];
  }
  if (record.type === 'turn.completed') {
    const usage = record.usage as Record<string, number> | undefined;
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const verdict = parseVerdict(state.lastMessage);
    // A declined request comes back as plain text instead of the schema's JSON.
    const declined = verdict === undefined && CODEX_REFUSAL_TEXT.test(state.lastMessage ?? '');
    return [{ event: 'result', result: {
      ...(declined ? { refusal: { category: 'declined' } } : {}),
      status: 'SUCCESS',
      conversation_id: state.threadId,
      response: state.lastMessage,
      structured_output: verdict,
      usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    } }];
  }
  if (record.type === 'turn.failed') {
    const message = String((record.error as { message?: unknown } | undefined)?.message ?? 'Codex turn failed');
    const refusal = codexRefusal(record.error, message);
    return [{ event: 'result', result: { ...(refusal ? { refusal } : {}), status: 'ERROR', conversation_id: state.threadId, error: message } }];
  }
  // `error` events are reconnect notices; a turn that cannot recover ends in turn.failed.
  return [];
}

/** A failed turn the provider declined: a policy error code anywhere in the error, or policy wording in its message. */
function codexRefusal(error: unknown, message: string): { category: string } | undefined {
  const raw = JSON.stringify(error ?? null);
  const code = raw.match(CODEX_POLICY_CODES)?.[1] ?? message.match(CODEX_POLICY_CODES)?.[1];
  if (code) return { category: code.toLowerCase() };
  return CODEX_POLICY_TEXT.test(message) ? { category: 'policy' } : undefined;
}

function toolOutput(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null | undefined)?.content;
  if (Array.isArray(content)) return content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
  return result === undefined || result === null ? '' : JSON.stringify(result);
}

/** The final agent message as a verdict object, with the strict schema's null placeholders removed. */
function parseVerdict(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return value;
  const verdict = value as { comments?: unknown };
  if (!Array.isArray(verdict.comments)) return value;
  return {
    ...verdict,
    comments: verdict.comments.map((c) => (c && typeof c === 'object'
      ? Object.fromEntries(Object.entries(c as Record<string, unknown>).filter(([, v]) => v !== null))
      : c)),
  };
}
