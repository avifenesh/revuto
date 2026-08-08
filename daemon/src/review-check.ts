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
  if (outcome.terminal === 'skip_review') {
    return {
      conclusion: 'success',
      title: 'Revuto review passed',
      summary: 'Revuto completed the review and found no evidence-backed concerns.',
    };
  }
  if (outcome.terminal === 'post_review') {
    return {
      conclusion: 'failure',
      title: 'Revuto found review concerns',
      summary: 'Revuto posted one or more findings on the pull request. Address the review comments and push a new head.',
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
