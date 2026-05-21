/**
 * Neutral tool descriptor + Vercel AI SDK adapter.
 *
 * The tool builders (`tools/gh.ts`, `tools/git.ts`, the harness `adapter.ts`,
 * and any per-repo build tools) call this `tool()` factory, which returns a
 * plain `{ name, description, inputSchema, callback }` object. `toAiSdkTools`
 * converts an array of those into the record shape the AI SDK's
 * `generateText({ tools })` expects.
 *
 * This keeps the engine provider-agnostic: nothing below the run loop imports
 * a specific SDK, and swapping orchestrators later means touching only this
 * file plus `model.ts` / `run-agent.ts`.
 */
import { tool as aiTool, type ToolSet } from 'ai';
import type { ZodTypeAny } from 'zod';

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodTypeAny;
  /** Returns the text shown to the model (or any JSON-serializable value). */
  readonly callback: (input: any) => Promise<unknown> | unknown;
}

/** Identity factory — returns the descriptor unchanged, typed. */
export function tool(def: ToolDef): ToolDef {
  return def;
}

/** Convert neutral tool descriptors into an AI SDK tools record keyed by name. */
export function toAiSdkTools(defs: readonly ToolDef[]): ToolSet {
  const out: ToolSet = {};
  for (const d of defs) {
    out[d.name] = aiTool({
      description: d.description,
      inputSchema: d.inputSchema,
      execute: async (input: unknown) => {
        const r = await d.callback(input);
        return typeof r === 'string' ? r : JSON.stringify(r);
      },
    });
  }
  return out;
}
