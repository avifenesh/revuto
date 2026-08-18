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

import {
  summarizeReviewSteps,
  unreviewedOutcome,
  describeOutcome,
  reviewTranscript,
  stalledOnOutputCap,
  type ReviewOutcome,
} from '../agents/common/src/run-agent.js';
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
    postFailures: 0,
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

test('a posting call that failed is not a finding', () => {
  // agent-sh/agent-workspace-linux#70: the run posted a clean review, and reading
  // findings out of the attempt rather than the result reported "posted one or more
  // findings" on a pull request that had none. Same shape when the API rejects the
  // call: nothing reached the PR, so nothing was found.
  const s = summarizeReviewSteps([
    step([{ toolName: 'post_review', output: 'ERROR status=422: Unprocessable Entity' }]),
    step([{ toolName: 'skip_review', output: '{"ok":true,"skipped":true}' }]),
  ]);
  assert.equal(s.hasFindings, false);
  assert.equal(s.postFailures, 1);
  assert.equal(s.toolErrors, 1);
  // The failed post decided nothing, so the skip that followed is the decision.
  assert.equal(s.terminal, 'skip_review');
});

test('an empty review refused, then skipped, is a clean pass', () => {
  // The end-to-end #70 shape after the fix: the model reaches for post_review with
  // nothing anchored, the guard turns it away, and it decides skip_review. Nothing
  // was lost, the diff really is clean, and the check has to pass — otherwise the
  // false failure just moves from `hasFindings` to `postFailures`.
  const s = summarizeReviewSteps([
    step([{ toolName: 'read', output: 'workflow contents' }]),
    step([{ toolName: 'post_review', output: 'ERROR no_inline_comments: post_review needs at least one inline comment.' }]),
    step([{ toolName: 'skip_review', output: '{"ok":true,"skipped":true}' }]),
  ]);
  assert.equal(s.hasFindings, false);
  assert.equal(s.postFailures, 0);
  assert.equal(s.terminal, 'skip_review');
  assert.equal(s.inspections, 1);
  const result = checkResultForOutcome(outcome({ ...s, ranModel: true }));
  assert.equal(result.conclusion, 'success');
  assert.match(result.title, /passed/);
});

test('a review that could not be posted fails the check instead of approving', () => {
  const result = checkResultForOutcome(outcome({ postFailures: 1, toolErrors: 1, tracePath: '/vault/.traces/x/20260818T220000-pr70-b851423.jsonl' }));
  assert.equal(result.conclusion, 'failure');
  assert.match(result.title, /could not post/);
  assert.match(result.summary, /Posting calls that failed: 1/);
  assert.match(result.summary, /Local trace: 20260818T220000-pr70-b851423\.jsonl/);
  assert.doesNotMatch(result.summary, /vault/);
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

test('a pass that dies on the output cap is recognized as a stall', () => {
  // What both real stalls looked like in the trace: finishReason "length",
  // 8192 output tokens, no tool call.
  assert.equal(stalledOnOutputCap([{ finishReason: 'tool-calls', toolCalls: [{ toolName: 'read' }] }, { finishReason: 'length' }]), true);
  // Cut off, but it still managed the call - the loop keeps going on its own.
  assert.equal(stalledOnOutputCap([{ finishReason: 'length', toolCalls: [{ toolName: 'read' }] }]), false);
  assert.equal(stalledOnOutputCap([{ finishReason: 'stop' }]), false);
  assert.equal(stalledOnOutputCap([]), false);
});

test('describeOutcome surfaces inspection, forcing, and the trace', () => {
  const line = describeOutcome(outcome({ inspections: 0, forcedTerminal: true, tracePath: '/vault/.traces/x/t.jsonl' }));
  assert.match(line, /terminal=skip_review/);
  assert.match(line, /inspections=0/);
  assert.match(line, /forced=true/);
  assert.match(line, /trace=\/vault\/\.traces\/x\/t\.jsonl/);
});
