/**
 * Bedrock Converse adapter.
 *
 * The mantle gateway (`/openai/v1`, our "responses" api) serves only OpenAI
 * model ids — every Anthropic id 404s there. Claude models (opus-4-8, sonnet)
 * are reachable only via the native Bedrock Runtime Converse API
 * (`https://bedrock-runtime.<region>.amazonaws.com/model/<id>/converse`), whose
 * wire format is content blocks (text / toolUse / toolResult), distinct from
 * both the Responses items and chat messages. This is a third `LanguageModelV4`
 * adapter alongside chat-completions and Responses, mirroring the structure of
 * `responses-model.ts` (same auth: Bearer token first, AWS SigV4 fallback).
 *
 * Reasoning effort for adaptive-thinking models (opus-4-8+) is sent via
 * `additionalModelRequestFields.thinking = { type: "adaptive" }` plus
 * `output_config.effort`, which accepts up to "max".
 *
 * Claude Opus 5.5 and Fable 5.1 set the rules for Anthropic ids here:
 * - thinking is always on, so it is never dropped and effort defaults to medium;
 * - forced tool choice (`any` / `tool`) is a 400, so a `required` or named tool
 *   choice goes out as `auto`, the tools are named in a reminder, and the call
 *   is retried once if no tool call came back;
 * - temperature / topP are a 400 and are not sent;
 * - reasoning blocks come back with a signature and must be replayed verbatim,
 *   in their original position, never folded into text;
 * - a classifier refusal (`stopReason` refusal / content_filtered) throws
 *   `ModelRefusalError`, which FallbackLanguageModel hands to the next model.
 *
 * Requests go to ConverseStream and are aggregated into one result: a
 * 128K-token turn can outlast a plain HTTP response timeout, a stream does not.
 */
import * as zlib from 'node:zlib';

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Hash } from '@smithy/hash-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { LanguageModel } from 'ai';

import { isAnthropicModelId, type ModelSpec } from './config.js';

export { isAnthropicModelId };
import { ModelRefusalError } from './refusal.js';

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
// adaptive effort string (low/medium/high/xhigh/max). Claude models on Converse
// cannot turn thinking off, so these map to `low` there.
const NO_THINKING_EFFORTS = new Set(['none', 'off', 'minimal']);

// Effort sent to a Claude model when the spec names none. Opus 5.5 defaults to
// medium server-side too; sending it keeps the request explicit.
const DEFAULT_ANTHROPIC_EFFORT = 'medium';

// Default output cap. The Converse maxTokens budget includes reasoning tokens,
// so it needs room for thinking plus the reply. 128K is the Claude Opus 5.5 /
// Fable 5.1 / Sonnet 5 ceiling.
export const DEFAULT_MAX_OUTPUT_TOKENS = 128000;

// Provider-metadata key carrying a reasoning block's signature / redacted
// payload from a response to the replay of that turn.
export const CONVERSE_METADATA_KEY = 'bedrockConverse';

const BEDROCK_SERVICE = 'bedrock';

// Bedrock intermittently returns a transient 500 ("unexpected error during
// processing") or a 503/429 throttle on an otherwise-healthy request — a single
// blip would otherwise fail a whole review run. Retry transient statuses (and
// network errors) with capped exponential backoff. 4xx other than 429 are not
// retried (the request itself is wrong).
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Stream exception types that are transient, the in-stream twin of RETRYABLE_STATUS.
const RETRYABLE_STREAM_EXCEPTIONS = new Set([
  'throttlingException',
  'serviceUnavailableException',
  'internalServerException',
  'modelStreamErrorException',
]);
// Stop reasons that mean a safety classifier declined the request.
const REFUSAL_STOP_REASONS = new Set(['refusal', 'content_filtered']);


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

type ConverseReasoning = {
  readonly reasoningText?: { readonly text?: string; readonly signature?: string };
  readonly redactedContent?: string;
};

type ConverseContentBlock = {
  readonly text?: string;
  readonly toolUse?: { readonly toolUseId?: string; readonly name?: string; readonly input?: unknown };
  readonly reasoningContent?: ConverseReasoning;
};

