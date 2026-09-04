/**
 * Grok Code CLI session auth.
 *
 * Reads the OIDC access token from ~/.grok/auth.json (same store `grok login`
 * writes) and talks to the CLI chat proxy. Tokens last a few hours; we refresh
 * via the stored refresh_token and write the new pair back so the daemon and
 * the Grok CLI keep sharing one session.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import type { ModelSpec } from './config.js';

export const GROK_CLI_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const DEFAULT_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const EARLY_INVALIDATION_MS = 5 * 60 * 1000;
const LOCK_WAIT_MS = 8_000;

type GrokAuthEntry = {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_client_id?: string;
  oidc_issuer?: string;
};

type GrokAuthFile = Record<string, GrokAuthEntry>;

type CachedToken = { token: string; expiresAtMs: number; path: string };

let cached: CachedToken | null = null;
let refreshInFlight: { promise: Promise<string>; force: boolean } | null = null;

export function grokAuthPath(): string {
  return process.env.REVUTO_GROK_AUTH_FILE || join(homedir(), '.grok', 'auth.json');
}

export function isGrokCLIProxy(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === 'cli-chat-proxy.grok.com';
  } catch {
    return false;
  }
}

export function usesGrokCLIAuth(spec: ModelSpec): boolean {
  if (spec.auth === 'grok') return true;
  return (spec.auth ?? 'auto') === 'auto' && isGrokCLIProxy(spec.baseURL);
}

export function grokCLIAuthAvailable(): boolean {
  try {
    return Object.values(readAuthFile(grokAuthPath())).some((entry) => Boolean(entry.key || entry.refresh_token));
  } catch {
    return false;
  }
}

export function grokCLIClientVersion(): string {
  const override = process.env.REVUTO_GROK_CLIENT_VERSION?.trim();
  if (override) return override;
  try {
    const raw = readFileSync(join(homedir(), '.grok', 'version.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version?.trim()) return parsed.version.trim();
  } catch {
    // fall through
  }
  return '1.0.13';
}

export function grokCLIHeaders(model: string): Record<string, string> {
  return {
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': grokCLIClientVersion(),
    'x-grok-client-identifier': 'revuto',
    'x-grok-model-override': model,
  };
}

export async function grokCLIToken(): Promise<string> {
  const now = Date.now();
  const path = grokAuthPath();
  if (cached && cached.path === path && cached.expiresAtMs - EARLY_INVALIDATION_MS > now) return cached.token;

  const fresh = readFreshToken(path, now);
  if (fresh) {
    cached = { ...fresh, path };
    return fresh.token;
  }
  return refreshGrokCLIToken();
}

export async function refreshGrokCLIToken(opts: { force?: boolean; rejectedToken?: string } = {}): Promise<string> {
  const force = Boolean(opts.force);
  if (force) cached = null;

  if (refreshInFlight && (!force || refreshInFlight.force)) {
    return refreshInFlight.promise;
  }

  const promise = doRefresh(force, opts.rejectedToken).finally(() => {
    if (refreshInFlight?.promise === promise) {
      refreshInFlight = null;
    }
  });
  refreshInFlight = { promise, force };
  return promise;
}

function readFreshToken(path: string, now: number): Omit<CachedToken, 'path'> | null {
  const entries = readAuthFile(path);
  let best: Omit<CachedToken, 'path'> | null = null;
  for (const entry of Object.values(entries)) {
    if (!entry.key) continue;
    const expiresAtMs = parseExpiresAt(entry.expires_at);
    if (expiresAtMs !== null && expiresAtMs - EARLY_INVALIDATION_MS <= now) continue;
    if (!best || (expiresAtMs ?? Number.POSITIVE_INFINITY) > best.expiresAtMs) {
      best = { token: entry.key, expiresAtMs: expiresAtMs ?? now + 60 * 60 * 1000 };
    }
  }
  return best;
}

async function doRefresh(force = false, rejectedToken?: string): Promise<string> {
  const path = grokAuthPath();
  return withAuthLock(path, async () => {
    const now = Date.now();
    const raced = readFreshToken(path, now);
    if (raced) {
      if (!force || (rejectedToken && raced.token !== rejectedToken)) {
        cached = { ...raced, path };
        return raced.token;
      }
    }

    const raw = readAuthFile(path);
    const picked = pickRefreshable(raw);
    if (!picked) {
      const hadKey = Object.values(raw).some((entry) => Boolean(entry.key));
      throw new Error(
        hadKey
          ? `Grok Code CLI token in ${path} is expired and cannot be refreshed (run \`grok login\`)`
          : `no Grok Code CLI session in ${path} (run \`grok login\`)`,
      );
    }
    const [id, entry] = picked;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: entry.refresh_token,
      client_id: entry.oidc_client_id,
    });
    const endpoint = tokenEndpoint(entry.oidc_issuer);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Grok Code CLI token refresh failed (${response.status}): ${text.slice(0, 200)}`);
    }
    let payload: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new Error('Grok Code CLI token refresh returned non-JSON');
    }
    if (!payload.access_token) {
      throw new Error('Grok Code CLI token refresh returned no access_token');
    }

    const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 6 * 60 * 60;
    const expiresAtMs = Date.now() + expiresIn * 1000;
    const next: GrokAuthEntry = {
      ...entry,
      key: payload.access_token,
      refresh_token: payload.refresh_token || entry.refresh_token,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
    writeAuthFile(path, { ...raw, [id]: next });
    cached = { token: payload.access_token, expiresAtMs, path };
    return payload.access_token;
  });
}

type RefreshableEntry = GrokAuthEntry & { refresh_token: string; oidc_client_id: string };

function pickRefreshable(entries: GrokAuthFile): [string, RefreshableEntry] | null {
  let best: [string, RefreshableEntry] | null = null;
  let bestExp = -Infinity;
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry.refresh_token || !entry.oidc_client_id) continue;
    const exp = parseExpiresAt(entry.expires_at) ?? 0;
    const refreshable: RefreshableEntry = { ...entry, refresh_token: entry.refresh_token, oidc_client_id: entry.oidc_client_id };
    if (!best || exp > bestExp) {
      best = [id, refreshable];
      bestExp = exp;
    }
  }
  return best;
}

function tokenEndpoint(issuer?: string): string {
  if (!issuer || issuer === 'https://auth.x.ai') return DEFAULT_TOKEN_ENDPOINT;
  return `${issuer.replace(/\/+$/, '')}/oauth2/token`;
}

function readAuthFile(path: string): GrokAuthFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no Grok Code CLI session at ${path} (run \`grok login\`)`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as GrokAuthFile;
  } catch (err) {
    throw new Error(`cannot parse Grok Code CLI auth at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeAuthFile(path: string, entries: GrokAuthFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function parseExpiresAt(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

interface LockOwner {
  pid: number;
  hostname: string;
  createdAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryCleanStaleLock(lockDir: string): boolean {
  try {
    const ownerPath = join(lockDir, 'owner.json');
    let isStale = false;
    try {
      const raw = readFileSync(ownerPath, 'utf8');
      const owner = JSON.parse(raw) as Partial<LockOwner>;
      if (typeof owner.pid === 'number') {
        if (owner.hostname === hostname() && !isProcessAlive(owner.pid)) {
          isStale = true;
        } else if (typeof owner.createdAt === 'number' && Date.now() - owner.createdAt > LOCK_WAIT_MS) {
          isStale = true;
        }
      }
    } catch {
      try {
        const st = statSync(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_WAIT_MS) {
          isStale = true;
        }
      } catch {
        // stat failed
      }
    }

    if (isStale) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
        return true;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return false;
}

async function withAuthLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${path}.revuto-lock`;
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(
          join(lockDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: Date.now() }),
          { mode: 0o600 },
        );
      } catch {
        // owner write is best-effort
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      if (tryCleanStaleLock(lockDir)) {
        continue;
      }

      if (Date.now() - started > LOCK_WAIT_MS) {
        tryCleanStaleLock(lockDir);
        throw new Error(`timeout waiting for Grok Code CLI auth lock (${lockDir})`);
      }
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // lock dir is best-effort
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
