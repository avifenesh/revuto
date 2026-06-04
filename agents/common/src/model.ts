/**
 * Supplier-agnostic model factory.
 *
 * Every LLM/embedding call in the engine goes through a `ModelSpec`. Chat
 * completions use `@ai-sdk/openai-compatible`; providers that expose
 * `/v1/responses` (for example Bedrock Mantle) use the small Responses adapter.
 * That keeps Bedrock, xAI/Grok, GLM, local vLLM/Ollama, etc. interchangeable per
 * role while preserving the endpoint contract each provider actually exposes.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { ModelSpec } from './config.js';
import { buildResponsesModel } from './responses-model.js';

function resolveApiKey(spec: ModelSpec): string {
  if (!spec.apiKeyEnv) return ''; // keyless local endpoints (Ollama/vLLM) are fine
  return process.env[spec.apiKeyEnv] ?? '';
}

function provider(spec: ModelSpec) {
  return createOpenAICompatible({
    name: spec.name ?? new URL(spec.baseURL).host,
    baseURL: spec.baseURL,
    apiKey: resolveApiKey(spec) || undefined,
  });
}

/** Chat/completion model for a role (review, curator, distill). */
export function buildChatModel(spec: ModelSpec): LanguageModel {
  if (spec.api === 'responses') return buildResponsesModel(spec);
  return provider(spec).chatModel(spec.model);
}

/** Embedding model — only when an embedder is configured. */
export function buildEmbeddingModel(spec: ModelSpec): EmbeddingModel {
  return provider(spec).textEmbeddingModel(spec.model);
}

/** Total tokens from a generateText `usage`, for daily-budget accounting. */
export function tokensFrom(usage: unknown): number {
  const u = usage as { totalTokens?: number; outputTokens?: number } | undefined;
  return u?.totalTokens ?? u?.outputTokens ?? 0;
}

// Model families that tend to end a turn with prose instead of calling the
// terminal tool — they need explicit steering. Mirrors hermes-agent's
// TOOL_USE_ENFORCEMENT_MODELS. GLM (z.ai) is the one we hit in practice.
const TOOL_SHY_FAMILIES = ['glm', 'gpt', 'codex', 'gemini', 'gemma', 'grok', 'qwen', 'deepseek', 'kimi'];

/** Whether a model needs the tool-use enforcement guidance appended to its system prompt. */
export function needsToolUseEnforcement(spec: ModelSpec): boolean {
  const m = spec.model.toLowerCase();
  return TOOL_SHY_FAMILIES.some((f) => m.includes(f));
}

/**
 * Appended to a tool-driving agent's system prompt for tool-shy models. Reframed
 * from hermes-agent's TOOL_USE_ENFORCEMENT_GUIDANCE for revuto's terminal-tool loop:
 * the run is wasted unless it ends in a terminal tool call, not prose.
 */
export const TOOL_USE_ENFORCEMENT = `

## Tool-use enforcement

You drive this entirely through tool calls. Do not describe what you would do, summarize
your findings as prose, or end your turn with a plan — a text-only reply posts nothing and
the whole run is wasted. The moment you have gathered enough, make the tool call. Every
response must either make progress via a tool call or finish via your terminal tool. You
MUST end by calling exactly one terminal tool — never with a plain text message.`;
