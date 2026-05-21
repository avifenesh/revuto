/**
 * Embedder abstraction. Optional everywhere: when no embedder is configured,
 * dedup falls back to LLM-judged overlap and skill selection to area-glob match.
 */
import type { ReviewerConfig } from '../config.js';
import { createOpenAICompatEmbedder } from './openai-embedder.js';

export interface Embedder {
  /** Embed a batch of texts into vectors. */
  embed(texts: string[]): Promise<number[][]>;
}

export async function embedOne(embedder: Embedder, text: string): Promise<number[]> {
  const [v] = await embedder.embed([text]);
  return v;
}

/** Build the embedder from config, or null if none is configured. */
export function maybeEmbedder(config: ReviewerConfig): Embedder | null {
  return config.models.embedder ? createOpenAICompatEmbedder(config.models.embedder) : null;
}
