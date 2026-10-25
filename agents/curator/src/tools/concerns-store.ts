import { z } from 'zod';
import { tool } from '../../../common/src/tool-def.js';
import type { KnowledgeStore } from '../../../common/src/store/store.js';
import { type Embedder, concernEmbeddingText, embedOne } from '../../../common/src/memory/embedder.js';
import type { KnowledgeGuard } from '../../../common/src/knowledge-guard.js';

/**
 * Curator concerns-store tools, backed by the per-repo KnowledgeStore.
 *
 * The store is bound to one repo, so there is no `reviewer_id` — these operate
 * on this repo's concerns only. The curator decides (read candidates, judge
 * overlap); these give it list / find-similar / get / create / bump / merge /
 * delete. When an embedder is configured, `create_concern` and `merge_concerns`
 * store an embedding of subject + concern, tagged with the embedder id, and
 * `find_similar_concerns` uses it to surface overlapping records across buckets.
 */

const concernShape = z.object({
  area: z.array(z.string()).min(1).describe('File-glob patterns this record applies to, e.g. ["src/cluster/**", "src/networking.c"]'),
  subject: z.string().min(1).describe('Short domain label, e.g. "reconnect backoff in cluster client"'),
  concern: z.string().min(1).describe('What the reviewer should do or avoid, 1-3 sentences'),
  context: z.string().describe('The extra-code "why": past incident, maintainer decision, off-thread discussion. Empty if none.'),
});

export interface ConcernsStoreDeps {
  readonly store: KnowledgeStore;
  readonly embedder: Embedder | null;
  /** Approves a concern before it is created or rewritten. The curator always passes one. */
  readonly guard?: KnowledgeGuard;
  readonly repo?: string;
  /** The feedback this run learns from: the guard's evidence for a new concern. */
  readonly source?: string;
}

type ConcernText = { area: readonly string[]; subject: string; concern: string; context: string };

/** A concern record as the guard reads it. */
export function renderConcernForGuard(r: ConcernText): string {
  return [`Subject: ${r.subject}`, `Area: ${r.area.join(', ')}`, `Concern: ${r.concern}`, `Context: ${r.context || '(none)'}`].join('\n');
}

/** How many nearest records find_similar_concerns returns. */
const SIMILAR_LIMIT = 5;

