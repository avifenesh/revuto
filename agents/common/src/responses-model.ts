import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Hash } from '@smithy/hash-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { LanguageModel } from 'ai';

import type { ModelSpec } from './config.js';

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

type ResponsesModelOptions = {
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
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
  readonly stopSequences?: string[];
  readonly tools?: readonly JsonObject[];
  readonly toolChoice?: { readonly type: 'auto' | 'none' | 'required' } | { readonly type: 'tool'; readonly toolName: string };
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string | undefined>;
  readonly providerOptions?: Record<string, JsonObject>;
};

type ResponseUsage = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
};

type ResponsesPayload = {
  readonly id?: string;
  readonly model?: string;
  readonly status?: string;
  readonly output?: readonly JsonObject[];
  readonly output_text?: string;
  readonly usage?: ResponseUsage;
  readonly incomplete_details?: { readonly reason?: string };
};

const BEDROCK_SERVICE = 'bedrock';
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function buildResponsesModel(spec: ModelSpec): LanguageModel {
  return new ResponsesLanguageModel({ spec }) as unknown as LanguageModel;
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

async function sleepBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
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

class ResponsesLanguageModel {
  readonly specificationVersion = 'v3';
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly spec: ModelSpec;

  constructor({ spec }: ResponsesModelOptions) {
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
        response = await this.fetchResponses(bodyText, options);
      } catch (err) {
        if (options.abortSignal?.aborted) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          await sleepBackoff(attempt, options.abortSignal);
          continue;
        }
        throw new Error(`responses request failed after ${MAX_RETRIES + 1} attempts: ${lastErr.message}`);
      }
      const text = await response.text();
      let json: unknown;
      try {
        json = parseJson(text, response.url);
      } catch (parseErr) {
        // A non-JSON body (e.g. an HTML gateway error page on 502/503/504) must not
        // bypass the retry logic. Rethrow only when the response was otherwise OK.
        if (response.ok) throw parseErr;
        json = undefined;
      }
      if (response.ok) {
        return this.toGenerateResult(json, body, Object.fromEntries(response.headers.entries()));
      }
      const message = (json !== undefined ? errorMessage(json) : undefined) ?? `${response.status} ${response.statusText}`;
      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        lastErr = new Error(`responses API call failed (${response.status}): ${message}`);
        await sleepBackoff(attempt, options.abortSignal);
        continue;
      }
      throw new Error(`responses API call failed (${response.status}): ${message}`);
    }
    throw lastErr ?? new Error('responses request failed');
  }

  async doStream(): Promise<never> {
    throw new Error('Responses streaming is not implemented for Revuto; use generateText.');
  }

  private buildRequestBody(options: ModelCallOptions): JsonObject {
    const providerOptions = {
      ...(options.providerOptions?.openai ?? {}),
      ...(options.providerOptions?.[this.provider] ?? {}),
    };
    const { instructions, input } = promptToResponsesInput(options.prompt);
    const body: JsonObject = {
      model: this.spec.model,
      input,
      store: providerOptions.store ?? false,
      parallel_tool_calls: providerOptions.parallelToolCalls ?? false,
    };
    if (instructions) body.instructions = instructions;
    if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
    if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
    if (options.stopSequences?.length) body.stop = options.stopSequences;
    if (options.tools?.length) body.tools = options.tools.map(toResponsesTool);
    const toolChoice = toResponsesToolChoice(options.toolChoice);
    if (toolChoice) body.tool_choice = toolChoice;
    const reasoningEffort = this.spec.reasoningEffort ?? stringOption(providerOptions.reasoningEffort);
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
    return body;
  }

  private async fetchResponses(bodyText: string, options: ModelCallOptions): Promise<Response> {
    const url = new URL(`${this.spec.baseURL.replace(/\/+$/, '')}/responses`);
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
    if (auth === 'aws' || (auth === 'auto' && isBedrockMantle(url))) {
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
    const match = url.hostname.match(/^bedrock-mantle\.([^.]+)\./);
    if (match?.[1]) return match[1];
    throw new Error(`models.${this.provider}: awsRegion is required for AWS auth`);
  }

  private toGenerateResult(payload: unknown, requestBody: JsonObject, headers: Record<string, string>): JsonObject {
    const response = payload as ResponsesPayload;
    const content = responseContent(response);
    return {
      content,
      finishReason: finishReason(response, content),
      usage: usageFrom(response.usage),
      providerMetadata: { [this.provider]: { responseId: response.id, rawStatus: response.status } },
      request: { body: requestBody },
      response: {
        id: response.id,
        modelId: response.model ?? this.spec.model,
        headers,
        body: payload,
      },
      warnings: [],
    };
  }
}

