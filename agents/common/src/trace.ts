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
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Keep the newest N traces per repo. Old ones are pruned after every write. */
const MAX_TRACES_PER_REPO = 50;
/** Per-field cap. Tool outputs are 512 KB at the source; a trace is a summary. */
const MAX_FIELD_CHARS = 4000;

export interface StartTraceOptions {
  readonly vaultPath: string;
  /** "owner/name". */
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly model: string;
  readonly startedAt: Date;
}

export interface TraceWriter {
  /** Path of the trace file, or undefined once writing has failed. */
  readonly path: string | undefined;
  /**
   * Append one finished step. `phase` names the `generateText` call it came from:
   * "main", "continuation", or "forced".
   */
  step(phase: string, step: unknown): void;
  /** Append the outcome record, prune old traces, and return the path. */
  finish(outcome: Record<string, unknown>): string | undefined;
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
  finishReason?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown };
  toolCalls?: Array<{ toolName?: string; input?: unknown; args?: unknown }>;
  toolResults?: Array<{ toolName?: string; output?: unknown; result?: unknown }>;
  content?: Array<{ type?: string; toolName?: string; error?: unknown }>;
};

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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
  // finishReason and the token split are what explain a step that did nothing:
  // "length" means the output cap ate the turn, "stop" with no calls means the
  // model simply gave up, and either one ends the pass without a terminal tool.
  const finishReason = typeof step.finishReason === 'string' ? step.finishReason : undefined;
  const inTokens = numberOr(step.usage?.inputTokens);
  const outTokens = numberOr(step.usage?.outputTokens);
  return {
    kind: 'step',
    phase,
    step: index,
    ...(finishReason ? { finishReason } : {}),
    ...(inTokens !== undefined || outTokens !== undefined ? { tokens: { in: inTokens, out: outTokens } } : {}),
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

/**
 * Open a trace and return a writer. Steps are appended as they finish rather
 * than buffered, so a run that is killed, times out, or throws still leaves
 * everything it did behind - which is the whole point of having a trace.
 */
export function startReviewTrace(opts: StartTraceOptions): TraceWriter {
  const dir = traceDir(opts.vaultPath, opts.repo);
  // 2026-08-15T12:34:56.789Z -> 20260815T123456 — sortable, filename-safe.
  const stamp = opts.startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  // Timestamp first so a plain name sort is chronological — pruneTraces relies on it.
  const base = `${stamp}-pr${opts.prNumber}-${opts.headSha.slice(0, 7)}`;
  const stepsPerPhase = new Map<string, number>();
  let file = join(dir, `${base}.jsonl`);
  let live = true;

  const append = (record: Record<string, unknown>): void => {
    if (!live) return;
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ kind: record.kind ?? 'unknown', error: 'record could not be serialized' });
    }
    try {
      appendFileSync(file, `${line}\n`, 'utf8');
    } catch (err) {
      live = false;
      console.error(`[trace] stopped writing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    mkdirSync(dir, { recursive: true });
    // "wx" so a second run never truncates a first one's trace. The stamp is whole
    // seconds and `revuto review --force` bypasses the per-head claim, so two runs
    // of the same head can land on the same name; they get -2, -3, ... instead of
    // interleaving into one file.
    file = openFresh(dir, base);
  } catch (err) {
    live = false;
    console.error(`[trace] could not open ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  append({
    kind: 'run',
    repo: opts.repo,
    pr: opts.prNumber,
    headSha: opts.headSha,
    model: opts.model,
    startedAt: opts.startedAt.toISOString(),
  });

  return {
    get path() {
      return live ? file : undefined;
    },
    step(phase, step) {
      const index = (stepsPerPhase.get(phase) ?? 0) + 1;
      stepsPerPhase.set(phase, index);
      append(stepRecord(phase, index, step as StepLike));
    },
    finish(outcome) {
      append({ kind: 'outcome', ...outcome });
      if (live) pruneTraces(dir);
      return live ? file : undefined;
    },
  };
}

/**
 * Create `<dir>/<base>.jsonl`, or `<base>-2.jsonl`, `-3`, ... if that name is taken.
 * Returns the path actually created; throws if none could be.
 */
function openFresh(dir: string, base: string): string {
  for (let suffix = 1; suffix <= MAX_TRACES_PER_REPO; suffix++) {
    const candidate = join(dir, suffix === 1 ? `${base}.jsonl` : `${base}-${suffix}.jsonl`);
    try {
      writeFileSync(candidate, '', { encoding: 'utf8', flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`${MAX_TRACES_PER_REPO} traces already exist for ${base}`);
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