export function buildConcernsStoreTools(deps: ConcernsStoreDeps) {
  const { store, embedder } = deps;
  /** null when approved (or no guard), else the tool's error result. */
  const guardRejects = async (tool: string, record: ConcernText, source = deps.source) => {
    if (!deps.guard) return null;
    const verdict = await deps.guard({ kind: 'concern', repo: deps.repo ?? '', text: renderConcernForGuard(record), ...(source ? { source } : {}) });
    return verdict.approve ? null : `ERROR ${tool}: rejected by the knowledge guard: ${verdict.reason}`;
  };

  /** Embedding of a record's subject + concern, or none without an embedder. */
  const embedConcern = async (subject: string, concern: string) =>
    embedder
      ? { embedding: await embedOne(embedder, concernEmbeddingText(subject, concern)), embeddingModel: embedder.id }
      : {};
  /**
   * embedConcern that never fails the write: an embedder outage (say the local
   * server on :8181 is down) yields no embedding plus a note for the result.
   * The record stays untagged, so `npm run reembed-concerns` embeds it later.
   */
  const embedConcernOrNote = async (subject: string, concern: string, action: string) => {
    try {
      return { embedded: await embedConcern(subject, concern), note: undefined };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { embedded: {}, note: `embedder failed (${msg}); ${action} without an embedding, \`npm run reembed-concerns\` will embed it` };
    }
  };

  const listConcerns = tool({
    name: 'list_concerns',
    description:
`List concern records in an area_bucket, up to 20, newest+most-reinforced first. Call this first with the bucket derived from the feedback's touched files to find candidates the incoming feedback may match. Returns JSON {records:[{record_id, area, subject, concern, context, reinforcement_count, decay_score, updated_at}]}.`,
    inputSchema: z.object({ area_bucket: z.string().describe('e.g. "src" or "src/cluster"') }),
    callback: async (input: { area_bucket: string }) =>
      JSON.stringify({ ok: true, records: await store.listConcerns(input.area_bucket) }),
  });

  const findSimilarConcerns = tool({
    name: 'find_similar_concerns',
    description:
`Find the ${SIMILAR_LIMIT} existing records nearest to a candidate subject + concern by embedding cosine, across ALL area_buckets. Call this before create_concern so a record filed under another bucket is not duplicated. Scores rank candidates; READ the returned records to judge overlap. Returns JSON {records:[{...record, score}]}; without an embedder, records is empty and \`note\` says similarity is unavailable (fall back to list_concerns).`,
    inputSchema: z.object({
      subject: z.string().min(1).describe('Short domain label of the candidate concern'),
      concern: z.string().min(1).describe('What the reviewer should do or avoid, as it would be recorded'),
    }),
    callback: async (input: { subject: string; concern: string }) => {
      if (!embedder) {
        return JSON.stringify({ ok: true, records: [], note: 'similarity unavailable: no embedder configured; use list_concerns per bucket' });
      }
      let query: number[];
      try {
        query = await embedOne(embedder, concernEmbeddingText(input.subject, input.concern));
      } catch (err) {
        return `ERROR find_similar_concerns: similarity unavailable, embedder failed: ${err instanceof Error ? err.message : String(err)}. Use list_concerns per bucket.`;
      }
      const hits = await store.nearestConcerns(query, SIMILAR_LIMIT, embedder.id);
      return JSON.stringify({ ok: true, records: hits.map((h) => ({ ...h.record, score: h.score })) });
    },
  });

  const getConcern = tool({
    name: 'get_concern',
    description: 'Fetch one concern record by record_id. Returns the full record or null.',
    inputSchema: z.object({ record_id: z.string() }),
    callback: async (input: { record_id: string }) =>
      JSON.stringify({ ok: true, record: await store.getConcern(input.record_id) }),
  });

  const createConcern = tool({
    name: 'create_concern',
    description:
`Create a new concern record. Use only when no existing record describes the same concern: check list_concerns for the bucket and find_similar_concerns across buckets first. Do not create on every feedback event. reinforcement_count starts at 1. \`context\` is the extra-code "why" the reviewer cannot get from code alone; empty string if none.`,
    inputSchema: z.object({ area_bucket: z.string(), record: concernShape }),
    callback: async (input) => {
      const rejected = await guardRejects('create_concern', input.record);
      if (rejected) return rejected;
      const { embedded, note } = await embedConcernOrNote(input.record.subject, input.record.concern, 'created');
      const rec = await store.createConcern({ areaBucket: input.area_bucket, ...input.record, ...embedded });
      return JSON.stringify({ ok: true, record_id: rec.recordId, reinforcement_count: rec.reinforcementCount, ...(note ? { note } : {}) });
    },
  });

  const bumpConcern = tool({
    name: 'bump_concern',
    description:
`Reinforce an existing record (matches subject + area + polarity). Increments reinforcement_count, resets decay. Returns the updated record. If reinforcement_count reaches the graduation threshold, graduate it (Phase 2) with submit_skill.`,
    inputSchema: z.object({ record_id: z.string() }),
    callback: async (input: { record_id: string }) => {
      const rec = await store.bumpConcern(input.record_id);
      return rec ? JSON.stringify({ ok: true, record: rec }) : `ERROR bump_concern: record ${input.record_id} not found`;
    },
  });

  const mergeConcerns = tool({
    name: 'merge_concerns',
    description:
`Fold two records describing the same concern into one. Writes \`merged\` onto target, sums reinforcement_counts, deletes source. Use only after reading both and confirming real overlap.`,
    inputSchema: z.object({
      target_record_id: z.string(),
      source_record_id: z.string(),
      merged: concernShape,
    }),
    callback: async (input) => {
      const notFound = `ERROR merge_concerns: target/source not found or identical`;
      if (input.target_record_id === input.source_record_id) return notFound;
      const target = await store.getConcern(input.target_record_id);
      const source = await store.getConcern(input.source_record_id);
      if (!target || !source) return notFound;
      // A merge rewrites vetted text, so the guard sees both records it replaces.
      const evidence = [`Existing record A:\n${renderConcernForGuard(target)}`, `Existing record B:\n${renderConcernForGuard(source)}`, ...(deps.source ? [`Feedback:\n${deps.source}`] : [])].join('\n\n');
      const rejected = await guardRejects('merge_concerns', input.merged, evidence);
      if (rejected) return rejected;
      const { embedded, note } = await embedConcernOrNote(input.merged.subject, input.merged.concern, 'merged');
      const rec = await store.mergeConcerns(input.target_record_id, input.source_record_id, { ...input.merged, ...embedded });
      return rec
        ? JSON.stringify({ ok: true, record: rec, combined_reinforcement: rec.reinforcementCount, ...(note ? { note } : {}) })
        : notFound;
    },
  });

  const deleteConcern = tool({
    name: 'delete_concern',
    description: 'Remove a concern record. Use when the record is pure noise. (Graduation deletes its source record automatically.)',
    inputSchema: z.object({ record_id: z.string() }),
    callback: async (input: { record_id: string }) => { await store.deleteConcern(input.record_id); return JSON.stringify({ ok: true }); },
  });

  return [listConcerns, findSimilarConcerns, getConcern, createConcern, bumpConcern, mergeConcerns, deleteConcern];
}
