/**
 * Supplier-agnostic model factory.
 *
 * Every LLM/embedding call in the engine goes through an OpenAI-compatible
 * provider built here from a `ModelSpec` ({ baseURL, model, apiKeyEnv }). That
 * makes Bedrock (via an OpenAI-compatible gateway such as LiteLLM), xAI/Grok,
 * GLM, a local vLLM/Ollama endpoint, etc. interchangeable per role — no
 * provider-specific code anywhere else.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, EmbeddingModel } from 'ai';
import type { ModelSpec } from './config.js';

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
  return provider(spec).chatModel(spec.model);
}

/** Embedding model — only when an embedder is configured. */
export function buildEmbeddingModel(spec: ModelSpec): EmbeddingModel {
  return provider(spec).textEmbeddingModel(spec.model);
}
