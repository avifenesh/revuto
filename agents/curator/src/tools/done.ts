import { z } from 'zod';
import { tool } from '../../../common/src/tool-def.js';

/**
 * Terminal signal for the curator loop. The agent calls this once,
 * with a short summary, and the run ends cleanly (same pattern the
 * reviewer uses via skip_review / post_review).
 */
export function buildCuratorDoneTool() {
  return tool({
    name: 'curator_done',
    description:
`Terminate the curator run. Call exactly once, with a summary describing what you did:
- \`decision\`: one of "bumped", "merged", "created", "dropped", "graduated", "noop"
- \`summary\`: one-sentence rationale. Cite the record_ids you touched (or "none" for noop).

After this call, no further tool calls will be honored. The run logs the decision and returns.`,
    inputSchema: z.object({
      decision: z.enum(['bumped', 'merged', 'created', 'dropped', 'graduated', 'noop']),
      summary: z.string().min(1),
    }),
    callback: async (input) => {
      return JSON.stringify({ ok: true, decision: input.decision, summary: input.summary });
    },
  });
}
