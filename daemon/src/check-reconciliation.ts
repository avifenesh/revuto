import type { GithubAppConfig, ReviewerConfig } from '../../agents/common/src/config.js';
import { getRepositoryInstallationOctokit, type GithubAuth } from '../../agents/common/src/github-auth.js';
import { listReviewers } from './reviewers.js';

export interface CheckReconciliationDependencies {
  readonly repos?: readonly string[];
  readonly authForRepo?: (app: GithubAppConfig, repo: string) => Promise<GithubAuth>;
}

export interface CheckReconciliationResult {
  readonly completed: number;
  readonly failedRepos: number;
}

/**
 * Fail Revuto checks left in progress by a previous daemon process. This runs
 * before the new webhook server starts, so every matching in-progress check is
 * orphaned: no review in this process can still complete it.
 */
export async function reconcileStaleReviewChecks(
  config: ReviewerConfig,
  deps: CheckReconciliationDependencies = {},
): Promise<CheckReconciliationResult> {
  const app = config.github.app;
  if (!app) return { completed: 0, failedRepos: 0 };

  const repos = deps.repos ?? listReviewers(config).map((reviewer) => reviewer.repo);
  const authForRepo = deps.authForRepo ?? getRepositoryInstallationOctokit;
  let completed = 0;
  let failedRepos = 0;

  for (const repoSlug of repos) {
    const [owner, repo, extra] = repoSlug.split('/');
    if (!owner || !repo || extra) continue;
    if (app.allowedOwners.length > 0 && !app.allowedOwners.some((candidate) => candidate.toLowerCase() === owner.toLowerCase())) {
      continue;
    }

    try {
      const auth = await authForRepo(app, repoSlug);
      const pulls = await auth.octokit.paginate(auth.octokit.pulls.list, {
        owner,
        repo,
        state: 'open',
        per_page: 100,
      });
      for (const pull of pulls) {
        const checks = await auth.octokit.paginate(auth.octokit.checks.listForRef, {
          owner,
          repo,
          ref: pull.head.sha,
          check_name: app.checkName,
          filter: 'all',
          per_page: 100,
        });
        for (const check of checks) {
          if (check.status !== 'in_progress' || check.name !== app.checkName || check.app?.id !== app.appId) continue;
          await auth.octokit.checks.update({
            owner,
            repo,
            check_run_id: check.id,
            name: app.checkName,
            status: 'completed',
            conclusion: 'failure',
            completed_at: new Date().toISOString(),
            details_url: pull.html_url,
            output: {
              title: 'Revuto review was interrupted',
              summary: 'The daemon restarted before this review check completed. Retry the review on this pull request head.',
            },
          });
          completed++;
        }
      }
    } catch (err) {
      failedRepos++;
      console.error(`[checks] could not reconcile ${repoSlug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { completed, failedRepos };
}
