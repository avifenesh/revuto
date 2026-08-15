/**
 * The trace is the only record of what a review actually did, so it has to be
 * readable while the run is still going, survive a step carrying something odd,
 * and not grow without bound.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

import { startReviewTrace, traceDir, isToolErrorOutput } from '../agents/common/src/trace.js';

function vault(): string {
  return mkdtempSync(join(tmpdir(), 'revuto-trace-'));
}

const opts = (vaultPath: string, startedAt = new Date(Date.UTC(2026, 7, 15, 12, 0, 0))) => ({
  vaultPath,
  repo: 'agent-sh/agnix',
  prNumber: 1373,
  headSha: 'abc1234def5678',
  model: 'anthropic.claude-opus-5',
  startedAt,
});

const records = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a trace records the run, every step, and the outcome', () => {
  const v = vault();
  try {
    const trace = startReviewTrace(opts(v));
    assert.ok(trace.path, 'expected a trace path');
    assert.equal(dirname(trace.path!), traceDir(v, 'agent-sh/agnix'));
    assert.equal(basename(trace.path!), '20260815T120000-pr1373-abc1234.jsonl');

    trace.step('main', {
      text: 'looking at the diff',
      toolCalls: [{ toolName: 'read', input: { path: 'src/main.rs' } }],
      toolResults: [{ toolName: 'read', output: 'fn main() {}' }],
    });
    trace.step('main', { toolResults: [{ toolName: 'skip_review', output: '{"skipped":true}' }] });
    const path = trace.finish({ terminal: 'skip_review', inspections: 1, toolErrors: 0 });
    assert.equal(path, trace.path);

    const lines = records(path!);
    assert.deepEqual(lines.map((r) => r.kind), ['run', 'step', 'step', 'outcome']);
    assert.equal(lines[0].pr, 1373);
    assert.equal(lines[0].model, 'anthropic.claude-opus-5');
    assert.equal(lines[1].step, 1);
    assert.equal(lines[1].calls[0].tool, 'read');
    assert.equal(lines[1].results[0].output, 'fn main() {}');
    assert.equal(lines[1].results[0].failed, false);
    assert.equal(lines[2].step, 2);
    assert.equal(lines[3].terminal, 'skip_review');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('steps are readable before the run finishes', () => {
  const v = vault();
  try {
    const trace = startReviewTrace(opts(v));
    trace.step('main', { toolResults: [{ toolName: 'grep', output: 'hit' }] });
    // A killed run never reaches finish(); what it did must still be on disk.
    const lines = records(trace.path!);
    assert.deepEqual(lines.map((r) => r.kind), ['run', 'step']);
    assert.equal(lines[1].results[0].tool, 'grep');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('each phase numbers its own steps', () => {
  const v = vault();
  try {
    const trace = startReviewTrace(opts(v));
    trace.step('main', {});
    trace.step('main', {});
    trace.step('continuation', {});
    trace.step('forced', {});
    const steps = records(trace.finish({})!).filter((r) => r.kind === 'step');
    assert.deepEqual(steps.map((r) => `${r.phase}:${r.step}`), ['main:1', 'main:2', 'continuation:1', 'forced:1']);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('failed tool results are marked and large output is clipped', () => {
  const v = vault();
  try {
    const huge = 'x'.repeat(20_000);
    const trace = startReviewTrace(opts(v));
    trace.step('main', {
      toolResults: [{ toolName: 'bash', output: 'ERROR: permission denied' }, { toolName: 'read', output: huge }],
    });
    const step = records(trace.finish({})!)[1];
    assert.equal(step.results[0].failed, true);
    assert.equal(step.results[1].failed, false);
    assert.ok(step.results[1].output.length < 5000, 'expected clipped output');
    assert.match(step.results[1].output, /\[20000 chars\]$/);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('a step that cannot be serialized does not break the trace', () => {
  const v = vault();
  try {
    const circular: any = { toolResults: [{ toolName: 'read', output: 'ok' }] };
    circular.self = circular;
    const trace = startReviewTrace(opts(v));
    trace.step('main', circular);
    const lines = records(trace.finish({ terminal: 'skip_review' })!);
    assert.deepEqual(lines.map((r) => r.kind), ['run', 'step', 'outcome']);
    assert.equal(lines.at(-1).terminal, 'skip_review');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('only the newest 50 traces per repo are kept', () => {
  const v = vault();
  try {
    for (let i = 0; i < 53; i++) {
      startReviewTrace(opts(v, new Date(Date.UTC(2026, 7, 15, 0, i, 0)))).finish({});
    }
    const files = readdirSync(traceDir(v, 'agent-sh/agnix')).sort();
    assert.equal(files.length, 50);
    assert.equal(files[0], '20260815T000300-pr1373-abc1234.jsonl');
    assert.equal(files.at(-1), '20260815T005200-pr1373-abc1234.jsonl');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('a trace that cannot be opened degrades to no path', () => {
  const v = vault();
  try {
    // A regular file where the vault directory should be: mkdir under it is ENOTDIR.
    const notADir = join(v, 'vault');
    writeFileSync(notADir, '');
    const trace = startReviewTrace(opts(notADir));
    assert.equal(trace.path, undefined);
    trace.step('main', {});
    assert.equal(trace.finish({}), undefined);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('isToolErrorOutput only matches the tool surfaces error convention', () => {
  assert.equal(isToolErrorOutput('ERROR: nope'), true);
  assert.equal(isToolErrorOutput('  ERROR INVALID_PARAM: nope'), true);
  assert.equal(isToolErrorOutput('no ERROR here'), false);
  assert.equal(isToolErrorOutput({ ok: true }), false);
});
