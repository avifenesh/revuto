/**
 * Bridge @agent-sh/harness-tools ToolDefinitions into the engine's neutral
 * ToolDef (see ../tool-def.ts), which `toAiSdkTools` then hands to the AI SDK.
 *
 * harness-tools exposes each tool as:
 *   - xxxToolDefinition: { name, description, inputSchema (JSON Schema) }
 *   - xxx(input, session) -> Promise<Result>
 *
 * Our ToolDef wants:
 *   { name, description, inputSchema: z.object(...), callback }
 *
 * We convert the harness JSON Schema to Zod (best-effort, below) and wrap the
 * harness fn as the callback.
 */
import { z, type ZodTypeAny } from 'zod';
import { tool } from '../tool-def.js';

type HarnessFn<R, S> = (input: unknown, session: S) => Promise<R>;

interface HarnessToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

interface FormatResult {
  // All harness tools return a discriminated union; the text we want to
  // show the model is in `output` (for success variants) or `error`
  // (for error variants). This narrows it down without leaking internal
  // shape into every adapter call.
  readonly kind?: string;
  readonly output?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * jsonSchemaToZod: a narrow, best-effort converter from the subset of JSON
 * Schema that harness-tools uses. harness-tools' schemas are valibot-derived
 * and flat (string/number/boolean/object with required) so we handle only
 * those. The AI SDK validates tool input against this Zod schema before
 * calling `execute`, so a permissive `z.any()` leaf is a safe fallback for
 * shapes we don't translate.
 */
function jsonSchemaToZod(schema: any): ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();
  const t = schema.type;
  if (t === 'string') return z.string();
  if (t === 'integer' || t === 'number') return z.number();
  if (t === 'boolean') return z.boolean();
  if (t === 'array') return z.array(schema.items ? jsonSchemaToZod(schema.items) : z.any());
  if (t === 'object' || (!t && schema.properties)) {
    const shape: Record<string, ZodTypeAny> = {};
    const required: Set<string> = new Set(schema.required ?? []);
    for (const [k, v] of Object.entries<any>(schema.properties ?? {})) {
      let zv = jsonSchemaToZod(v);
      if (v.description) zv = zv.describe(v.description);
      if (!required.has(k)) zv = zv.optional();
      shape[k] = zv;
    }
    return z.object(shape);
  }
  return z.any();
}

export interface AdaptOptions<R extends FormatResult, S> {
  readonly def: HarnessToolDef;
  readonly fn: HarnessFn<R, S>;
  readonly session: S;
  readonly overrideName?: string;
}

export function adaptHarnessTool<R extends FormatResult, S>(opts: AdaptOptions<R, S>) {
  const name = opts.overrideName ?? opts.def.name;
  const inputSchema = jsonSchemaToZod(opts.def.inputSchema);

  return tool({
    name,
    description: opts.def.description,
    inputSchema: inputSchema as any,
    callback: async (input: unknown) => {
      try {
        const result = await opts.fn(input, opts.session);
        if (result.kind === 'error' && result.error) {
          return `ERROR ${result.error.code ?? ''}: ${result.error.message ?? ''}`;
        }
        return result.output ?? JSON.stringify(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `ERROR: ${msg}`;
      }
    },
  });
}
