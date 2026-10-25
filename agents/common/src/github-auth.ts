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
  /**
   * Token for the subprocesses that need one (git over HTTPS, the `gh` CLI).
   * Resolved per use, never captured: an installation token lives 60 minutes
   * (@octokit/auth-app caches it for 59) while a review runs for tens of
   * minutes, so a job that claims a head late in a cached token's life would
   * otherwise reach its post_review call holding an expired credential and get
   * a 401 after all the model work was already paid for.
   */
  token(): Promise<string>;
  /** Login used for comments/reviews, when known. */
  readonly login?: string;
}

let cached: GithubAuth | null = null;
type AppAuth = ReturnType<typeof createAppAuth>;

const appAuthCache = new Map<string, AppAuth>();
const appLoginCache = new Map<string, string>();
const installationIdCache = new Map<string, number>();

/** Only the repository installation endpoint can establish this condition. */
export class RepositoryNotInstalledError extends Error {
  readonly status = 404;
  constructor() { super('GitHub App is not installed for this repository'); }
}

/** Octokit forwards a fetch signal, but its current request adapter ignores timeout. */
export function githubFetchWithDeadline(fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    // Octokit swallows body-read errors as empty data. Buffer within the
    // deadline so a body timeout reaches the caller as a request failure.
    let body: ArrayBuffer | string | null = response.body === null ? null : await response.arrayBuffer();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (body !== null && response.status >= 200 && response.status < 300
      && /\/app\/hook\/deliveries(?:\/\d+)?$/.test(url.pathname)) {
      // Reading the original numeric token avoids losing int64 delivery IDs
      // before Octokit's response decoder sees them. Requires Node >= 22.
      const parsed = JSON.parse(new TextDecoder().decode(body), (key: string, value: unknown, context?: { source?: string }) => {
        if (key === 'id' && typeof value === 'number') {
          if (!context?.source || !/^\d+$/.test(context.source)) throw new Error('invalid webhook delivery ID');
          return context.source;
        }
        return value;
      });
      body = JSON.stringify(parsed);
    }
    const buffered = new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
    Object.defineProperty(buffered, 'url', { value: response.url });
    return buffered;
  };
}

/** The App that serves `repo`: configured, and the repo's owner is allowed (or none are listed). */
export function githubAppForRepo(github: { readonly app?: GithubAppConfig }, repo: string): GithubAppConfig | undefined {
  const app = github.app;
  const owner = repo.split('/')[0]?.toLowerCase();
  if (!app || !owner) return undefined;
  return app.allowedOwners.length === 0 || app.allowedOwners.some((candidate) => candidate.toLowerCase() === owner) ? app : undefined;
}

/**
 * GitHub access for one repository. With a GitHub App that serves the repo,
 * this is the App's installation token, scoped to that repo, and no personal
 * token is read. Only a repo the App does not serve (no App, an owner outside
 * `allowedOwners`, or no installation) uses the personal token.
 */
export async function githubAuthForRepo(
  github: { readonly tokenEnv: string; readonly app?: GithubAppConfig },
  repo: string,
): Promise<GithubAuth> {
  const app = githubAppForRepo(github, repo);
  if (!app) return getOctokit(github);
  try {
    return await getRepositoryInstallationOctokit(app, repo);
  } catch (err) {
    if (!(err instanceof RepositoryNotInstalledError)) throw err;
    try {
      return getOctokit(github);
    } catch {
      throw err;
    }
  }
}

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

  const personalToken = token;
  cached = { octokit: new Octokit({ auth: personalToken }), token: async () => personalToken };
  return cached;
}

function appCacheKey(config: GithubAppConfig): string {
  return `${config.appId}:${config.privateKeyPath}`;
}

