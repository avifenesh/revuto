/**
 * GitHub auth for both local/manual work and real-time GitHub App deliveries.
 * Poll discovery and non-App work use a personal token. Webhook reviews,
 * manual reviews, and polling fallback reviews for configured App owners use a
 * short-lived installation token scoped to the account and repositories that
 * installed the App.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { GithubAppConfig } from './config.js';

export interface GithubAuth {
  readonly octokit: Octokit;
  readonly token: string;
  /** Login used for comments/reviews, when known. */
  readonly login?: string;
}

let cached: GithubAuth | null = null;
type AppAuth = ReturnType<typeof createAppAuth>;

const appAuthCache = new Map<string, AppAuth>();
const appLoginCache = new Map<string, string>();
const installationIdCache = new Map<string, number>();

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

function appCacheKey(config: GithubAppConfig): string {
  return `${config.appId}:${config.privateKeyPath}`;
}

function getAppAuth(config: GithubAppConfig): AppAuth {
  const key = appCacheKey(config);
  const existing = appAuthCache.get(key);
  if (existing) return existing;

  let privateKey: string;
  try {
    privateKey = readFileSync(config.privateKeyPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read GitHub App private key ${config.privateKeyPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const auth = createAppAuth({ appId: config.appId, privateKey });
  appAuthCache.set(key, auth);
  return auth;
}

async function getAppBotLogin(config: GithubAppConfig): Promise<string> {
  const key = appCacheKey(config);
  const existing = appLoginCache.get(key);
  if (existing) return existing;

  const app = await getAppAuth(config)({ type: 'app' });
  const octokit = new Octokit({ auth: app.token });
  const { data } = await octokit.apps.getAuthenticated();
  if (!data) throw new Error('GitHub App metadata response was empty');
  const login = `${data.slug}[bot]`;
  appLoginCache.set(key, login);
  return login;
}

/** Create an installation-scoped client from the installation ID in a webhook payload. */
export async function getInstallationOctokit(config: GithubAppConfig, installationId: number): Promise<GithubAuth> {
  const installation = await getAppAuth(config)({ type: 'installation', installationId });
  return {
    octokit: new Octokit({ auth: installation.token }),
    token: installation.token,
    login: await getAppBotLogin(config),
  };
}

/** Resolve the App installation for a repository, used by the polling fallback. */
export async function getRepositoryInstallationOctokit(config: GithubAppConfig, repo: string): Promise<GithubAuth> {
  const parts = repo.split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) throw new Error(`bad repo: ${repo} (expected owner/name)`);
  const key = `${appCacheKey(config)}:${repo.toLowerCase()}`;
  let installationId = installationIdCache.get(key);
  if (!installationId) {
    const app = await getAppAuth(config)({ type: 'app' });
    const octokit = new Octokit({ auth: app.token });
    const { data } = await octokit.apps.getRepoInstallation({ owner, repo: name });
    installationId = data.id;
    installationIdCache.set(key, installationId);
  }
  return getInstallationOctokit(config, installationId);
}
