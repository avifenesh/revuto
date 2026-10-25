/**
 * Codex CLI adapter for the native review runner.
 *
 * Codex runs headless (`codex exec --json`) on OpenAI (a ChatGPT login or an API
 * key) or Amazon Bedrock, with no user config, no rules, no shell tool and a
 * read-only sandbox. Its only inspection surface is the same guarded revuto MCP
 * server the Claude runner gets: the fixed PR diff plus read/grep/glob over the
 * checked-out head. The verdict is the final agent message, constrained by
 * `--output-schema`.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
export function codexReviewSchema(allowEscalation = false): string {
  return JSON.stringify({
    type: 'object',
    additionalProperties: false,
    properties: {
      decision: { type: 'string', enum: ['post_review', 'skip_review', ...(allowEscalation ? ['escalate'] : [])] },
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
}

export const CODEX_REVIEW_SCHEMA = codexReviewSchema();

const PASSTHROUGH_KEYS = ['USER', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;

/**
 * Codex features that add tools or load state beyond the revuto MCP server:
 * images from anywhere on disk, sub-agents and code mode (which get around
 * review.maxSteps), browsers, apps, plugins, hooks, memories and skills. Set
 * through -c features.<name>=false, which ignores names a Codex build lacks.
 */
export const CODEX_DISABLED_FEATURES = [
  'view_image', 'image_generation', 'multi_agent', 'code_mode', 'code_mode_host', 'goals', 'unified_exec',
  'apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'skill_search', 'skill_mcp_dependency_install',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'browser_annotation_api', 'in_app_browser',
  'computer_use', 'tool_suggest', 'workspace_dependencies', 'worktrees', 'shell_snapshot', 'sleep_tool',
] as const;
/**
 * Model catalog fields that add tools no feature flag removes. GPT-6 entries ask
 * for code mode only (a JavaScript `exec` tool that calls every other tool) and
 * the v2 sub-agent tools, and defer MCP tools behind `tool_search`. Every run
 * gets its catalog with these set, so the model sees the revuto MCP tools
 * directly and nothing else that runs or spawns.
 */
export const CODEX_DIRECT_TOOL_FIELDS = {
  tool_mode: 'direct',
  multi_agent_version: 'disabled',
  supports_search_tool: false,
  apply_patch_tool_type: null,
  experimental_supported_tools: [],
} as const;

/** `codex debug models` arguments: the catalog the review's provider would load. */
export function codexCatalogArgs(spec: ModelSpec): string[] {
  const provider = codexProvider(spec);
  const args = ['debug', 'models', '-c', `model_provider=${JSON.stringify(provider)}`];
  if (provider === 'amazon-bedrock') {
    args.push('-c', `model_providers.amazon-bedrock.aws.region=${JSON.stringify(spec.awsRegion?.trim() || CODEX_DEFAULT_REGION)}`);
  }
  return args;
}

/** The `codex debug models` output with every model set to direct tools only. */
export function restrictCodexCatalog(output: string): string {
  const start = output.indexOf('{');
  const catalog = start < 0 ? undefined : JSON.parse(output.slice(start)) as { models?: unknown };
  if (!catalog || !Array.isArray(catalog.models)) throw new Error('Codex model catalog has no models list');
  return JSON.stringify({ ...catalog, models: catalog.models.map((model) => ({ ...(model as object), ...CODEX_DIRECT_TOOL_FIELDS })) });
}

// Bedrock authentication on the Bedrock provider only. No GitHub token, no shell settings.
const AWS_KEYS = [
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
] as const;

/** The Codex model provider a spec runs on: `codex://openai` is OpenAI, anything else Bedrock. */
export function codexProvider(spec: ModelSpec): 'openai' | 'amazon-bedrock' {
  return spec.baseURL === 'codex://openai' ? 'openai' : 'amazon-bedrock';
}

/** A Codex reviewer that runs on the operator's ChatGPT login. */
export function codexUsesLogin(spec: ModelSpec): boolean {
  return codexProvider(spec) === 'openai' && spec.auth === 'subscription';
}

/**
 * Revuto's own Codex home, holding only its ChatGPT login (`CODEX_HOME=<dir> codex login`).
 * It is kept apart from ~/.codex so the operator's config, AGENTS.md, skills and
 * sessions never reach a review. Every login review runs in this one home, so a
 * token refresh lands where the next review reads it; a per-run copy would strand
 * the rotated refresh token.
 */
