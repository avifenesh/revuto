/**
 * Grok Code CLI auth: read ~/.grok/auth.json, skip expired tokens, send proxy headers.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  grokCLIAuthAvailable,
  grokCLIHeaders,
  grokCLIToken,
  isGrokCLIProxy,
  refreshGrokCLIToken,
  usesGrokCLIAuth,
} from '../agents/common/src/grok-cli-auth.js';

function writeAuth(entries: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-grok-'));
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify(entries));
  process.env.REVUTO_GROK_AUTH_FILE = path;
  return path;
}

test('usesGrokCLIAuth is true for auth=grok and for the CLI proxy in auto mode', () => {
  assert.equal(usesGrokCLIAuth({ baseURL: 'https://example.test/v1', model: 'x', auth: 'grok' }), true);
  assert.equal(isGrokCLIProxy('https://cli-chat-proxy.grok.com/v1'), true);
  assert.equal(
    usesGrokCLIAuth({ baseURL: 'https://cli-chat-proxy.grok.com/v1', model: 'grok-4.6', auth: 'auto' }),
    true,
  );
  assert.equal(
    usesGrokCLIAuth({ baseURL: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3', auth: 'bearer' }),
    false,
  );
});

test('grokCLIToken returns the unexpired session token', async () => {
  writeAuth({
    'https://auth.x.ai::client': {
      key: 'cli-jwt-token',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
  assert.equal(await grokCLIToken(), 'cli-jwt-token');
  assert.equal(grokCLIAuthAvailable(), true);
});

test('grokCLIToken rejects an expired session with no refresh token', async () => {
  writeAuth({
    k: {
      key: 'expired-token',
      expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    },
  });
  await assert.rejects(grokCLIToken(), /expired and cannot be refreshed|no Grok Code CLI session/);
});

test('grokCLIHeaders set the CLI proxy routing headers', () => {
  process.env.REVUTO_GROK_CLIENT_VERSION = '9.9.9';
  const headers = grokCLIHeaders('grok-4.6');
  assert.equal(headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  assert.equal(headers['x-grok-client-version'], '9.9.9');
  assert.equal(headers['x-grok-client-identifier'], 'revuto');
  assert.equal(headers['x-grok-model-override'], 'grok-4.6');
  delete process.env.REVUTO_GROK_CLIENT_VERSION;
});

test('refreshGrokCLIToken({ force: true }) contacts token endpoint even with unexpired file token', async () => {
  const originalFetch = globalThis.fetch;
  let posted = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('auth.x.ai') || String(url).includes('/oauth2/token')) {
      posted = true;
      return new Response(JSON.stringify({
        access_token: 'new-refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  try {
    writeAuth({
      'https://auth.x.ai::client': {
        key: 'unexpired-but-rejected-token',
        refresh_token: 'valid-refresh-token',
        oidc_client_id: 'client-id',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    const token = await refreshGrokCLIToken({ force: true, rejectedToken: 'unexpired-but-rejected-token' });
    assert.equal(token, 'new-refreshed-token');
    assert.equal(posted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('withAuthLock recovers stale lock directory left by dead process', async () => {
  const path = writeAuth({
    'https://auth.x.ai::client': {
      key: 'token-with-stale-lock',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });

  const lockDir = `${path}.revuto-lock`;
  const { hostname } = await import('node:os');
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 99999999, hostname: hostname(), createdAt: Date.now() }));

  const token = await grokCLIToken();
  assert.equal(token, 'token-with-stale-lock');
});
