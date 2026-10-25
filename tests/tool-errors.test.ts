/**
 * Every tool surface has to report failure as a string starting with `ERROR`.
 * That string is the only thing separating "inspected the diff" from "the tool
 * surface was broken": `summarizeReviewSteps` counts anything else as a
 * successful inspection, and the check gate approves a skip that inspected
 * something.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPostReviewTool, type GhToolsDeps } from '../agents/common/src/tools/gh.js';
import { isToolErrorOutput } from '../agents/common/src/trace.js';
import { summarizeReviewSteps } from '../agents/common/src/run-agent.js';

/** What the engine makes of a single tool result. */
const asStep = (toolName: string, output: unknown) => summarizeReviewSteps([{ toolResults: [{ toolName, output }] }]);

test('post_review refuses a review with nothing anchored, and reports what it posted', async () => {
  // agent-sh/agent-workspace-linux#70: a clean review went out through post_review
  // with an empty `comments`, and the check reported "posted one or more findings" on
  // a pull request that had none. Nothing downstream can tell a "nothing to flag"
  // body from one carrying concerns, so the empty post is refused here instead of
  // being guessed at afterwards — the clean path is skip_review.
  const posts: unknown[] = [];
  const deps = {
    token: async () => 'unused',
    ctx: { owner: 'agent-sh', repo: 'agent-workspace-linux', prNumber: 70, headSha: 'b851423' },
    octokit: {
      pulls: {
        createReview: async (args: unknown) => {
          posts.push(args);
          return { data: { id: 1, html_url: 'https://example.invalid/pull/70#r1' } };
        },
      },
    },
  } as unknown as GhToolsDeps;
  const post = buildPostReviewTool(deps);

  const refused = (await post.callback({ body: 'Clean change; no inline comments.', comments: [] })) as string;
  assert.equal(isToolErrorOutput(refused), true, `expected an ERROR result, got: ${refused.slice(0, 200)}`);
  assert.match(refused, /skip_review/);
  assert.equal(posts.length, 0, 'a refused post must not reach the API');
  const refusedStep = asStep('post_review', refused);
  assert.equal(refusedStep.hasFindings, false);
  // The refusal dropped nothing, so it is not a lost review: the model is expected
  // to follow it with skip_review, and that has to stay a passing clean decision.
  assert.equal(refusedStep.postFailures, 0);

  const posted = (await post.callback({
    body: '',
    comments: [{ path: 'src/server.rs', line: 3137, body: 'Non-blocking: name the TTL.' }],
  })) as string;
  assert.equal(isToolErrorOutput(posted), false, `expected a posted result, got: ${posted.slice(0, 200)}`);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posted).inline_comments, 1);
  assert.equal(asStep('post_review', posted).hasFindings, true);
});

