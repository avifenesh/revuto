import { z } from 'zod';
import { tool } from '../../../common/src/tool-def.js';
import type { KnowledgeStore, SkillNote } from '../../../common/src/store/store.js';

/**
 * Graduate a concern into a topic skill note in the vault.
 *
 * Unlike the old AgentCore-registry flow, graduation here:
 *   1. writes a markdown skill note (status: draft) into the repo's vault dir, and
 *   2. deletes the source concern from the store.
 *
 * The skill stays `draft` until a human runs `reviewer approve` (or the repo has
 * autoActivate). Drafts are not loaded by the reviewer. The skill's `area` globs
 * are inherited from the source concern so area-glob selection keeps working
 * even without an embedder.
 */

export interface GraduateInput {
  readonly subject: string;
  readonly description: string;
  readonly skillMd: string;
  readonly sourceRecordId: string;
}

export async function graduate(store: KnowledgeStore, input: GraduateInput): Promise<SkillNote> {
  const source = await store.getConcern(input.sourceRecordId);
  if (!source) throw new Error(`graduate: source concern ${input.sourceRecordId} not found`);

  const body = `${input.skillMd.trim()}\n\n_(graduated from concern record_id=${input.sourceRecordId})_`;
  const note = await store.writeSkill({
    subject: input.subject,
    description: input.description,
    area: source.area,
    body,
    status: 'draft',
    sourceRecord: input.sourceRecordId,
  });
  // User rule: once it becomes a skill, remove it from the concerns DB.
  await store.deleteConcern(input.sourceRecordId);
  return note;
}

export function buildListSkillsTool(store: KnowledgeStore) {
  return tool({
    name: 'list_skills',
    description:
`List the topic skills already accumulated for this repo (all statuses), with slug, name, description, area, and status.

Call this in Phase 2 BEFORE composing. Skills accumulate one per subject over time. If the reinforced concern's subject is NOT already covered by an existing skill, create a NEW skill — a new subject is a new skill; never cram an unrelated concern into an existing skill just to avoid making one. Reuse an existing slug only when you are deliberately revising that same subject's skill.`,
    inputSchema: z.object({}),
    callback: async () =>
      JSON.stringify({
        ok: true,
        skills: (await store.listSkills()).map((s) => ({ slug: s.slug, name: s.name, description: s.description, area: s.area, status: s.status })),
      }),
  });
}

export function buildSubmitSkillTool(store: KnowledgeStore) {
  return tool({
    name: 'submit_skill',
    description:
`Graduate a reinforced concern into a topic skill. Call exactly once, immediately after a bump_concern / merge_concerns that reached the graduation threshold.

Inputs:
- \`subject\`: short title (3-8 words). Becomes the skill note's slug/name.
- \`description\`: imperative trigger sentence(s) — "Use when reviewing a PR that touches <specific files/functions>". This is the selection gate; use verbatim file paths, function/struct names, and domain terms.
- \`skill_md\`: the full skill body. Follow the structure from search_skill_authoring (## Use when, confidence ladder, ## Patterns with a "Skip unless" gate on every pattern, ## Do NOT flag). 50-250 lines.
- \`source_record_id\`: the concern record_id this graduates from. Its area globs become the skill's selection area, and the concern is removed once the note is written.

The note lands as status:draft in the vault; a human approves it (or autoActivate) before the reviewer uses it.`,
    inputSchema: z.object({
      subject: z.string().min(3).max(120),
      description: z.string().min(1).max(500),
      skill_md: z.string().min(20),
      source_record_id: z.string().min(1),
    }),
    callback: async (input) => {
      try {
        const note = await graduate(store, {
          subject: input.subject,
          description: input.description,
          skillMd: input.skill_md,
          sourceRecordId: input.source_record_id,
        });
        return JSON.stringify({ ok: true, slug: note.slug, status: note.status, area: note.area });
      } catch (err) {
        return `ERROR submit_skill: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
