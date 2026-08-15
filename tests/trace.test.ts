/**
 * The trace is the only record of what a review actually did, so it has to be
 * written even when a step carries something odd, and it must not grow without
 * bound.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

import { writeReviewTrace, traceDir, isToolErrorOutput } from '../agents/common/src/trace.js';

function vault(): string {
  return mkdtempSync(join(tmpdir(), 'revuto-trace-'));
}

const baseOpts = (vaultPath: string, over: Record<string, unknown> = {}) => ({
  vaultPath,
  repo: 'agent-sh/agnix',
  prNumber: 1373,
  headSha: 'abc1234def5678',
  model: 'anthropic.claude-opus-5',
  phases: [
    {
      phase: 'main',
      steps: [
        { text: 'looking at the diff', toolCalls: [{ toolName: 'read', input: { path: 'src/main.rs' } }], toolResults: [{ toolName: 'read', output: 'fn main() {}' }] },
        { toolCalls: [{ toolName: 'skip_review', input: { reason: 'no concerns' } }], toolResults: [{ toolName: 'skip_review', output: '{"skipped":true}' }] },
      ],
    },
  ],
  outcome: { terminal: 'skip_review', inspections: 1, toolErrors: 0 },
  startedAt: new Date(Date.UTC(2026, 7, 15, 12, 0, 0)),
  ...over,
});

test('writeReviewTrace records the run, every step, and the outcome', () => {
  const v = vault();
  try {
    const path = writeReviewTrace(baseOpts(v));
    assert.ok(path, 'expected a trace path');
    assert.equal(dirname(path!), traceDir(v, 'agent-sh/agnix'));
    assert.equal(basename(path!), '20260815T120000-pr1373-abc1234.jsonl');

    const records = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(records.map((r) => r.kind), ['run', 'step', 'step', 'outcome']);
    assert.equal(records[0].pr, 1373);
    assert.equal(records[0].model, 'anthropic.claude-opus-5');
    assert.equal(records[1].calls[0].tool, 'read');
    assert.equal(records[1].results[0].output, 'fn main() {}');
    assert.equal(records[1].results[0].failed, false);
    assert.equal(records[3].terminal, 'skip_review');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('writeReviewTrace marks failed tool results and clips large output', () => {
  const v = vault();
  try {
    const huge = 'x'.repeat(20_000);
    const path = writeReviewTrace(baseOpts(v, {
      phases: [{
        phase: 'main',
        steps: [{ toolResults: [{ toolName: 'bash', output: 'ERROR: permission denied' }, { toolName: 'read', output: huge }] }],
      }],
    }));
    const step = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l))[1];
    assert.equal(step.results[0].failed, true);
    assert.equal(step.results[1].failed, false);
    assert.ok(step.results[1].output.length < 5000, 'expected clipped output');
    assert.match(step.results[1].output, /\[20000 chars\]$/);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('writeReviewTrace survives a step that cannot be serialized', () => {
  const v = vault();
  try {
    const circular: any = { toolResults: [{ toolName: 'read', output: 'ok' }] };
    circular.self = circular;
    const path = writeReviewTrace(baseOpts(v, { phases: [{ phase: 'main', steps: [circular] }] }));
    assert.ok(path, 'expected a trace path despite the circular step');
    const records = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(records.map((r) => r.kind), ['run', 'step', 'outcome']);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('writeReviewTrace keeps the newest 50 traces per repo', () => {
  const v = vault();
  try {
    for (let i = 0; i < 53; i++) {
      writeReviewTrace(baseOpts(v, { startedAt: new Date(Date.UTC(2026, 7, 15, 0, i, 0)) }));
    }
    const files = readdirSync(traceDir(v, 'agent-sh/agnix')).sort();
    assert.equal(files.length, 50);
    assert.equal(files[0], '20260815T000300-pr1373-abc1234.jsonl');
    assert.equal(files.at(-1), '20260815T005200-pr1373-abc1234.jsonl');
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
