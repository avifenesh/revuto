/**
 * Embedder abstraction. Optional everywhere: when no embedder is configured,
 * dedup falls back to LLM-judged overlap and skill selection to area-glob match.
 */
import type { ReviewerConfig } from '../config.js';
import { createOpenAICompatEmbedder } from './openai-embedder.js';

export interface Embedder {
  /**
   * Identity of the embedding model. Vectors from different models are not
   * comparable (they can differ in dimension too), so stored embeddings carry
   * this id and lookups only compare vectors with the same one.
   */
  readonly id: string;
  /**
   * Longest input, in characters, the embedder takes. Callers that build a
   * query from parts (skill selection) fit whole parts within it; the embedder
   * itself cuts anything longer. Absent means DEFAULT_EMBED_MAX_INPUT_CHARS.
   */
  readonly maxInputChars?: number;
  /** Embed a batch of texts into vectors. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Default input bound, sized for a 512-token window (bge-small-en-v1.5 served
 * by llama.cpp with `-c 512`, which refuses a longer input outright). Measured
 * with that server's tokenizer: path lists run 2.55 characters per token,
 * README prose 3.34, and a fill of the densest real path terms (short names
 * like `lib`, `bin/cli.js`, `.agnix.toml`, each with a digit suffix) 1.74:
 * 793 characters of it were 454 tokens with CLS and SEP, and 869 were 500. So
 * 800 keeps path-like text under 512 with about 10% to spare. Denser text (hex
 * ids, digit runs) can still overflow; callers treat an embedder error as "no
 * embedding" and fall back.
 */
export const DEFAULT_EMBED_MAX_INPUT_CHARS = 800;

export function embedInputLimit(embedder: Pick<Embedder, 'maxInputChars'>): number {
  return embedder.maxInputChars ?? DEFAULT_EMBED_MAX_INPUT_CHARS;
}

/**
 * `text` cut to at most `max` characters, at the last whitespace when one is
 * in the final quarter, never splitting a surrogate pair.
 */
export function boundEmbedInput(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const space = text.slice(0, max + 1).search(/\s\S*$/);
  if (space >= max * 0.75) end = space;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end).trimEnd();
}

/** The text a concern record is embedded from. Queries embed the same shape. */
export function concernEmbeddingText(subject: string, concern: string): string {
  return `${subject}\n${concern}`;
}

export async function embedOne(embedder: Embedder, text: string): Promise<number[]> {
  const [v] = await embedder.embed([text]);
  return v;
}

/** Build the embedder from config, or null if none is configured. */
export function maybeEmbedder(config: ReviewerConfig): Embedder | null {
  return config.models.embedder ? createOpenAICompatEmbedder(config.models.embedder) : null;
}