export function revutoCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  // Resolved here: Codex runs with the PR checkout as its cwd, so a relative path would land inside it.
  return resolve(env.REVUTO_CODEX_HOME?.trim() || join(env.HOME ?? homedir(), '.config', 'revuto', 'codex'));
}

/**
 * The environment a Codex review runs with: its CODEX_HOME, a scratch HOME (so
 * the operator's ~/.agents skills and dotfiles never load), plus the credentials
 * of its provider. Bedrock gets the AWS keys, with the shared AWS files pinned to
 * the operator's real ones; an OpenAI API key reaches Codex as CODEX_API_KEY, and
 * a ChatGPT login needs nothing beyond the home.
 */
export function codexEnvironment(codexHome: string, spec: ModelSpec, env: NodeJS.ProcessEnv = process.env, scratchHome?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  if (scratchHome) result.HOME = scratchHome;
  else if (env.HOME !== undefined) result.HOME = env.HOME;
  for (const key of PASSTHROUGH_KEYS) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  if (codexProvider(spec) === 'amazon-bedrock') {
    for (const key of AWS_KEYS) {
      if (env[key] !== undefined) result[key] = env[key];
    }
    const realHome = env.HOME ?? homedir();
    result.AWS_CONFIG_FILE ??= join(realHome, '.aws', 'config');
    result.AWS_SHARED_CREDENTIALS_FILE ??= join(realHome, '.aws', 'credentials');
  } else if (!codexUsesLogin(spec)) {
    const keyEnv = spec.apiKeyEnv?.trim() || 'OPENAI_API_KEY';
    const key = env[keyEnv]?.trim();
    if (!key) throw new Error('Codex on OpenAI needs an API key in its apiKeyEnv variable (default OPENAI_API_KEY)');
    result.CODEX_API_KEY = key;
  }
  return result;
}

export interface CodexArgsOptions {
  readonly spec: ModelSpec;
  readonly cwd: string;
  /** Path of the guarded MCP server script; omitted for the doctor probe. */
  readonly mcpServer?: { readonly command: string; readonly args: readonly string[] };
  readonly schemaPath?: string;
  /** The restricted model catalog (`restrictCodexCatalog`). */
  readonly catalogPath?: string;
}

/** `codex exec` arguments for one review turn. The prompt is read from stdin (`-`). */
export function codexExecArgs(opts: CodexArgsOptions): string[] {
  const toml = (value: string) => JSON.stringify(value);
  const provider = codexProvider(opts.spec);
  const args = [
    'exec',
    '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool',
    '-c', `web_search=${toml('disabled')}`,
    '-c', `approval_policy=${toml('never')}`,
    // The checkout is untrusted: its AGENTS.md and skills, and those under the
    // operator's HOME, must not reach the model as instructions.
    '-c', 'project_doc_max_bytes=0',
    '-c', 'skills.include_instructions=false',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
    // Sub-agents would run outside revuto's step count: one thread, no depth.
    '-c', 'agents.max_concurrent_threads_per_session=1',
    '-c', 'agents.max_depth=0',
    // Exec has nobody to answer a question.
    '-c', 'tools.experimental_request_user_input.enabled=false',
    '-c', `model_provider=${toml(provider)}`,
  ];
  if (opts.catalogPath) args.push('-c', `model_catalog_json=${toml(opts.catalogPath)}`);
  if (provider === 'amazon-bedrock') {
    const region = opts.spec.awsRegion?.trim() || CODEX_DEFAULT_REGION;
    args.push('-c', `model_providers.amazon-bedrock.aws.region=${toml(region)}`);
  }
  args.push('-m', opts.spec.model);
  // OpenAI's own catalog knows its context windows; Bedrock ids are missing from it.
  if (provider === 'amazon-bedrock') args.push('-c', `model_context_window=${CODEX_CONTEXT_WINDOW}`);
  args.push('-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKENS}`);
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

/** `codex exec --json` item types that are not tool calls. */
const CODEX_NON_TOOL_ITEMS = new Set(['agent_message', 'reasoning', 'error', 'todo_list']);

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
    // Any other tool-like item (a command, a sub-agent, code mode, a file change)
    // is not evidence, but it is a tool call: it counts toward review.maxSteps.
    if (typeof item.type === 'string' && !CODEX_NON_TOOL_ITEMS.has(item.type)) {
      return [{ event: 'step_update', step_update: { step_type: 'tool', tool_name: `codex.${item.type}`, tool_info: { output: '' } } }];
    }
    // Reasoning summaries, config warnings and plans are not tool calls.
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
