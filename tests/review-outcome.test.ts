/**
 * Guards the review→check contract: a run that inspected nothing must not be
 * reported as a passing review. The regression this covers shipped a green
 * required check (and a GitHub App approval) for a `skip_review` the model made
 * with no inspection tools in hand.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeReviewSteps, unreviewedOutcome, describeOutcome, reviewTranscript, type ReviewOutcome } from '../agents/common/src/run-agent.js';
import { checkResultForOutcome } from '../daemon/src/review-check.js';

function outcome(over: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    terminal: 'skip_review',
    hasFindings: false,
    result: '{"ok":true,"skipped":true}',
    headSha: 'a'.repeat(40),
    steps: 8,
    tokens: 1000,
    inspections: 6,
    toolErrors: 0,
    forcedTerminal: false,
    ranModel: true,
    ...over,
  };
}

const step = (results: Array<{ toolName: string; output?: unknown }>, content?: Array<{ type: string }>) => ({
  toolResults: results,
  ...(content ? { content } : {}),
});

test('summarizeReviewSteps counts inspection tool calls', () => {
  const s = summarizeReviewSteps([
    step([{ toolName: 'read', output: 'file contents' }, { toolName: 'grep', output: 'match' }]),
    step([{ toolName: 'bash', output: 'ok' }]),
    step([{ toolName: 'skip_review', output: '{"skipped":true}' }]),
  ]);
  assert.equal(s.terminal, 'skip_review');
  assert.equal(s.inspections, 3);
  assert.equal(s.toolErrors, 0);
  assert.equal(s.hasFindings, false);
});

test('summarizeReviewSteps does not count terminal or posting tools as inspection', () => {
  const s = summarizeReviewSteps([
    step([{ toolName: 'post_issue_comment', output: '{"ok":true}' }]),
    step([{ toolName: 'post_review', output: '{"ok":true}' }]),
  ]);
  assert.equal(s.terminal, 'post_review');
  assert.equal(s.hasFindings, true);
  assert.equal(s.inspections, 0);
});

test('summarizeReviewSteps counts failed tool calls as errors, not inspection', () => {
  const s = summarizeReviewSteps([
    step([{ toolName: 'read', output: 'ERROR INVALID_PARAM: Invalid key: Expected "path"' }]),
    step([{ toolName: 'bash', output: 'ERROR: permission denied' }]),
    step([{ toolName: 'glob', output: 'src/main.rs' }]),
    step([{ toolName: 'skip_review', output: '{"skipped":true}' }], [{ type: 'tool-error' }]),
  ]);
  assert.equal(s.inspections, 1);
  assert.equal(s.toolErrors, 3);
});

test('a skip after real inspection passes the check', () => {
  const result = checkResultForOutcome(outcome());
  assert.equal(result.conclusion, 'success');
  assert.match(result.summary, /Inspection: 6 tool call\(s\)/);
});

test('a skip with zero inspection fails the check instead of approving', () => {
  const result = checkResultForOutcome(outcome({ inspections: 0, toolErrors: 4, forcedTerminal: true, tracePath: '/home/someone/revuto/.traces/agent-sh__agnix/20260815T120000-pr1-abc1234.jsonl' }));
  assert.equal(result.conclusion, 'failure');
  assert.match(result.title, /without inspecting/);
  assert.match(result.summary, /0 successful inspection tool call\(s\)/);
  assert.match(result.summary, /Tool calls that failed: 4/);
  assert.match(result.summary, /forced terminal-only pass/);
  // The check summary is public; only the trace filename belongs in it.
  assert.match(result.summary, /Local trace: 20260815T120000-pr1-abc1234\.jsonl/);
  assert.doesNotMatch(result.summary, /home\/someone/);
});

test('a skip the forced pass decided fails the check even after real inspection', () => {
  // What #79 actually produced: 68 inspection calls, then a stalled review whose
  // skip reason came out of the terminal-only pass and claimed nothing was read.
  const result = checkResultForOutcome(outcome({ inspections: 68, steps: 43, toolErrors: 2, forcedTerminal: true }));
  assert.equal(result.conclusion, 'failure');
  assert.match(result.title, /without deciding/);
  assert.match(result.summary, /68 successful inspection tool call\(s\)/);
  assert.match(result.summary, /the review stalled without deciding anything/);
});

test('a PR the engine never ran the model on still reports success', () => {
  const skipped = unreviewedOutcome('#7 is a draft - drafts are never reviewed', 'b'.repeat(40));
  assert.equal(skipped.ranModel, false);
  assert.equal(skipped.inspections, 0);
  assert.equal(checkResultForOutcome(skipped).conclusion, 'success');
});

test('findings and unfinished runs fail the check', () => {
  assert.equal(checkResultForOutcome(outcome({ terminal: 'post_review', hasFindings: true })).conclusion, 'failure');
  assert.equal(checkResultForOutcome(outcome({ terminal: 'none', inspections: 4 })).conclusion, 'failure');
});

test('a recovery pass replays every earlier turn, not just the last step', () => {
  const main = {
    responseMessages: [
      { role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: '1', toolName: 'read', input: {} }] },
      { role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: '1', toolName: 'read', output: { type: 'text' as const, value: 'fn main() {}' } }] },
      // The empty turn that stalls the review and ends the pass.
      { role: 'assistant' as const, content: [] },
    ],
  };
  const continued = { responseMessages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'still looking' }] }] };

  const afterMain = reviewTranscript('review this', main);
  assert.equal(afterMain.length, 4);
  assert.equal(afterMain[0].role, 'user');
  // The tool result must survive into the recovery pass, or it decides blind.
  assert.equal(afterMain[2].role, 'tool');

  const afterContinuation = reviewTranscript('review this', main, continued);
  assert.equal(afterContinuation.length, 5);
  assert.deepEqual(afterContinuation.at(-1), continued.responseMessages[0]);
});

test('describeOutcome surfaces inspection, forcing, and the trace', () => {
  const line = describeOutcome(outcome({ inspections: 0, forcedTerminal: true, tracePath: '/vault/.traces/x/t.jsonl' }));
  assert.match(line, /terminal=skip_review/);
  assert.match(line, /inspections=0/);
  assert.match(line, /forced=true/);
  assert.match(line, /trace=\/vault\/\.traces\/x\/t\.jsonl/);
});
