import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Authentication is trusted operator configuration. Do not inherit GitHub,
// unrelated provider keys, shell injection variables, or project settings.
const AUTH_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
] as const;

// A subscription run carries only the plan's OAuth token, so an API key or a
// third-party provider switch in the daemon environment cannot redirect it.
const SUBSCRIPTION_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;

/**
 * Isolation for a subscription run, which cannot use --bare (bare mode never
 * reads OAuth): a private config dir in place of ~/.claude (no user settings,
 * plugins, hooks, memory or stored login), no CLAUDE.md, no auto-memory and no
 * nonessential traffic.
 */
export function claudeSubscriptionIsolation(configDir: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

export function claudeEnvironment(env: NodeJS.ProcessEnv = process.env, userSettings?: string, subscription = false): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  let settings: { env?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(readFileSync(userSettings ?? join(env.HOME ?? homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const key of subscription ? SUBSCRIPTION_KEYS : AUTH_KEYS) {
    const value = env[key] ?? settings.env?.[key];
    if (typeof value === 'string') result[key] = value;
  }
  if (subscription && !result.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    throw new Error('Claude subscription review needs CLAUDE_CODE_OAUTH_TOKEN (create one with `claude setup-token`)');
  }
  return result;
}
