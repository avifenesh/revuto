/**
 * Local engine configuration.
 *
 * Replaces the old AWS env-var surface (S3 bucket / keys, Secrets Manager ARN,
 * Bedrock model id, AgentCore registry id). One JSON file describes the vault
 * location, GitHub token source, per-role models, and schedules. Per-repo
 * overrides live in the vault's reviewer notes (see daemon/store), not here.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
    readonly allowWrite: boolean;
    /** Parent dir for per-repo working checkouts. */
    readonly workspaceDir: string;
  };
  /** Caps. 0 = unlimited. Run/comment/token counts are per repo per UTC day. */
  readonly limits: {
    /** Per-run output-token cap for each agent. */
    readonly maxOutputTokens: { readonly review: number; readonly curator: number; readonly distill: number };
    /** Max review runs per repo per day. */
    readonly dailyReviews: number;
    /** Max comments processed per learn pass (per batch). */
    readonly learnBatch: number;
    /** Max comments processed per repo per day. */
    readonly dailyLearn: number;
    /** Shared daily token budget across ALL agents (review + curator + distill), per repo. */
    readonly dailyTokens: number;
  };
  /** Memory backend. Skills are always Obsidian markdown; this is concerns/cursors/vectors. */
  readonly store: {
    readonly backend: 'sqlite' | 'surreal';
    readonly surreal: { readonly url: string; readonly namespace: string; readonly username?: string; readonly password?: string };
  };
}

const DEFAULT_SCHEDULES = { review: '*/12 * * * *', learn: '0 */4 * * *', decay: '0 3 * * *' };
const DEFAULT_REVIEW = { maxSteps: 150, allowWrite: false, workspaceDir: '' };
const DEFAULT_MAX_OUTPUT_TOKENS = { review: 32768, curator: 16384, distill: 8192 };

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

/** The default vault: $REVUTO_VAULT, else ~/revuto. The config + skills + reviewer notes live here. */
export function defaultVaultPath(): string {
  return resolveHome(process.env.REVUTO_VAULT ?? '~/revuto');
}

/**
 * Resolve the config path. Order: explicit arg → $REVUTO_CONFIG → $REVIEWER_CONFIG
 * → ./revuto.config.json (local override) → <vault>/revuto.config.json (the default
 * home) → ./reviewer.config.json (back-compat). The config lives in the vault by
 * default so config + skills + reviewer notes are controlled in one place (Obsidian).
 */
function defaultConfigPath(): string {
  if (process.env.REVUTO_CONFIG) return process.env.REVUTO_CONFIG;
  if (process.env.REVIEWER_CONFIG) return process.env.REVIEWER_CONFIG;
  if (existsSync(resolve('revuto.config.json'))) return 'revuto.config.json';
  const vaultCfg = join(defaultVaultPath(), 'revuto.config.json');
  if (existsSync(vaultCfg)) return vaultCfg;
  if (existsSync(resolve('reviewer.config.json'))) return 'reviewer.config.json';
  return vaultCfg; // not-found error then points at the vault location
}

export function loadConfig(path?: string): ReviewerConfig {
  const file = resolve(path ?? defaultConfigPath());
  let raw: any;
  if (!existsSync(file)) {
    throw new Error(`config: ${file} not found. Run \`revuto init-config\` to create a starter config, then edit vaultPath + models.`);
  }
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // vaultPath defaults to the config file's own folder — so the config can live
  // inside the vault and the user controls everything (config + skills + reviewers) there.
  const vaultPath = raw.vaultPath ? resolveHome(raw.vaultPath) : dirname(file);
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
    maxSteps: raw.review?.maxSteps ?? DEFAULT_REVIEW.maxSteps,
    allowWrite: raw.review?.allowWrite ?? DEFAULT_REVIEW.allowWrite,
    workspaceDir: resolveHome(raw.review?.workspaceDir ?? `${vaultPath}/.workspaces`),
  };
  const mot = raw.limits?.maxOutputTokens ?? {};
  const limits = {
    maxOutputTokens: {
      // legacy review.maxOutputTokens still honored for the review cap
      review: mot.review ?? raw.review?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS.review,
      curator: mot.curator ?? DEFAULT_MAX_OUTPUT_TOKENS.curator,
      distill: mot.distill ?? DEFAULT_MAX_OUTPUT_TOKENS.distill,
    },
    dailyReviews: Math.max(0, raw.limits?.dailyReviews ?? 0),
    learnBatch: Math.max(0, raw.limits?.learnBatch ?? 0),
    dailyLearn: Math.max(0, raw.limits?.dailyLearn ?? 0),
    dailyTokens: Math.max(0, raw.limits?.dailyTokens ?? 0),
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

  return { vaultPath, github: { tokenEnv }, models, schedules, review, limits, store };
}
