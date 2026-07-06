import type { ModelSpec, ReviewerConfig } from '../../agents/common/src/config.js';

export type ModelRole = 'review' | 'curator' | 'distill';

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
const BEDROCK_API_KEY_ENV = 'AWS_BEARER_TOKEN_BEDROCK';
const OPUS_MODEL = 'us.anthropic.claude-opus-4-8';
const SONNET_MODEL = 'global.anthropic.claude-sonnet-5';
const ROLE_FLAGS: Record<string, ModelRole> = {
  '--review-model': 'review',
  '--curator-model': 'curator',
  '--distill-model': 'distill',
};
const ROLES = new Set<ModelRole>(['review', 'curator', 'distill']);

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
  const defaultRegion = parsed.bedrockRegion ?? process.env.REVUTO_BEDROCK_REGION ?? DEFAULT_BEDROCK_REGION;
  const models = { ...config.models };
  for (const override of parsed.overrides) {
    models[override.role] = modelChain(override.chain, defaultRegion);
  }
  return { ...config, models };
}

export function modelPreset(alias: string, defaultRegion = DEFAULT_BEDROCK_REGION): ModelSpec {
  const { value, region } = splitRegion(alias, defaultRegion);
  const raw = value.trim();
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[\s._-]/g, '');

  if (compact === 'gpt55' || compact === 'gpt5dot5' || compact === 'openaigpt55' || compact === 'usopenaigpt55') {
    return bedrockMantle('openai.gpt-5.5', region);
  }
  if (compact === 'gpt54' || compact === 'gpt5dot4' || compact === 'openaigpt54' || compact === 'usopenaigpt54') {
    return bedrockMantle('openai.gpt-5.4', region);
  }
  if (lower.startsWith('openai.')) {
    return bedrockMantle(raw, region);
  }
  if (compact === 'opus' || compact === 'opus48' || compact === 'claudeopus48' || compact === 'anthropicclaudeopus48' || compact === 'usanthropicclaudeopus48') {
    return bedrockConverse(OPUS_MODEL, region);
  }
  if (compact === 'sonnet' || compact === 'sonnet5' || compact === 'claudesonnet5' || compact === 'anthropicclaudesonnet5' || compact === 'globalanthropicclaudesonnet5') {
    return bedrockConverse(SONNET_MODEL, region);
  }
  if (isAnthropicModelId(lower)) {
    return bedrockConverse(raw, region);
  }
  if (lower === 'us.openai-gpt-5-5' || lower === 'us.openai.gpt-5.5') {
    return bedrockMantle('openai.gpt-5.5', region);
  }

  throw new Error(`unknown model alias "${alias}". Use gpt55, gpt54, opus, sonnet, an openai.* model id, or an anthropic Bedrock model id; append @region to change region.`);
}

export function modelOverrideUsage(): string {
  return `Model override flags:
  --model <role=alias[,fallback...]>  role is review|curator|distill
  --review-model <alias[,fallback...]>  override review model chain
  --curator-model <alias[,fallback...]> override curator model chain
  --distill-model <alias[,fallback...]> override distill model chain
  --bedrock-region <region>           default region for aliases (default: us-east-2)

Aliases: gpt55, gpt54, opus, sonnet. Append @region for one entry, e.g.
  revuto review owner/repo 123 --review-model gpt55,opus
  revuto daemon --model review=gpt55@us-east-2,opus --model curator=opus,sonnet
`;
}

function parseModelOverride(value: string, source: string): ModelOverride {
  const match = value.match(/^([^=:]+)[=:](.+)$/);
  if (!match) throw new Error(`${source} expects <review|curator|distill>=<alias[,fallback...]>`);
  const role = normalizeRole(match[1]);
  const chain = match[2].trim();
  if (!chain) throw new Error(`${source} ${role}=... requires at least one model alias`);
  return { role, chain, source };
}

function modelChain(chain: string, defaultRegion: string): ModelSpec {
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
    reasoningEffort: 'xhigh',
    auth: 'auto',
    apiKeyEnv: BEDROCK_API_KEY_ENV,
    awsRegion: region,
  };
}

function bedrockConverse(model: string, region: string): ModelSpec {
  return {
    name: 'bedrock-converse',
    baseURL: `https://bedrock-runtime.${region}.amazonaws.com`,
    model,
    api: 'converse',
    reasoningEffort: 'max',
    auth: 'auto',
    apiKeyEnv: BEDROCK_API_KEY_ENV,
    awsRegion: region,
  };
}

function isAnthropicModelId(value: string): boolean {
  return value.startsWith('anthropic.') || value.startsWith('us.anthropic.') || value.startsWith('eu.anthropic.') || value.startsWith('apac.anthropic.') || value.startsWith('global.anthropic.');
}

function normalizeRole(value: string): ModelRole {
  const role = value.trim().toLowerCase();
  if (ROLES.has(role as ModelRole)) return role as ModelRole;
  throw new Error(`unknown model role "${value}". Expected review, curator, or distill.`);
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

function splitRegion(alias: string, defaultRegion: string): { value: string; region: string } {
  const trimmed = alias.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return { value: trimmed, region: defaultRegion };
  const maybeRegion = trimmed.slice(at + 1);
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(maybeRegion)) return { value: trimmed, region: defaultRegion };
  return { value: trimmed.slice(0, at), region: maybeRegion };
}
