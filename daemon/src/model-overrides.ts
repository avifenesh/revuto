import type { ModelSpec, ReviewerConfig } from '../../agents/common/src/config.js';

export type ModelRole = 'review' | 'reviewSmall' | 'reviewMedium' | 'curator' | 'distill';

export interface ModelOverride {
  readonly role: ModelRole;
  readonly chain: string;
  readonly source: string;
}

export interface ParsedModelOverrideArgs {
  readonly args: string[];
  readonly overrides: readonly ModelOverride[];
  readonly bedrockRegion?: string;
}

const DEFAULT_BEDROCK_REGION = 'us-east-2';
/** Bedrock Mantle serves the GPT-6 family from us-east-1, not from the Claude default region. */
const DEFAULT_MANTLE_REGION = 'us-east-1';
const SOL61_MODEL = 'openai.gpt-6.1-sol';
const BEDROCK_API_KEY_ENV = 'AWS_BEARER_TOKEN_BEDROCK';
const OPUS_MODEL = 'global.anthropic.claude-opus-5-5';
const FABLE_MODEL = 'global.anthropic.claude-fable-5-1';
const SONNET_MODEL = 'global.anthropic.claude-sonnet-5-5';
const ROLE_FLAGS: Record<string, ModelRole> = {
  '--review-model': 'review',
  '--review-small-model': 'reviewSmall',
  '--review-medium-model': 'reviewMedium',
  '--curator-model': 'curator',
  '--distill-model': 'distill',
};
const ROLES = new Set<ModelRole>(['review', 'reviewSmall', 'reviewMedium', 'curator', 'distill']);

export function extractModelOverrideArgs(argv: readonly string[]): ParsedModelOverrideArgs {
  const args: string[] = [];
  const overrides: ModelOverride[] = [];
  let bedrockRegion: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--bedrock-region') {
      bedrockRegion = requireNext(argv, ++i, arg);
      continue;
    }
    if (arg.startsWith('--bedrock-region=')) {
      bedrockRegion = requireValue(arg.slice('--bedrock-region='.length), arg);
      continue;
    }
    if (arg === '--model') {
      overrides.push(parseModelOverride(requireNext(argv, ++i, arg), arg));
      continue;
    }
    if (arg.startsWith('--model=')) {
      overrides.push(parseModelOverride(requireValue(arg.slice('--model='.length), arg), '--model'));
      continue;
    }
    const roleFlag = roleFlagFor(arg);
    if (roleFlag) {
      const value = valueForRoleFlag(argv, i, arg);
      if (!arg.includes('=')) i++;
      overrides.push({ role: roleFlag.role, chain: value, source: roleFlag.flag });
      continue;
    }
    args.push(arg);
  }

  return { args, overrides, ...(bedrockRegion ? { bedrockRegion } : {}) };
}

export function applyModelOverrides(config: ReviewerConfig, parsed: Pick<ParsedModelOverrideArgs, 'overrides' | 'bedrockRegion'>): ReviewerConfig {
  if (parsed.overrides.length === 0) return config;
  const defaultRegion = parsed.bedrockRegion ?? process.env.REVUTO_BEDROCK_REGION;
  const models: { -readonly [K in keyof ReviewerConfig['models']]: ReviewerConfig['models'][K] } = { ...config.models };
  for (const override of parsed.overrides) {
    models[override.role] = modelChain(override.chain, defaultRegion);
  }
  // A pinned review model reviews every PR: the vault's small and medium tiers
  // step aside unless the operator pinned those roles too.
  const roles = new Set(parsed.overrides.map((o) => o.role));
  if (roles.has('review') && !roles.has('reviewSmall')) delete models.reviewSmall;
  if (roles.has('review') && !roles.has('reviewMedium')) delete models.reviewMedium;
  return { ...config, models };
}

