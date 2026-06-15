/**
 * Bedrock Converse adapter.
 *
 * The mantle gateway (`/openai/v1`, our "responses" api) serves only OpenAI
 * model ids — every Anthropic id 404s there. Claude models (opus-4-8, sonnet)
 * are reachable only via the native Bedrock Runtime Converse API
 * (`https://bedrock-runtime.<region>.amazonaws.com/model/<id>/converse`), whose
 * wire format is content blocks (text / toolUse / toolResult), distinct from
 * both the Responses items and chat messages. This is a third `LanguageModelV3`
 * adapter alongside chat-completions and Responses, mirroring the structure of
 * `responses-model.ts` (same auth: Bearer token first, AWS SigV4 fallback).
 *
 * Reasoning effort for adaptive-thinking models (opus-4-8+) is sent via
 * `additionalModelRequestFields.thinking = { type: "adaptive" }` plus
 * `output_config.effort`, which accepts up to "max".
 */
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Hash } from '@smithy/hash-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { LanguageModel } from 'ai';

import type { ModelSpec } from './config.js';

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

type ConverseModelOptions = {
  readonly spec: ModelSpec;
};

type ModelMessage = {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: unknown;
};

type ModelCallOptions = {
  readonly prompt: readonly ModelMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: string[];
  readonly tools?: readonly JsonObject[];
  readonly toolChoice?: { readonly type: 'auto' | 'none' | 'required' } | { readonly type: 'tool'; readonly toolName: string };
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string | undefined>;
  readonly providerOptions?: Record<string, JsonObject>;
};

// Effort levels that mean "no extended thinking". Anything else is sent as the
// adaptive effort string (low/medium/high/xhigh/max).
const NO_THINKING_EFFORTS = new Set(['none', 'off', 'minimal']);

// Default output cap. The Converse maxTokens budget includes reasoning tokens,
// so max-effort thinking needs ample room; mirror eigen's 16k base.
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

const BEDROCK_SERVICE = 'bedrock';

// Bedrock intermittently returns a transient 500 ("unexpected error during
// processing") or a 503/429 throttle on an otherwise-healthy request — a single
// blip would otherwise fail a whole review run. Retry transient statuses (and
// network errors) with capped exponential backoff. 4xx other than 429 are not
// retried (the request itself is wrong).
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

async function sleepBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
  // 0.5s, 1s, 2s (+ up to 250ms jitter), capped.
  const base = Math.min(500 * 2 ** attempt, 4000);
  const delay = base + Math.floor(Math.random() * 250);
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type ConverseUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadInputTokens?: number;
};

type ConverseContentBlock = {
  readonly text?: string;
  readonly toolUse?: { readonly toolUseId?: string; readonly name?: string; readonly input?: unknown };
  readonly reasoningContent?: { readonly reasoningText?: { readonly text?: string } };
};

type ConversePayload = {
  readonly output?: { readonly message?: { readonly content?: readonly ConverseContentBlock[] } };
  readonly stopReason?: string;
  readonly usage?: ConverseUsage;
  readonly message?: string; // error message on failure
};

export function buildConverseModel(spec: ModelSpec): LanguageModel {
  return new ConverseLanguageModel({ spec }) as unknown as LanguageModel;
}

class ConverseLanguageModel {
  readonly specificationVersion = 'v3';
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly spec: ModelSpec;

  constructor({ spec }: ConverseModelOptions) {
    this.spec = spec;
    this.modelId = spec.model;
  }

  get provider(): string {
    return this.spec.name ?? new URL(this.spec.baseURL).host;
  }

