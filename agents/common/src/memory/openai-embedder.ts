/**
 * OpenAI-compatible embedder. Works against any endpoint that exposes an
 * /embeddings route — a local Ollama/vLLM (e.g. Qwen3-Embedding, bge-small) or
 * a cloud provider — configured the same way as the chat models.
 *
 * Every input is cut to the spec's maxInputChars first: a server like llama.cpp
 * refuses an input longer than its window instead of truncating it.
 */
import { embedMany } from 'ai';
import type { ModelSpec } from '../config.js';
import { buildEmbeddingModel } from '../model.js';
import { boundEmbedInput, DEFAULT_EMBED_MAX_INPUT_CHARS, type Embedder } from './embedder.js';

export function createOpenAICompatEmbedder(spec: ModelSpec): Embedder {
  const model = buildEmbeddingModel(spec);
  const maxInputChars = spec.maxInputChars ?? DEFAULT_EMBED_MAX_INPUT_CHARS;
  return {
    id: spec.model,
    maxInputChars,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({ model, values: texts.map((t) => boundEmbedInput(t, maxInputChars)) });
      return embeddings;
    },
  };
}
