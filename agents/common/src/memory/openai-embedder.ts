/**
 * OpenAI-compatible embedder. Works against any endpoint that exposes an
 * /embeddings route — a local Ollama/vLLM (e.g. Qwen3-Embedding, bge-small) or
 * a cloud provider — configured the same way as the chat models.
 */
import { embedMany } from 'ai';
import type { ModelSpec } from '../config.js';
import { buildEmbeddingModel } from '../model.js';
import type { Embedder } from './embedder.js';

export function createOpenAICompatEmbedder(spec: ModelSpec): Embedder {
  const model = buildEmbeddingModel(spec);
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings;
    },
  };
}