function promptToResponsesInput(prompt: readonly ModelMessage[]): { instructions: string; input: JsonObject[] } {
  const instructions: string[] = [];
  const input: JsonObject[] = [];
  for (const message of prompt) {
    if (message.role === 'system') {
      instructions.push(String(message.content));
      continue;
    }
    input.push(...messageToItems(message));
  }
  return { instructions: instructions.join('\n\n'), input };
}

function messageToItems(message: ModelMessage): JsonObject[] {
  const content = Array.isArray(message.content) ? message.content as JsonObject[] : [{ type: 'text', text: String(message.content) }];
  if (message.role === 'tool') {
    return content.filter((p) => p.type === 'tool-result').map((part) => ({
      type: 'function_call_output',
      call_id: String(part.toolCallId),
      output: stringifyToolOutput((part.output as JsonObject | undefined)?.value ?? part.output),
    }));
  }
  if (message.role === 'assistant') {
    const items: JsonObject[] = [];
    const text = textFromParts(content);
    if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    for (const part of content) {
      if (part.type === 'tool-call') {
        items.push({
          type: 'function_call',
          call_id: String(part.toolCallId),
          name: String(part.toolName),
          arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
        });
      }
    }
    return items;
  }
  const text = textFromParts(content);
  return [{ role: message.role, content: [{ type: 'input_text', text }] }];
}

function textFromParts(parts: readonly JsonObject[]): string {
  return parts
    .filter((part) => part.type === 'text' || part.type === 'reasoning')
    .map((part) => String(part.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(toJsonValue(output));
}

function toResponsesTool(tool: JsonObject): JsonObject {
  if (tool.type !== 'function') return tool;
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: tool.strict,
  };
}

function toResponsesToolChoice(choice: ModelCallOptions['toolChoice']): string | JsonObject | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
    case 'none':
    case 'required':
      return choice.type;
    case 'tool':
      return { type: 'function', name: choice.toolName };
  }
}

function responseContent(response: ResponsesPayload): JsonObject[] {
  const content: JsonObject[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'function_call') {
      content.push({
        type: 'tool-call',
        toolCallId: String(item.call_id ?? item.id),
        toolName: String(item.name),
        input: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
      continue;
    }
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as JsonObject[]) {
        if (part.type === 'output_text' || part.type === 'text') {
          content.push({ type: 'text', text: String(part.text ?? '') });
        }
      }
      continue;
    }
    if (item.type === 'reasoning') {
      const parts = Array.isArray(item.summary) && item.summary.length > 0 ? item.summary : item.content;
      const text = Array.isArray(parts) ? (parts as JsonObject[]).map((p) => String(p.text ?? '')).filter(Boolean).join('\n') : '';
      if (text) content.push({ type: 'reasoning', text });
    }
  }
  if (content.length === 0 && response.output_text) content.push({ type: 'text', text: response.output_text });
  return content;
}

function finishReason(response: ResponsesPayload, content: readonly JsonObject[]): JsonObject {
  if (content.some((part) => part.type === 'tool-call')) return { unified: 'tool-calls', raw: response.status };
  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') return { unified: 'length', raw: response.status };
  return { unified: response.status === 'failed' ? 'error' : 'stop', raw: response.status };
}

function usageFrom(usage?: ResponseUsage): JsonObject {
  const cached = usage?.input_tokens_details?.cached_tokens;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: {
      total: usage?.input_tokens,
      noCache: usage?.input_tokens === undefined || cached === undefined ? undefined : usage.input_tokens - cached,
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.output_tokens,
      text: usage?.output_tokens === undefined || reasoning === undefined ? undefined : usage.output_tokens - reasoning,
      reasoning,
    },
    raw: toJsonValue(usage ?? {}),
  };
}

function resolveApiKey(spec: ModelSpec): string {
  if (!spec.apiKeyEnv) return '';
  return process.env[spec.apiKeyEnv] ?? '';
}

function isBedrockMantle(url: URL): boolean {
  return url.hostname.startsWith('bedrock-mantle.');
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

function definedHeaders(headers?: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function parseJson(text: string, url: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`responses API returned invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function errorMessage(payload: unknown): string | undefined {
  const p = payload as { error?: { message?: string } };
  return p.error?.message;
}

function stringOption(value: unknown): ModelSpec['reasoningEffort'] | undefined {
  return typeof value === 'string' ? value as ModelSpec['reasoningEffort'] : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, toJsonValue(v)]));
  }
  return String(value);
}