  async doGenerate(options: ModelCallOptions): Promise<JsonObject> {
    const body = this.buildRequestBody(options);
    const bodyText = JSON.stringify(body);
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await this.fetchConverse(bodyText, options);
      } catch (err) {
        // Network/transport error (DNS, connection reset, fetch failed) —
        // transient, retry unless the caller aborted.
        if (options.abortSignal?.aborted) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          await sleepBackoff(attempt, options.abortSignal);
          continue;
        }
        throw new Error(`converse request failed after ${MAX_RETRIES + 1} attempts: ${lastErr.message}`);
      }
      const text = await response.text();
      const json = parseJson(text, response.url);
      if (response.ok) {
        return this.toGenerateResult(json, body, Object.fromEntries(response.headers.entries()));
      }
      const message = errorMessage(json) ?? `${response.status} ${response.statusText}`;
      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        lastErr = new Error(`converse API call failed (${response.status}): ${message}`);
        await sleepBackoff(attempt, options.abortSignal);
        continue;
      }
      throw new Error(`converse API call failed (${response.status}): ${message}`);
    }
    // Unreachable, but keep the type checker happy.
    throw lastErr ?? new Error('converse request failed');
  }

  async doStream(): Promise<never> {
    throw new Error('Converse streaming is not implemented for Revuto; use generateText.');
  }

  private buildRequestBody(options: ModelCallOptions): JsonObject {
    const providerOptions = {
      ...(options.providerOptions?.openai ?? {}),
      ...(options.providerOptions?.[this.provider] ?? {}),
    };
    const { system, messages } = promptToConverse(options.prompt);
    const maxTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const body: JsonObject = {
      messages,
      inferenceConfig: pruneUndefined({
        maxTokens,
        temperature: options.temperature,
        topP: options.topP,
        stopSequences: options.stopSequences?.length ? options.stopSequences : undefined,
      }),
    };
    if (system.length > 0) body.system = system.map((text) => ({ text }));
    if (options.tools?.length) {
      const toolConfig: JsonObject = { tools: options.tools.map(toConverseTool) };
      const toolChoice = toConverseToolChoice(options.toolChoice);
      if (toolChoice) toolConfig.toolChoice = toolChoice;
      body.toolConfig = toolConfig;
    }
    const extra = this.additionalFields(providerOptions);
    if (extra) body.additionalModelRequestFields = extra;
    return body;
  }

  // Build additionalModelRequestFields carrying the adaptive extended-thinking
  // config. opus-4-8+ uses thinking.type=adaptive + output_config.effort
  // (accepts low/medium/high/xhigh/max). Returns undefined when no thinking.
  private additionalFields(providerOptions: JsonObject): JsonObject | undefined {
    const effort = this.spec.reasoningEffort ?? stringOption(providerOptions.reasoningEffort);
    if (!effort || NO_THINKING_EFFORTS.has(effort)) return undefined;
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort },
    };
  }

  private async fetchConverse(bodyText: string, options: ModelCallOptions): Promise<Response> {
    const base = this.spec.baseURL.replace(/\/+$/, '');
    const url = new URL(`${base}/model/${encodeModelId(this.spec.model)}/converse`);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      host: url.host,
      ...definedHeaders(options.headers),
    };
    const apiKey = resolveApiKey(this.spec);
    const auth = this.spec.auth ?? 'auto';
    if ((auth === 'auto' || auth === 'bearer') && apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
      return fetch(url, { method: 'POST', headers, body: bodyText, signal: options.abortSignal });
    }
    if (auth === 'bearer') {
      throw new Error(`models.${this.provider}: ${this.spec.apiKeyEnv ?? 'apiKeyEnv'} is required for bearer auth`);
    }
    // Converse is always a Bedrock endpoint, so auto (no key) and aws both sign.
    if (auth === 'auto' || auth === 'aws') {
      return fetch(url, {
        method: 'POST',
        headers: await signHeaders(url, headers, bodyText, this.awsRegion(url)),
        body: bodyText,
        signal: options.abortSignal,
      });
    }
    return fetch(url, { method: 'POST', headers, body: bodyText, signal: options.abortSignal });
  }

  private awsRegion(url: URL): string {
    if (this.spec.awsRegion) return this.spec.awsRegion;
    const match = url.hostname.match(/^bedrock-runtime\.([^.]+)\./) ?? url.hostname.match(/^bedrock-mantle\.([^.]+)\./);
    if (match?.[1]) return match[1];
    throw new Error(`models.${this.provider}: awsRegion is required for AWS auth`);
  }

  private toGenerateResult(payload: unknown, requestBody: JsonObject, headers: Record<string, string>): JsonObject {
    const response = payload as ConversePayload;
    const content = responseContent(response);
    return {
      content,
      finishReason: finishReason(response, content),
      usage: usageFrom(response.usage),
      providerMetadata: { [this.provider]: { stopReason: response.stopReason } },
      request: { body: requestBody },
      response: {
        modelId: this.spec.model,
        headers,
        body: payload,
      },
      warnings: [],
    };
  }
}

/**
 * Map the AI SDK prompt to Converse system + messages. Converse needs system as
 * a separate field, strict user/assistant alternation, and tool results
 * delivered as a user message of toolResult blocks — consecutive tool messages
 * are grouped into one user turn.
 */
