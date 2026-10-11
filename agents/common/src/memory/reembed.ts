/**
 * Backfill for concern embeddings without a model tag: records embedded before
 * embeddings carried the embedder id, and records stored while no embedder was
 * configured or reachable. Re-embedding them with the current embedder retires
 * the length-match fallback in nearestConcerns for those records.
 */
import type { KnowledgeStore } from '../store/store.js';
import { type Embedder, concernEmbeddingText } from './embedder.js';

export interface ReembedResult {
  /** Untagged records found. */
  readonly found: number;
  /** Records written. Fewer than `found` when a record changed while this ran. */
  readonly written: number;
}

export async function reembedUntaggedConcerns(store: KnowledgeStore, embedder: Embedder): Promise<ReembedResult> {
  const records = await store.untaggedConcerns();
  if (records.length === 0) return { found: 0, written: 0 };
  const vectors = await embedder.embed(records.map((r) => concernEmbeddingText(r.subject, r.concern)));
  let written = 0;
  for (let i = 0; i < records.length; i++) {
    if (await store.setConcernEmbedding(records[i], vectors[i], embedder.id)) written++;
  }
  return { found: records.length, written };
}
