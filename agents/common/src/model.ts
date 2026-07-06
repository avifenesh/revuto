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
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import type { ModelSpec } from './config.js';
import { buildResponsesModel } from './responses-model.js';
import { buildConverseModel } from './converse-model.js';

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
  const primary = buildSingleChatModel(spec);
  const fallbacks = (spec.fallbacks ?? []).map(buildChatModel) as LanguageModelV3[];
  return fallbacks.length ? new FallbackLanguageModel([primary, ...fallbacks]) : primary;
}

/** Embedding model — only when an embedder is configured. */
export function buildEmbeddingModel(spec: ModelSpec): EmbeddingModel {
  return provider(spec).textEmbeddingModel(spec.model);
}

function withoutFallbacks(spec: ModelSpec): ModelSpec {
  const { fallbacks, ...single } = spec;
  return single;
}

function buildSingleChatModel(spec: ModelSpec): LanguageModelV3 {
  const single = withoutFallbacks(spec);
  if (single.api === 'responses') return buildResponsesModel(single) as LanguageModelV3;
  if (single.api === 'converse') return buildConverseModel(single) as LanguageModelV3;
  return provider(single).chatModel(single.model) as LanguageModelV3;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
}

class FallbackLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV3['supportedUrls'];

  constructor(private readonly models: readonly LanguageModelV3[]) {
    this.provider = models.map((m) => m.provider).join(' -> ');
    this.modelId = models.map((m) => m.modelId).join(' -> ');
    this.supportedUrls = models[0]?.supportedUrls ?? {};
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    return this.tryModels((model) => model.doGenerate(options));
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return this.tryModels((model) => model.doStream(options));
  }

  private async tryModels<T>(call: (model: LanguageModelV3) => PromiseLike<T>): Promise<T> {
    const failures: string[] = [];
    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[i];
      try {
        return await call(model);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${model.provider}/${model.modelId}: ${message}`);
        if (i < this.models.length - 1) {
          console.warn(`[model-fallback] ${model.provider}/${model.modelId} failed; trying ${this.models[i + 1].provider}/${this.models[i + 1].modelId}`);
        }
      }
    }
    throw new Error(`all model fallbacks failed: ${failures.join(' | ')}`);
  }
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
