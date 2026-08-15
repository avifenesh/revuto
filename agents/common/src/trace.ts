/**
 * Per-run review trace.
 *
 * A review that ended in `skip_review` used to leave nothing behind, so there
 * was no way to tell "read the diff, found nothing" from "never inspected
 * anything and gave up". Every run now writes one JSONL file under
 * `<vault>/.traces/<owner>__<repo>/`, and the path travels back on
 * `ReviewOutcome` so the CLI, the daemon log, and the check summary can point
 * at it.
 *
 * Tracing is best effort: a failure here logs and returns undefined rather
 * than failing the review.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Keep the newest N traces per repo. Old ones are pruned after every write. */
const MAX_TRACES_PER_REPO = 50;
/** Per-field cap. Tool outputs are 512 KB at the source; a trace is a summary. */
const MAX_FIELD_CHARS = 4000;

/** One `generateText` call: the main pass, the continuation, or the forced pass. */
export interface TracePhase {
  readonly phase: string;
  readonly steps: readonly unknown[];
}

export interface WriteTraceOptions {
  readonly vaultPath: string;
  /** "owner/name". */
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly model: string;
  readonly phases: readonly TracePhase[];
  /** Anything JSON-serializable; written as the final `outcome` record. */
  readonly outcome: Record<string, unknown>;
  readonly startedAt: Date;
}

function clip(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…[${value.length} chars]` : value;
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
  return json.length > MAX_FIELD_CHARS ? `${json.slice(0, MAX_FIELD_CHARS)}…[${json.length} chars]` : JSON.parse(json);
}

type StepLike = {
  text?: unknown;
  toolCalls?: Array<{ toolName?: string; input?: unknown; args?: unknown }>;
  toolResults?: Array<{ toolName?: string; output?: unknown; result?: unknown }>;
  content?: Array<{ type?: string; toolName?: string; error?: unknown }>;
};

function stepRecord(phase: string, index: number, step: StepLike): Record<string, unknown> {
  const text = typeof step.text === 'string' ? step.text.trim() : '';
  const calls = (step.toolCalls ?? []).map((c) => ({ tool: c.toolName ?? '?', input: clip(c.input ?? c.args) }));
  const results = (step.toolResults ?? []).map((r) => {
    const payload = r.output ?? r.result ?? '';
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return { tool: r.toolName ?? '?', failed: isToolErrorOutput(payload), output: clip(text) };
  });
  const errors = (step.content ?? [])
    .filter((part) => part?.type === 'tool-error')
    .map((part) => ({ tool: part.toolName ?? '?', error: clip(part.error) }));
  return {
    kind: 'step',
    phase,
    step: index,
    ...(text ? { text: clip(text) } : {}),
    ...(calls.length ? { calls } : {}),
    ...(results.length ? { results } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

/**
 * True when a tool result is an error. Every tool surface in `tools/` reports
 * failures as a string starting with `ERROR` (see `tools/adapter.ts`) rather
 * than throwing, so this is the only signal that a call did not do its job.
 */
export function isToolErrorOutput(payload: unknown): boolean {
  return typeof payload === 'string' && payload.trimStart().startsWith('ERROR');
}

/** Directory holding the traces for one repo. */
export function traceDir(vaultPath: string, repo: string): string {
  return join(vaultPath, '.traces', repo.replace('/', '__'));
}

/** Write the trace and return its path, or undefined when it could not be written. */
export function writeReviewTrace(opts: WriteTraceOptions): string | undefined {
  const dir = traceDir(opts.vaultPath, opts.repo);
  // 2026-08-15T12:34:56.789Z -> 20260815T123456 — sortable, filename-safe.
  const stamp = opts.startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  // Timestamp first so a plain name sort is chronological — pruneTraces relies on it.
  const file = join(dir, `${stamp}-pr${opts.prNumber}-${opts.headSha.slice(0, 7)}.jsonl`);

  const lines: string[] = [];
  const push = (record: Record<string, unknown>) => {
    try {
      lines.push(JSON.stringify(record));
    } catch {
      lines.push(JSON.stringify({ kind: record.kind ?? 'unknown', error: 'record could not be serialized' }));
    }
  };

  push({
    kind: 'run',
    repo: opts.repo,
    pr: opts.prNumber,
    headSha: opts.headSha,
    model: opts.model,
    startedAt: opts.startedAt.toISOString(),
  });
  for (const { phase, steps } of opts.phases) {
    steps.forEach((step, i) => push(stepRecord(phase, i + 1, step as StepLike)));
  }
  push({ kind: 'outcome', ...opts.outcome });

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    pruneTraces(dir);
    return file;
  } catch (err) {
    console.error(`[trace] could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Drop all but the newest MAX_TRACES_PER_REPO files. Names sort chronologically. */
function pruneTraces(dir: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_TRACES_PER_REPO))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    // Pruning is housekeeping — never let it mask a written trace.
  }
}