/**
 * Resolve a model alias. `defaultRegion` (from --bedrock-region or
 * $REVUTO_BEDROCK_REGION) applies to every Bedrock entry; without it, Mantle
 * (OpenAI) models use us-east-1 and Converse (Claude) models us-east-2. A
 * trailing @region on the alias wins over both.
 */
export function modelPreset(alias: string, defaultRegion?: string): ModelSpec {
  const { value, region: explicit } = splitRegion(alias, defaultRegion);
  const mantle = explicit ?? DEFAULT_MANTLE_REGION;
  const converse = explicit ?? DEFAULT_BEDROCK_REGION;
  const raw = value.trim();
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[\s._-]/g, '');

  if (compact === 'codex' || compact === 'codexsol' || compact === 'codexsol61') {
    return codexBedrock(SOL61_MODEL, mantle);
  }
  if (compact === 'sol61' || compact === 'gpt61sol' || compact === 'openaigpt61sol') {
    return bedrockMantle(SOL61_MODEL, mantle);
  }
  if (compact === 'sol' || compact === 'gpt6sol' || compact === 'openaigpt6sol') {
    return bedrockMantle('openai.gpt-6-sol', mantle);
  }
  if (compact === 'astra' || compact === 'gpt6astra' || compact === 'openaigpt6astra') {
    return bedrockMantle('openai.gpt-6-astra', mantle);
  }
  if (compact === 'gpt55' || compact === 'gpt5dot5' || compact === 'openaigpt55' || compact === 'usopenaigpt55') {
    return bedrockMantle('openai.gpt-5.5', mantle);
  }
  if (lower.startsWith('openai.')) {
    return bedrockMantle(raw, mantle);
  }
  if (compact === 'opus' || compact === 'opus55' || compact === 'claudeopus55' || compact === 'globalanthropicclaudeopus55') {
    return bedrockConverse(OPUS_MODEL, converse);
  }
  if (compact === 'fable' || compact === 'fable51' || compact === 'claudefable51' || compact === 'globalanthropicclaudefable51') {
    return bedrockConverse(FABLE_MODEL, converse);
  }
  if (compact === 'sonnet' || compact === 'sonnet55' || compact === 'claudesonnet55' || compact === 'globalanthropicclaudesonnet55') {
    return bedrockConverse(SONNET_MODEL, converse);
  }
  if (isAnthropicModelId(lower)) {
    return bedrockConverse(raw, converse);
  }
  if (lower === 'us.openai-gpt-5-5' || lower === 'us.openai.gpt-5.5') {
    return bedrockMantle('openai.gpt-5.5', mantle);
  }

  if (compact === 'grok' || compact === 'grok47' || compact === 'grok46' || compact === 'grokcode' || compact === 'grok4dot7') {
    return {
      name: 'grok-code',
      baseURL: 'https://cli-chat-proxy.grok.com/v1',
      model: 'grok-4.7',
      api: 'responses',
      reasoningEffort: 'xhigh',
      auth: 'grok',
    };
  }

  throw new Error(`unknown model alias "${alias}". Use sol61, sol, astra, gpt55, codex, opus, fable, sonnet, grok, an openai.* model id, or an anthropic Bedrock model id; append @region to change region.`);
}

export function modelOverrideUsage(): string {
  return `Model override flags:
  --model <role=alias[,fallback...]>  role is review|reviewSmall|reviewMedium|curator|distill
  --review-model <alias[,fallback...]>  override review model chain (also disables the small and medium tiers unless they are given too)
  --review-small-model <alias[,fallback...]>  override the small / docs-only PR reviewer (models.reviewSmall)
  --review-medium-model <alias[,fallback...]>  override the medium-tier PR reviewer (models.reviewMedium)
  --curator-model <alias[,fallback...]> override curator model chain
  --distill-model <alias[,fallback...]> override distill model chain
  --bedrock-region <region>           region for every Bedrock alias (default: us-east-1 for OpenAI models, us-east-2 for Claude)

Aliases: sol61, sol, astra, gpt55, codex (Sol 6.1 through the Codex CLI), opus, fable, sonnet, grok.
Append @region for one entry, e.g.
  revuto review owner/repo 123 --review-model sol,opus
  revuto daemon --model review=sol@us-east-2,opus --model curator=opus,sonnet
`;
}

