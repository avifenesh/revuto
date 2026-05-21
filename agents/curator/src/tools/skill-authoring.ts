import { z } from 'zod';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { tool } from '../../../common/src/tool-def.js';
import { engineRoot } from '../../../common/src/engine-root.js';

/**
 * Skill-authoring guidance, read from the engine's `agent-knowledge/` directory.
 *
 * Replaces the AgentCore curator-skills registry: the "how to write a skill"
 * material is now a maintained file in the repo. The curator calls this on
 * Phase 2 entry (before composing skill_md) and follows what it returns.
 */

const GUIDANCE_FILE = 'skill-writing-best-practices.md';

export function buildSkillAuthoringTool() {
  return tool({
    name: 'search_skill_authoring',
    description:
`Retrieve the guidance on composing skill_md. Call this on Phase 2 entry — before writing skill_md — and follow it. Do NOT call during Phase 1 (bump/merge/create/drop decisions); it is irrelevant there and wastes tokens. Returns the full guidance markdown, or a short fallback rule set if the guidance file is absent.`,
    inputSchema: z.object({
      query: z.string().min(3).max(500).describe('What you need guidance on, e.g. "compose skill_md", "Skip unless gate", "Do NOT flag carve-outs"'),
    }),
    callback: () => {
      const path = join(engineRoot(), 'agent-knowledge', GUIDANCE_FILE);
      if (existsSync(path)) {
        return JSON.stringify({ ok: true, guidance: readFileSync(path, 'utf8') });
      }
      return JSON.stringify({
        ok: false,
        reason: 'guidance-file-absent',
        fallback:
          'Imperative description ("Use when reviewing a PR that touches <files/functions>"); semantic vocabulary (verbatim paths/identifiers); every pattern has a "Skip unless:" gate; include a "## Do NOT flag" carve-out block; confidence ladder near the top; 50-250 lines; no maintainer names / PR numbers / time-sensitive phrasing.',
      });
    },
  });
}
