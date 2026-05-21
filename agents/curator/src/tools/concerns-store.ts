import { z } from 'zod';
import { tool } from '../../../common/src/tool-def.js';
import type { KnowledgeStore } from '../../../common/src/store/store.js';
import { type Embedder, embedOne } from '../../../common/src/memory/embedder.js';

/**
 * Curator concerns-store tools, backed by the per-repo KnowledgeStore.
 *
 * The store is bound to one repo, so there is no `reviewer_id` — these operate
 * on this repo's concerns only. The curator decides (read candidates, judge
 * overlap); these give it list / get / create / bump / merge / delete. When an
 * embedder is configured, `create_concern` stores an embedding of subject +
 * concern so the learn loop can pre-filter candidates by similarity.
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
}

export function buildConcernsStoreTools(deps: ConcernsStoreDeps) {
  const { store, embedder } = deps;

  const listConcerns = tool({
    name: 'list_concerns',
    description:
`List concern records in an area_bucket, up to 20, newest+most-reinforced first. Call this first with the bucket derived from the feedback's touched files to find candidates the incoming feedback may match. Returns JSON {records:[{record_id, area, subject, concern, context, reinforcement_count, decay_score, updated_at}]}.`,
    inputSchema: z.object({ area_bucket: z.string().describe('e.g. "src" or "src/cluster"') }),
    callback: async (input: { area_bucket: string }) =>
      JSON.stringify({ ok: true, records: await store.listConcerns(input.area_bucket) }),
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
`Create a new concern record. Use only when no existing record in the bucket describes the same concern — do not create on every feedback event. reinforcement_count starts at 1. \`context\` is the extra-code "why" the reviewer cannot get from code alone; empty string if none.`,
    inputSchema: z.object({ area_bucket: z.string(), record: concernShape }),
    callback: async (input) => {
      const embedding = embedder ? await embedOne(embedder, `${input.record.subject}\n${input.record.concern}`) : undefined;
      const rec = await store.createConcern({ areaBucket: input.area_bucket, ...input.record, embedding });
      return JSON.stringify({ ok: true, record_id: rec.recordId, reinforcement_count: rec.reinforcementCount });
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
      const rec = await store.mergeConcerns(input.target_record_id, input.source_record_id, input.merged);
      return rec
        ? JSON.stringify({ ok: true, record: rec, combined_reinforcement: rec.reinforcementCount })
        : `ERROR merge_concerns: target/source not found or identical`;
    },
  });

  const deleteConcern = tool({
    name: 'delete_concern',
    description: 'Remove a concern record. Use when the record is pure noise. (Graduation deletes its source record automatically.)',
    inputSchema: z.object({ record_id: z.string() }),
    callback: async (input: { record_id: string }) => { await store.deleteConcern(input.record_id); return JSON.stringify({ ok: true }); },
  });

  return [listConcerns, getConcern, createConcern, bumpConcern, mergeConcerns, deleteConcern];
}