function promptToConverse(prompt: readonly ModelMessage[]): { system: string[]; messages: JsonObject[] } {
  const system: string[] = [];
  const messages: JsonObject[] = [];
  let pendingResults: JsonObject[] = [];

  const flush = (): void => {
    if (pendingResults.length > 0) {
      messages.push({ role: 'user', content: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of prompt) {
    if (message.role === 'system') {
      system.push(String(message.content));
      continue;
    }
    const parts = Array.isArray(message.content)
      ? (message.content as JsonObject[])
      : [{ type: 'text', text: String(message.content) }];

    if (message.role === 'tool') {
      for (const part of parts) {
        if (part.type !== 'tool-result') continue;
        const value = (part.output as JsonObject | undefined)?.value ?? part.output;
        pendingResults.push({
          toolResult: {
            toolUseId: String(part.toolCallId),
            content: [{ text: stringifyToolOutput(value) }],
            status: part.isError ? 'error' : 'success',
          },
        });
      }
      continue;
    }

    flush();

    if (message.role === 'assistant') {
      const content: JsonObject[] = [];
      const text = textFromParts(parts);
      if (text) content.push({ text });
      for (const part of parts) {
        if (part.type === 'tool-call') {
          content.push({
            toolUse: {
              toolUseId: String(part.toolCallId),
              name: String(part.toolName),
              input: parseToolInput(part.input),
            },
          });
        }
      }
      // Converse rejects a message with an empty content array — drop a
      // reasoning-only / empty assistant turn (it carries no needed state).
      if (content.length === 0) continue;
      messages.push({ role: 'assistant', content });
      continue;
    }

    // user (or any other) role
    const content: JsonObject[] = [];
    const text = textFromParts(parts);
    if (text) content.push({ text });
    if (content.length === 0) content.push({ text: '' });
    messages.push({ role: 'user', content });
  }

  flush();
  return { system, messages };
}

function textFromParts(parts: readonly JsonObject[]): string {
  return parts
    .filter((part) => part.type === 'text' || part.type === 'reasoning')
    .map((part) => String(part.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

function parseToolInput(input: unknown): JsonValue {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input) as JsonValue;
    } catch {
      return {};
    }
  }
  return toJsonValue(input ?? {});
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(toJsonValue(output));
}

function toConverseTool(tool: JsonObject): JsonObject {
  // The AI SDK passes function tools as { type, name, description, inputSchema }.
  const schema = tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} };
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: schema },
    },
  };
}

function toConverseToolChoice(choice: ModelCallOptions['toolChoice']): JsonObject | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return { auto: {} };
    case 'required':
      return { any: {} };
    case 'tool':
      return { tool: { name: choice.toolName } };
    case 'none':
    default:
      return undefined;
  }
}

function responseContent(response: ConversePayload): JsonObject[] {
  const content: JsonObject[] = [];
  for (const block of response.output?.message?.content ?? []) {
    if (block.toolUse) {
      content.push({
        type: 'tool-call',
        toolCallId: String(block.toolUse.toolUseId ?? ''),
        toolName: String(block.toolUse.name ?? ''),
        input: typeof block.toolUse.input === 'string' ? block.toolUse.input : JSON.stringify(block.toolUse.input ?? {}),
      });
      continue;
    }
    if (typeof block.text === 'string' && block.text) {
      content.push({ type: 'text', text: block.text });
      continue;
    }
    const reasoning = block.reasoningContent?.reasoningText?.text;
    if (typeof reasoning === 'string' && reasoning) {
      content.push({ type: 'reasoning', text: reasoning });
    }
  }
  return content;
}

function finishReason(response: ConversePayload, content: readonly JsonObject[]): JsonObject {
  if (content.some((part) => part.type === 'tool-call')) return { unified: 'tool-calls', raw: response.stopReason };
  if (response.stopReason === 'max_tokens') return { unified: 'length', raw: response.stopReason };
  return { unified: 'stop', raw: response.stopReason };
}

function usageFrom(usage?: ConverseUsage): JsonObject {
  const cached = usage?.cacheReadInputTokens;
  return {
    inputTokens: {
      total: usage?.inputTokens,
      noCache: usage?.inputTokens === undefined || cached === undefined ? undefined : usage.inputTokens - cached,
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.outputTokens,
      text: usage?.outputTokens,
      reasoning: undefined,
    },
    raw: toJsonValue(usage ?? {}),
  };
}

function resolveApiKey(spec: ModelSpec): string {
  if (!spec.apiKeyEnv) return '';
  return process.env[spec.apiKeyEnv] ?? '';
}

async function signHeaders(url: URL, headers: Record<string, string>, body: string, region: string): Promise<Record<string, string>> {
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: BEDROCK_SERVICE,
    sha256: Hash.bind(null, 'sha256'),
  });
  const signed = await signer.sign(new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    method: 'POST',
    path: url.pathname,
    query: queryFrom(url),
    headers,
    body,
  }));
  return Object.fromEntries(Object.entries(signed.headers).map(([key, value]) => [key, String(value)]));
}

function queryFrom(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const current = query[key];
    if (current === undefined) query[key] = value;
    else query[key] = Array.isArray(current) ? [...current, value] : [current, value];
  }
  return query;
}

// Escape a Bedrock model id for use as a URL path segment. encodeURIComponent
// leaves the id readable but encodes any ':' in a versioned profile id
// (e.g. "...-v1:0") to %3A, which Bedrock's SigV4 path canonicalization needs.
function encodeModelId(id: string): string {
  return encodeURIComponent(id);
}

function definedHeaders(headers?: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function pruneUndefined(obj: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function parseJson(text: string, url: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`converse API returned invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function errorMessage(payload: unknown): string | undefined {
  const p = payload as { message?: string; error?: { message?: string } };
  return p.error?.message ?? p.message;
}

function stringOption(value: unknown): ModelSpec['reasoningEffort'] | undefined {
  return typeof value === 'string' ? (value as ModelSpec['reasoningEffort']) : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, toJsonValue(v)]));
  }
  return String(value);
}