function readPrivateKey(config: GithubAppConfig): string {
  try {
    return readFileSync(config.privateKeyPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read GitHub App private key ${config.privateKeyPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getAppAuth(config: GithubAppConfig): AppAuth {
  const key = appCacheKey(config);
  const existing = appAuthCache.get(key);
  if (existing) return existing;

  const auth = createAppAuth({ appId: config.appId, privateKey: readPrivateKey(config) });
  appAuthCache.set(key, auth);
  return auth;
}

/** App-level webhook API client; the auth hook refreshes the App JWT per request. */
export function getAppOctokit(config: GithubAppConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: readPrivateKey(config) },
    request: { fetch: githubFetchWithDeadline() },
    // Octokit request errors can contain signed headers and delivery payloads.
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

/** The App's `<slug>[bot]` login, the identity App-mode reviews post as. */
export async function getAppBotLogin(config: GithubAppConfig): Promise<string> {
  const key = appCacheKey(config);
  const existing = appLoginCache.get(key);
  if (existing) return existing;

  const app = await getAppAuth(config)({ type: 'app' });
  const octokit = new Octokit({ auth: app.token, request: { fetch: githubFetchWithDeadline() } });
  const { data } = await octokit.apps.getAuthenticated();
  if (!data) throw new Error('GitHub App metadata response was empty');
  const login = `${data.slug}[bot]`;
  appLoginCache.set(key, login);
  return login;
}

/** Create an installation-scoped client from the installation ID in a webhook payload. */
/**
 * An installation client. With `repo`, its tokens are minted for that repository
 * only: a review then holds no credential for the installation's other repos.
 */
export async function getInstallationOctokit(config: GithubAppConfig, installationId: number, repo?: string): Promise<GithubAuth> {
  // A hook rather than a token string: every request asks for the current token,
  // so a request made after the cached installation token aged out mints a new one
  // instead of sending a dead credential. Handing `new Octokit({ auth: <token> })`
  // a token captured at claim time is what made long reviews fail at the finish
  // line with "Bad credentials".
  const plain = new Octokit({ request: { fetch: githubFetchWithDeadline() } });
  const appAuth = createAppAuth({ appId: config.appId, privateKey: readPrivateKey(config), installationId, request: plain.request });
  // auth-app's own request hook mints tokens with no per-call options, so a scope set
  // in the strategy never reaches the token. Every mint here names the repository.
  const mint = scopedInstallationToken(appAuth, repo);
  const octokit = new Octokit({ authStrategy: () => tokenHookAuth(mint), request: { fetch: githubFetchWithDeadline() } });
  return {
    octokit,
    // The same mint (and auth-app's cache), so git/gh subprocesses get a live token too.
    token: mint,
    login: await getAppBotLogin(config),
  };
}

type HookRequest = ((options: any) => Promise<any>) & { endpoint: { merge: (route: any, parameters?: any) => any } };

type InstallationAuth = (options: { type: 'installation'; repositoryNames?: string[] }) => Promise<{ token: string }>;

/** A token getter for one installation, scoped to `repo` when given. */
export function scopedInstallationToken(appAuth: InstallationAuth, repo?: string): () => Promise<string> {
  const repositoryNames = repo ? [repo.split('/')[1]!] : undefined;
  return async () => (await appAuth({ type: 'installation', ...(repositoryNames ? { repositoryNames } : {}) })).token;
}

/** An Octokit auth strategy that sets `token <mint()>` on every request. */
export function tokenHookAuth(mint: () => Promise<string>) {
  const auth = async () => ({ type: 'token', tokenType: 'installation', token: await mint() });
  // Octokit's hook contract: (request, route, parameters) => response.
  auth.hook = async (request: HookRequest, route: unknown, parameters?: Record<string, unknown>) => {
    const endpoint = request.endpoint.merge(route, parameters);
    endpoint.headers.authorization = `token ${await mint()}`;
    return request(endpoint);
  };
  return auth;
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
    const octokit = new Octokit({ auth: app.token, request: { fetch: githubFetchWithDeadline() } });
    try {
      const { data } = await octokit.apps.getRepoInstallation({ owner, repo: name });
      installationId = data.id;
    } catch (err) {
      if ((err as { status?: number })?.status === 404) throw new RepositoryNotInstalledError();
      throw err;
    }
    installationIdCache.set(key, installationId);
  }
  return getInstallationOctokit(config, installationId, repo);
}
