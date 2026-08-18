import { basename } from 'node:path';

import type { GithubAppConfig } from '../../agents/common/src/config.js';
import type { GithubAuth } from '../../agents/common/src/github-auth.js';
import type { ReviewOutcome } from '../../agents/common/src/run-agent.js';
import { signReviewBody } from '../../agents/common/src/tools/gh.js';

export interface ReviewCheckTarget {
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly detailsUrl: string;
}

export interface CheckResult {
  readonly conclusion: 'success' | 'failure';
  readonly title: string;
  readonly summary: string;
}

export function checkResultForOutcome(outcome: ReviewOutcome): CheckResult {
  if (outcome.hasFindings || outcome.terminal === 'post_review') {
    return {
      conclusion: 'failure',
      title: 'Revuto found review concerns',
      summary: 'Revuto posted one or more findings on the pull request. Address the review comments and push a new head.',
    };
  }
  // The run tried to put something on the pull request and the call came back
  // ERROR, so whatever it meant to say reached nobody. Whichever way it ended
  // afterwards, this is not a review anyone can read, and a `skip_review` that
  // follows a failed post is not the model calling the diff clean.
  if (outcome.postFailures > 0) {
    return {
      conclusion: 'failure',
      title: 'Revuto could not post its review',
      summary: [
        `Posting calls that failed: ${outcome.postFailures}. Terminal decision: ${outcome.terminal}.`,
        'Nothing reached the pull request, so this check does not pass on it. Retry the review, or inspect the daemon logs for the posting error.',
        outcome.tracePath ? `Local trace: ${basename(outcome.tracePath)}` : null,
      ].filter(Boolean).join('\n\n'),
    };
  }
  if (outcome.terminal === 'skip_review') {
    // A skip with no successful inspection call is not a clean bill of health: the
    // model never read the code. That happens when its tool calls all failed, or
    // when the decision came from the terminal-tools-only recovery pass, where it
    // has nothing to inspect with. Reporting success there passes - and, for a
    // GitHub App, approves - a pull request on a review that never happened.
    // Two skips do not mean the diff is clean, and neither may pass:
    //
    //   - nothing was inspected: every tool call failed, or the run never made one,
    //     so the model never read the code;
    //   - the skip came from the forced terminal-only pass: the review stalled and
    //     the skip is the fallback's doing, not a judgement on the diff.
    //
    // Reporting success for either passes - and, for a GitHub App, approves - a
    // pull request on a review that did not happen.
    if (outcome.ranModel && (outcome.inspections === 0 || outcome.forcedTerminal)) {
      const uninspected = outcome.inspections === 0;
      const detail = [
        `Terminal decision: skip_review after ${outcome.steps} step(s) with ${outcome.inspections} successful inspection tool call(s).`,
        outcome.toolErrors > 0 ? `Tool calls that failed: ${outcome.toolErrors}.` : null,
        outcome.forcedTerminal
          ? 'The decision came from the forced terminal-only pass, not from the review itself: the review stalled without deciding anything.'
          : null,
        // Basename only: the check summary is public, the vault path is local.
        outcome.tracePath ? `Local trace: ${basename(outcome.tracePath)}` : null,
        uninspected
          ? 'Retry the review once the tool surface works; this check does not pass on an uninspected diff.'
          : 'Retry the review; this check does not pass on a skip the review never decided on.',
      ].filter(Boolean).join('\n\n');
      return {
        conclusion: 'failure',
        title: uninspected ? 'Revuto skipped without inspecting the diff' : 'Revuto skipped without deciding',
        summary: detail,
      };
    }
    return {
      conclusion: 'success',
      title: 'Revuto review passed',
      summary: [
        'Revuto completed the review and found no evidence-backed concerns.',
        `Inspection: ${outcome.inspections} tool call(s) over ${outcome.steps} step(s).`,
      ].join('\n\n'),
    };
  }
  return {
    conclusion: 'failure',
    title: 'Revuto review did not finish',
    summary: 'Revuto ended without a clean or findings decision. Retry the review or inspect the daemon logs.',
  };
}

export function checkResultForError(err: unknown): CheckResult {
  const message = (err instanceof Error ? err.message : String(err)).replaceAll('```', "'''").slice(0, 6000);
  return {
    conclusion: 'failure',
    title: 'Revuto review failed',
    summary: `Revuto could not complete this review.\n\n\`\`\`\n${message}\n\`\`\``,
  };
}

export function assertReviewedHead(target: ReviewCheckTarget, outcome: ReviewOutcome): void {
  if (outcome.headSha !== target.headSha) {
    throw new Error(
      `pull request head changed during review: expected ${target.headSha}, reviewed ${outcome.headSha}`,
    );
  }
}

function ownerAndRepo(target: ReviewCheckTarget): [string, string] {
  const parts = target.repo.split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) throw new Error(`bad check repository: ${target.repo}`);
  return [owner, repo];
}

export async function createReviewCheck(
  auth: GithubAuth,
  app: GithubAppConfig,
  target: ReviewCheckTarget,
): Promise<number> {
  const [owner, repo] = ownerAndRepo(target);
  const { data } = await auth.octokit.checks.create({
    owner,
    repo,
    name: app.checkName,
    head_sha: target.headSha,
    status: 'in_progress',
    external_id: `${target.repo}#${target.prNumber}@${target.headSha}`,
    details_url: target.detailsUrl,
    started_at: new Date().toISOString(),
    output: {
      title: 'Revuto review in progress',
      summary: 'Revuto claimed this pull request head and is reviewing it now.',
    },
  });
  return data.id;
}

export async function completeReviewCheck(
  auth: GithubAuth,
  app: GithubAppConfig,
  target: ReviewCheckTarget,
  checkRunId: number,
  result: CheckResult,
): Promise<void> {
  const [owner, repo] = ownerAndRepo(target);
  let finalResult = result;
  if (result.conclusion === 'success') {
    try {
      await auth.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: target.prNumber,
        commit_id: target.headSha,
        event: 'APPROVE',
        body: signReviewBody('Revuto completed the review and found no evidence-backed concerns.'),
      });
    } catch (err) {
      finalResult = checkResultForError(
        new Error(`could not submit the clean App approval: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }
  await auth.octokit.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    name: app.checkName,
    status: 'completed',
    conclusion: finalResult.conclusion,
    completed_at: new Date().toISOString(),
    details_url: target.detailsUrl,
    output: { title: finalResult.title, summary: finalResult.summary },
  });
}
