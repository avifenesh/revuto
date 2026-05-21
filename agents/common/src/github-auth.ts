/**
 * Local GitHub auth. Replaces the GitHub App + Secrets Manager flow with a
 * personal token: read $TOKEN_ENV, else fall back to `gh auth token`.
 */
import { execFileSync } from 'node:child_process';
import { Octokit } from '@octokit/rest';

export interface GithubAuth {
  readonly octokit: Octokit;
  readonly token: string;
}

let cached: GithubAuth | null = null;

export function getOctokit(opts: { tokenEnv: string }): GithubAuth {
  if (cached) return cached;

  let token = (process.env[opts.tokenEnv] ?? '').trim();
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    } catch {
      /* gh not installed / not logged in — fall through to the error below */
    }
  }
  if (!token) {
    throw new Error(`no GitHub token: set $${opts.tokenEnv} or run \`gh auth login\``);
  }

  cached = { octokit: new Octokit({ auth: token }), token };
  return cached;
}
