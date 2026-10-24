/** AGY completion bridge. Revuto executes the returned tool calls locally. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { z } from 'zod';
import type { ModelSpec } from './config.js';
import { runAgyCli } from './agy-review.js';

const Reply = z.object({
  text: z.string(),
  toolCalls: z.array(z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) })),
});

export class AgyLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly supportedUrls = {};
  readonly provider: string;
  readonly modelId: string;

  constructor(private readonly spec: ModelSpec) {
    this.provider = spec.name ?? 'agy';
    this.modelId = spec.model;
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    options.abortSignal?.throwIfAborted();
    const choice = options.toolChoice;
    const tools = (options.tools ?? []).filter(tool => {
      if (tool.type !== 'function') throw new Error('AGY completions support function tools only');
      return choice?.type !== 'none' && (choice?.type !== 'tool' || tool.name === choice.toolName);
    });
    const required = choice?.type === 'required' || choice?.type === 'tool';
    if (required && !tools.length) throw new Error('AGY required tool is unavailable');
    const schema = JSON.stringify({
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string' },
        toolCalls: {
          type: 'array', ...(required ? { minItems: 1 } : {}),
          ...(tools.length ? {} : { maxItems: 0 }),
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', ...(tools.length ? { enum: tools.map(t => t.name) } : {}) },
              input: { type: 'object', additionalProperties: true },
            },
            required: ['name', 'input'],
          },
        },
      },
      required: ['text', 'toolCalls'],
    });
    const prompt = [
      'You are the completion model inside Revuto. Continue the supplied conversation.',
      'Return the structured envelope: text for an answer, or toolCalls selecting the supplied function tools.',
      'Do not execute tools yourself. Do not read files, run commands, access the network or delegate work.',
      'Revuto executes the selected tool calls and supplies their results in the next conversation turn.',
      'Respect the supplied toolChoice and tool input schemas. Put JSON-format answers in text when requested.',
      'REVUTO_REQUEST_JSON',
      JSON.stringify({ prompt: options.prompt, tools, toolChoice: choice ?? { type: 'auto' }, responseFormat: options.responseFormat, maxOutputTokens: options.maxOutputTokens }),
    ].join('\n');
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    await mkdir(cache, { recursive: true });
    const cwd = await mkdtemp(join(cache, 'revuto-agy-completion-'));
    try {
      const run = await runAgyCli({
        spec: this.spec, cwd, prompt, schema, structuredOnly: true,
        maxOutputTokens: options.maxOutputTokens, signal: options.abortSignal,
      });
      if (run.toolSteps.length) throw new Error('AGY completion used native tools instead of returning tool calls');
      const parsed = Reply.parse(run.result.structured_output);
      if (required && !parsed.toolCalls.length) throw new Error('AGY completion omitted the required tool call');
      if (parsed.toolCalls.some(call => !tools.some(tool => tool.name === call.name))) {
        throw new Error('AGY completion selected an unavailable tool');
      }
      const content: LanguageModelV4GenerateResult['content'] = [];
      if (parsed.text) content.push({ type: 'text', text: parsed.text });
      for (const call of parsed.toolCalls) {
        content.push({ type: 'tool-call', toolCallId: randomUUID(), toolName: call.name, input: JSON.stringify(call.input) });
      }
      const usage = run.result.usage;
      return {
        content, warnings: [],
        finishReason: { unified: parsed.toolCalls.length ? 'tool-calls' : 'stop', raw: 'SUCCESS' },
        usage: {
          inputTokens: { total: usage?.input_tokens, noCache: usage?.input_tokens, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: usage?.output_tokens, text: undefined, reasoning: usage?.thinking_tokens },
        },
        response: { modelId: this.modelId, ...(run.result.conversation_id ? { id: run.result.conversation_id } : {}) },
      };
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }

  async doStream(_options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    throw new Error('AGY completions do not support streaming; use generateText');
  }
}
