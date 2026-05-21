/**
 * Local engine configuration.
 *
 * Replaces the old AWS env-var surface (S3 bucket / keys, Secrets Manager ARN,
 * Bedrock model id, AgentCore registry id). One JSON file describes the vault
 * location, GitHub token source, per-role models, and schedules. Per-repo
 * overrides live in the vault's reviewer notes (see daemon/store), not here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** Resolve a path, expanding a leading `~` to the home directory first. */
function resolveHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export interface ModelSpec {
  /** OpenAI-compatible base URL, e.g. http://localhost:8000/v1 or a gateway. */
  readonly baseURL: string;
  /** Model id as the endpoint expects it (e.g. "anthropic.claude-opus-4-7", "qwen3-8b"). */
  readonly model: string;
  /** Env var holding the API key. Omit for keyless local endpoints. */
  readonly apiKeyEnv?: string;
  /** Optional provider label for diagnostics. */
  readonly name?: string;
}

export interface ReviewerConfig {
  /** Obsidian vault (or plain dir) where skills + memory live. */
  readonly vaultPath: string;
  readonly github: { readonly tokenEnv: string };
  readonly models: {
    readonly review: ModelSpec;
    readonly curator: ModelSpec;
    readonly distill: ModelSpec;
    /** null = no embedder; dedup + skill selection fall back to LLM-judge / area-glob. */
    readonly embedder: ModelSpec | null;
  };
  /** cron expressions; defaults applied if absent. */
  readonly schedules: { readonly review: string; readonly learn: string; readonly decay: string };
  readonly review: {
    readonly maxSteps: number;
    readonly maxOutputTokens: number;
    readonly allowWrite: boolean;
    /** Parent dir for per-repo working checkouts. */
    readonly workspaceDir: string;
  };
  /** Memory backend. Skills are always Obsidian markdown; this is concerns/cursors/vectors. */
  readonly store: {
    readonly backend: 'sqlite' | 'surreal';
    readonly surreal: { readonly url: string; readonly namespace: string; readonly username?: string; readonly password?: string };
  };
}

const DEFAULT_SCHEDULES = { review: '*/12 * * * *', learn: '0 */4 * * *', decay: '0 3 * * *' };
const DEFAULT_REVIEW = { maxSteps: 150, maxOutputTokens: 32768, allowWrite: false, workspaceDir: '' };

function requireField<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === null || v === '') throw new Error(`config: required field "${name}" is missing`);
  return v;
}

function checkModel(m: ModelSpec | undefined, role: string): ModelSpec {
  if (!m) throw new Error(`config: models.${role} is required`);
  requireField(m.baseURL, `models.${role}.baseURL`);
  requireField(m.model, `models.${role}.model`);
  return m;
}

/**
 * Load and validate the config. Path resolution order:
 *   1. explicit `path` argument
 *   2. $REVIEWER_CONFIG
 *   3. ./reviewer.config.json (cwd)
 */
export function loadConfig(path?: string): ReviewerConfig {
  const file = resolve(path ?? process.env.REVIEWER_CONFIG ?? 'reviewer.config.json');
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const vaultPath = resolveHome(requireField(raw.vaultPath, 'vaultPath'));
  const tokenEnv = raw.github?.tokenEnv ?? 'GH_TOKEN';
  const models = {
    review: checkModel(raw.models?.review, 'review'),
    curator: checkModel(raw.models?.curator, 'curator'),
    distill: checkModel(raw.models?.distill, 'distill'),
    embedder: raw.models?.embedder ? checkModel(raw.models.embedder, 'embedder') : null,
  };
  const schedules = { ...DEFAULT_SCHEDULES, ...(raw.schedules ?? {}) };
  const review = {
    ...DEFAULT_REVIEW,
    ...(raw.review ?? {}),
    workspaceDir: resolveHome(raw.review?.workspaceDir ?? `${vaultPath}/.workspaces`),
  };

  const store = {
    // Default backend is SurrealDB (native vector search); set "sqlite" to opt into the zero-dep file store.
    backend: raw.store?.backend === 'sqlite' ? ('sqlite' as const) : ('surreal' as const),
    surreal: {
      url: raw.store?.surreal?.url ?? 'http://127.0.0.1:8000/rpc',
      namespace: raw.store?.surreal?.namespace ?? 'reviewer',
      username: raw.store?.surreal?.username ?? 'root',
      password: raw.store?.surreal?.password ?? 'root',
    },
  };

  return { vaultPath, github: { tokenEnv }, models, schedules, review, store };
}