function parseModelOverride(value: string, source: string): ModelOverride {
  const match = value.match(/^([^=:]+)[=:](.+)$/);
  if (!match) throw new Error(`${source} expects <review|reviewSmall|reviewMedium|curator|distill>=<alias[,fallback...]>`);
  const role = normalizeRole(match[1]);
  const chain = match[2].trim();
  if (!chain) throw new Error(`${source} ${role}=... requires at least one model alias`);
  return { role, chain, source };
}

function modelChain(chain: string, defaultRegion: string | undefined): ModelSpec {
  const specs = chain.split(',').map((part) => part.trim()).filter(Boolean).map((part) => modelPreset(part, defaultRegion));
  if (specs.length === 0) throw new Error(`model chain "${chain}" is empty`);
  const [primary, ...fallbacks] = specs;
  return fallbacks.length ? { ...primary, fallbacks } : primary;
}

function bedrockMantle(model: string, region: string): ModelSpec {
  return {
    name: 'bedrock-mantle',
    baseURL: `https://bedrock-mantle.${region}.api.aws/openai/v1`,
    model,
    api: 'responses',
    reasoningEffort: 'medium',
    auth: 'auto',
    apiKeyEnv: BEDROCK_API_KEY_ENV,
    awsRegion: region,
  };
}

/** Native Codex CLI review runner on Bedrock; the CLI is $REVUTO_CODEX_COMMAND or `codex` on PATH. */
function codexBedrock(model: string, region: string): ModelSpec {
  return {
    name: 'codex-bedrock',
    baseURL: 'codex://bedrock',
    model,
    api: 'codex',
    reasoningEffort: 'high',
    auth: 'aws',
    awsRegion: region,
  };
}

function bedrockConverse(model: string, region: string): ModelSpec {
  return {
    name: 'bedrock-converse',
    baseURL: `https://bedrock-runtime.${region}.amazonaws.com`,
    model,
    api: 'converse',
    reasoningEffort: 'medium',
    auth: 'auto',
    apiKeyEnv: BEDROCK_API_KEY_ENV,
    awsRegion: region,
  };
}

function isAnthropicModelId(value: string): boolean {
  return value.startsWith('anthropic.') || value.startsWith('us.anthropic.') || value.startsWith('eu.anthropic.') || value.startsWith('apac.anthropic.') || value.startsWith('global.anthropic.');
}

function normalizeRole(value: string): ModelRole {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const role = lower === 'reviewsmall' ? 'reviewSmall' : lower === 'reviewmedium' ? 'reviewMedium' : lower;
  if (ROLES.has(role as ModelRole)) return role as ModelRole;
  throw new Error(`unknown model role "${value}". Expected review, reviewSmall, reviewMedium, curator, or distill.`);
}

function roleFlagFor(arg: string): { flag: string; role: ModelRole } | undefined {
  const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
  const role = ROLE_FLAGS[flag];
  return role ? { flag, role } : undefined;
}

function valueForRoleFlag(argv: readonly string[], index: number, arg: string): string {
  const eq = arg.indexOf('=');
  if (eq >= 0) return requireValue(arg.slice(eq + 1), arg.slice(0, eq));
  return requireNext(argv, index + 1, arg);
}

function requireNext(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function requireValue(value: string, flag: string): string {
  if (!value.trim()) throw new Error(`${flag} requires a value`);
  return value;
}

function splitRegion(alias: string, defaultRegion: string | undefined): { value: string; region: string | undefined } {
  const trimmed = alias.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return { value: trimmed, region: defaultRegion };
  const maybeRegion = trimmed.slice(at + 1);
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(maybeRegion)) return { value: trimmed, region: defaultRegion };
  return { value: trimmed.slice(0, at), region: maybeRegion };
}