type ConversePayload = {
  readonly output?: { readonly message?: { readonly content?: readonly ConverseContentBlock[] } };
  readonly stopReason?: string;
  readonly usage?: ConverseUsage;
  readonly additionalModelResponseFields?: { readonly stop_details?: { readonly category?: string } } & JsonObject;
  readonly message?: string; // error message on failure
};

class ConverseStreamError extends Error {
  constructor(readonly exceptionType: string, message: string) {
    super(`converse stream ${exceptionType}: ${message}`);
  }
}

export function buildConverseModel(spec: ModelSpec): LanguageModel {
  return new ConverseLanguageModel({ spec }) as unknown as LanguageModel;
}

class ConverseLanguageModel {
  readonly specificationVersion = 'v4';
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
    const anthropic = isAnthropicModelId(this.spec.model);
    // Claude Opus 5.5 / Fable 5.1 reject forced tool use. Send auto, name the
    // tools, and retry once below if the model answered without a call.
    const steered = anthropic && forcesToolUse(options.toolChoice) && !!options.tools?.length;
    const body = this.buildRequestBody(options, anthropic);
    const first = await this.send(body, options);
    if (steered && !hasToolCall(first.payload) && !isRefusal(first.payload)) {
      const retryBody = withToolReminder(body, first.payload, toolReminder(options));
      const retry = await this.send(retryBody, options);
      const payload = { ...retry.payload, usage: sumUsage(first.payload.usage, retry.payload.usage) };
      return this.toGenerateResult(payload, retryBody, retry.headers);
    }
    return this.toGenerateResult(first.payload, body, first.headers);
  }

  /** One ConverseStream call with transient-error retries, aggregated into a Converse payload. */
  private async send(body: JsonObject, options: ModelCallOptions): Promise<{ payload: ConversePayload; headers: Record<string, string> }> {
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
      const headers = Object.fromEntries(response.headers.entries());
      if (response.ok) {
        try {
          return { payload: await readConverseStream(response), headers };
        } catch (err) {
          if (options.abortSignal?.aborted) throw err;
          const retryable = err instanceof ConverseStreamError
            ? RETRYABLE_STREAM_EXCEPTIONS.has(err.exceptionType)
            : !(err instanceof ModelRefusalError);
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (retryable && attempt < MAX_RETRIES) {
            await sleepBackoff(attempt, options.abortSignal);
            continue;
          }
          throw lastErr;
        }
      }
      const text = await response.text();
      const json = parseJson(text, response.url);
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

  private buildRequestBody(options: ModelCallOptions, anthropic: boolean): JsonObject {
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
        // Claude Opus 5.5 / Fable 5.1 400 on any sampling parameter.
        temperature: anthropic ? undefined : options.temperature,
        topP: anthropic ? undefined : options.topP,
        stopSequences: options.stopSequences?.length ? options.stopSequences : undefined,
      }),
    };
    if (system.length > 0) body.system = system.map((text) => ({ text }));
    // Claude never gets a forcing tool choice (see doGenerate), so it is always
    // free to think. Other Converse models keep the forced choice.
    const choice = anthropic && forcesToolUse(options.toolChoice) ? ({ type: 'auto' } as const) : options.toolChoice;
    if (options.tools?.length) {
      const toolConfig: JsonObject = { tools: options.tools.map(toConverseTool) };
      const toolChoice = toConverseToolChoice(choice);
      if (toolChoice) toolConfig.toolChoice = toolChoice;
      body.toolConfig = toolConfig;
    }
    const extra = this.additionalFields(providerOptions, anthropic, forcesToolUse(choice));
    if (extra) body.additionalModelRequestFields = extra;
    return body;
  }

  // Build additionalModelRequestFields carrying the adaptive extended-thinking
  // config: thinking.type=adaptive + output_config.effort (low/medium/high/xhigh/max).
  // Claude always gets it: thinking cannot be disabled on Opus 5.5 / Fable 5.1,
  // so a "no thinking" effort becomes low and a missing one becomes medium.
  // Other models get it only when an effort is set and tool use is not forced
  // (Bedrock 400s on thinking plus a forcing tool_choice).
  private additionalFields(providerOptions: JsonObject, anthropic: boolean, forced: boolean): JsonObject | undefined {
    const requested = this.spec.reasoningEffort ?? stringOption(providerOptions.reasoningEffort);
    if (anthropic) {
      const effort = !requested ? DEFAULT_ANTHROPIC_EFFORT : NO_THINKING_EFFORTS.has(requested) ? 'low' : requested;
      return { thinking: { type: 'adaptive' }, output_config: { effort } };
    }
    if (forced || !requested || NO_THINKING_EFFORTS.has(requested)) return undefined;
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort: requested },
    };
  }

  private async fetchConverse(bodyText: string, options: ModelCallOptions): Promise<Response> {
    const base = this.spec.baseURL.replace(/\/+$/, '');
    const url = new URL(`${base}/model/${encodeModelId(this.spec.model)}/converse-stream`);
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
    // Branch on a refusal before reading content: the content is partial or empty.
    if (isRefusal(response)) {
      throw new ModelRefusalError(this.spec.model, response.additionalModelResponseFields?.stop_details?.category, `stopReason=${response.stopReason}`);
    }
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
      // Keep every block in its original order. Reasoning goes back as the
      // signed reasoningContent block it arrived as (Claude requires thinking
      // blocks replayed unmodified in tool loops); it is never merged into text.
      const content: JsonObject[] = [];
      for (const part of parts) {
        if (part.type === 'reasoning') {
          const block = reasoningBlockFromPart(part);
          if (block) content.push(block);
        } else if (part.type === 'text') {
          const text = String(part.text ?? '');
          if (text) content.push({ text });
        } else if (part.type === 'tool-call') {
          content.push({
            toolUse: {
              toolUseId: String(part.toolCallId),
              name: String(part.toolName),
              input: parseToolInput(part.input),
            },
          });
        }
      }
      // Converse rejects a message with an empty content array, and an
      // assistant turn of reasoning alone carries no reply to replay.
      if (!content.some((block) => block.text !== undefined || block.toolUse !== undefined)) continue;
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
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Rebuild a Converse reasoningContent block from an AI SDK reasoning part.
 * Only a block this adapter produced (it carries a signature or a redacted
 * payload) can go back; unsigned reasoning from another provider is dropped,
 * since Claude rejects a thinking block without its signature.
 */
function reasoningBlockFromPart(part: JsonObject): JsonObject | undefined {
  const meta = (part.providerOptions as Record<string, JsonObject> | undefined)?.[CONVERSE_METADATA_KEY];
  if (!meta) return undefined;
  if (typeof meta.redactedContent === 'string') return { reasoningContent: { redactedContent: meta.redactedContent } };
  if (typeof meta.signature === 'string') {
    return { reasoningContent: { reasoningText: { text: String(part.text ?? ''), signature: meta.signature } } };
  }
  return undefined;
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

// True when the tool choice COMPELS a tool call (`required`/`any` or a named
// `tool`). Claude Opus 5.5 / Fable 5.1 reject these outright, and older Claude
// models reject them with thinking on, so Claude ids are steered with auto.
function forcesToolUse(choice: ModelCallOptions['toolChoice']): boolean {
  return choice?.type === 'required' || choice?.type === 'tool';
}

function isRefusal(payload: ConversePayload): boolean {
  return !!payload.stopReason && REFUSAL_STOP_REASONS.has(payload.stopReason);
}

function hasToolCall(payload: ConversePayload): boolean {
  return (payload.output?.message?.content ?? []).some((block) => !!block.toolUse);
}

/** The reminder sent when a steered (formerly forced) call came back without a tool call. */
function toolReminder(options: ModelCallOptions): string {
  const choice = options.toolChoice;
  if (choice?.type === 'tool') return `You must respond with a call to the \`${choice.toolName}\` tool now.`;
  const names = (options.tools ?? []).map((tool) => `\`${String(tool.name)}\``);
  return names.length === 1
    ? `You must respond with a call to the ${names[0]} tool now.`
    : `You must respond with a call to exactly one of these tools now: ${names.join(', ')}.`;
}

/**
 * The retry request: the original conversation, the model's answer as it came
 * back (reasoning blocks untouched), and a user turn naming the tool. Appending
 * keeps the earlier prefix byte-identical, which Claude's thinking binding needs.
 * An answer with no text or tool call is not replayed; the reminder then goes
 * after the original messages as a new user turn.
 */
function withToolReminder(body: JsonObject, payload: ConversePayload, reminder: string): JsonObject {
  const messages = [...(body.messages as JsonObject[])];
  const answer = payload.output?.message?.content ?? [];
  if (answer.some((block) => typeof block.text === 'string' && block.text)) {
    messages.push({ role: 'assistant', content: answer as unknown as JsonObject[] });
    messages.push({ role: 'user', content: [{ text: reminder }] });
  } else {
    const last = messages.at(-1);
    if (last?.role === 'user') {
      messages[messages.length - 1] = { ...last, content: [...(last.content as JsonObject[]), { text: reminder }] };
    } else {
      messages.push({ role: 'user', content: [{ text: reminder }] });
    }
  }
  return { ...body, messages };
}

function sumUsage(a?: ConverseUsage, b?: ConverseUsage): ConverseUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const add = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    cacheReadInputTokens: add(a.cacheReadInputTokens, b.cacheReadInputTokens),
  };
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
    const reasoning = block.reasoningContent;
    if (reasoning?.redactedContent !== undefined) {
      content.push({ type: 'reasoning', text: '', providerMetadata: { [CONVERSE_METADATA_KEY]: { redactedContent: reasoning.redactedContent } } });
      continue;
    }
    if (reasoning?.reasoningText) {
      const { text, signature } = reasoning.reasoningText;
      // Opus 5.5 omits the thinking text by default: the block is an empty
      // string plus a signature, and it still has to go back on the next turn.
      if (!text && !signature) continue;
      content.push({
        type: 'reasoning',
        text: text ?? '',
        ...(signature ? { providerMetadata: { [CONVERSE_METADATA_KEY]: { signature } } } : {}),
      });
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

// ---------------------------------------------------------------------------
// ConverseStream: AWS event-stream framing and aggregation.
//
// Each frame: total length (u32) | headers length (u32) | prelude CRC32 |
// headers | payload | message CRC32. The `:message-type` header is "event" or
// "exception"; `:event-type` / `:exception-type` name it, and the payload is
// JSON. Events: messageStart, contentBlockStart, contentBlockDelta,
// contentBlockStop, messageStop, metadata.
// ---------------------------------------------------------------------------

type StreamFrame = { readonly headers: Record<string, string>; readonly payload: Buffer };

const crc32: ((data: Uint8Array) => number) | undefined = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;

export function decodeEventStreamFrames(buffer: Buffer): { frames: StreamFrame[]; rest: Buffer } {
  const frames: StreamFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 12) {
    const total = buffer.readUInt32BE(offset);
    const headersLength = buffer.readUInt32BE(offset + 4);
    if (total < 16 || headersLength > total - 16) throw new Error(`converse stream: malformed frame (length ${total})`);
    if (buffer.length - offset < total) break;
    const frame = buffer.subarray(offset, offset + total);
    if (crc32) {
      if (crc32(frame.subarray(0, 8)) !== frame.readUInt32BE(8)) throw new Error('converse stream: prelude CRC mismatch');
      if (crc32(frame.subarray(0, total - 4)) !== frame.readUInt32BE(total - 4)) throw new Error('converse stream: message CRC mismatch');
    }
    frames.push({
      headers: decodeFrameHeaders(frame.subarray(12, 12 + headersLength)),
      payload: frame.subarray(12 + headersLength, total - 4),
    });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function decodeFrameHeaders(buf: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const nameLength = buf.readUInt8(i);
    const name = buf.subarray(i + 1, i + 1 + nameLength).toString('utf8');
    i += 1 + nameLength;
    const type = buf.readUInt8(i);
    i += 1;
    switch (type) {
      case 0: headers[name] = 'true'; break;
      case 1: headers[name] = 'false'; break;
      case 2: i += 1; break;
      case 3: i += 2; break;
      case 4: i += 4; break;
      case 5: case 8: i += 8; break;
      case 9: i += 16; break;
      case 6: case 7: {
        const length = buf.readUInt16BE(i);
        if (type === 7) headers[name] = buf.subarray(i + 2, i + 2 + length).toString('utf8');
        i += 2 + length;
        break;
      }
      default:
        throw new Error(`converse stream: unknown header type ${type}`);
    }
  }
  return headers;
}

type BlockState = {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input: string };
  reasoningText?: string;
  signature?: string;
  redactedContent?: string;
};

/** Folds stream events into the same payload shape the non-streaming Converse call returns. */
export class ConverseStreamAggregator {
  private readonly blocks = new Map<number, BlockState>();
  private stopReason?: string;
  private additional?: JsonObject;
  private usage?: ConverseUsage;

  handle(eventType: string, event: JsonObject): void {
    const index = typeof event.contentBlockIndex === 'number' ? event.contentBlockIndex : 0;
    if (eventType === 'contentBlockStart') {
      const start = event.start as { toolUse?: { toolUseId?: string; name?: string } } | undefined;
      if (start?.toolUse) this.block(index).toolUse = { toolUseId: start.toolUse.toolUseId, name: start.toolUse.name, input: '' };
      return;
    }
    if (eventType === 'contentBlockDelta') {
      const delta = (event.delta ?? {}) as {
        text?: string;
        toolUse?: { input?: string };
        reasoningContent?: { text?: string; signature?: string; redactedContent?: string };
      };
      const block = this.block(index);
      if (typeof delta.text === 'string') block.text = (block.text ?? '') + delta.text;
      if (delta.toolUse) {
        block.toolUse ??= { input: '' };
        block.toolUse.input += delta.toolUse.input ?? '';
      }
      const r = delta.reasoningContent;
      if (r) {
        if (typeof r.text === 'string') block.reasoningText = (block.reasoningText ?? '') + r.text;
        if (typeof r.signature === 'string') block.signature = (block.signature ?? '') + r.signature;
        if (typeof r.redactedContent === 'string') block.redactedContent = (block.redactedContent ?? '') + r.redactedContent;
      }
      return;
    }
    if (eventType === 'messageStop') {
      this.stopReason = typeof event.stopReason === 'string' ? event.stopReason : undefined;
      this.additional = event.additionalModelResponseFields as JsonObject | undefined;
      return;
    }
    if (eventType === 'metadata') {
      this.usage = event.usage as ConverseUsage | undefined;
    }
  }

  payload(): ConversePayload {
    const content: ConverseContentBlock[] = [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => {
        if (b.toolUse) return { toolUse: { toolUseId: b.toolUse.toolUseId, name: b.toolUse.name, input: parseStreamedInput(b.toolUse.input) } };
        if (b.redactedContent !== undefined) return { reasoningContent: { redactedContent: b.redactedContent } };
        if (b.reasoningText !== undefined || b.signature !== undefined) {
          return { reasoningContent: { reasoningText: { text: b.reasoningText ?? '', ...(b.signature !== undefined ? { signature: b.signature } : {}) } } };
        }
        return { text: b.text ?? '' };
      });
    return {
      output: { message: { content } },
      stopReason: this.stopReason,
      usage: this.usage,
      ...(this.additional ? { additionalModelResponseFields: this.additional } : {}),
    };
  }

  private block(index: number): BlockState {
    let block = this.blocks.get(index);
    if (!block) {
      block = {};
      this.blocks.set(index, block);
    }
    return block;
  }
}

function parseStreamedInput(input: string): unknown {
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

async function readConverseStream(response: Response): Promise<ConversePayload> {
  const aggregator = new ConverseStreamAggregator();
  if (!response.body) throw new Error('converse stream: empty response body');
  let pending: Buffer = Buffer.alloc(0);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = pending.length ? Buffer.concat([pending, Buffer.from(value)]) : Buffer.from(value);
    const { frames, rest } = decodeEventStreamFrames(pending);
    pending = rest;
    for (const frame of frames) {
      const body = frame.payload.length ? (JSON.parse(frame.payload.toString('utf8')) as JsonObject) : {};
      const messageType = frame.headers[':message-type'];
      if (messageType === 'exception' || messageType === 'error') {
        const type = frame.headers[':exception-type'] ?? frame.headers[':error-code'] ?? 'exception';
        throw new ConverseStreamError(type, String(body.message ?? frame.headers[':error-message'] ?? 'stream error'));
      }
      aggregator.handle(frame.headers[':event-type'] ?? '', body);
    }
  }
  if (pending.length) throw new Error('converse stream: truncated frame at end of stream');
  return aggregator.payload();
}
