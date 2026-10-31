/**
 * Smoke for the tools a real Codex CLI offers a review. The run goes through
 * runAgyCli against a local server that records Codex's first model request;
 * the only tools in it must be the sandboxed shell (exec_command, write_stdin):
 * no code mode, sub-agents, tool search or patch tool. Run it after every Codex
 * upgrade. It uses the build, because the MCP
 * server Codex starts is the compiled one.
 *
 *   npm run build
 *   REVUTO_CODEX_COMMAND=/path/to/codex npx tsx scripts/smoke/codex-tools.ts [model]
 * Use the native binary or the @openai/codex package entry point. Default model: gpt-6.1-sol.
 */
import assert from 'node:assert/strict';
import childProcess, { execFileSync, type ExecFileOptions, type SpawnOptions } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

// Model ids only: the value is printed and passed to Codex.
const model = (process.argv[2] ?? 'gpt-6.1-sol').replace(/[^\w.:-]/g, '');
const configuredCommand = process.env.REVUTO_CODEX_COMMAND?.trim() || 'codex';
const command = configuredCommand.includes('/') ? resolve(configuredCommand) : configuredCommand;
const bodies: string[] = [];
const routedStages = new Set<string>();
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"unexpected smoke route"}}');
      return;
    }
    bodies.push(body);
    const text = JSON.stringify({ decision: 'skip_review', reason: 'smoke capture complete', body: '', comments: [] });
    const item = { type: 'message', id: 'msg_smoke', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: 'resp_smoke', object: 'response', created_at: 0, status: 'completed', model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-tools-'));
const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const originalExecFileAsync = promisify(childProcess.execFile);
const previousSmokeKey = process.env.REVUTO_SMOKE_KEY;
try {
  // The fixed diff range the MCP server needs: the last commit of this checkout.
  const head = execFileSync('git', ['rev-parse', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  // This fixture adds only the loopback provider configuration at the process
  // boundary. The executable, restricted catalog, arguments and environment
  // still come from the real runner. No wrapper or user configuration is loaded.
  const provider = [
    'model_provider="capture"', 'model_providers.capture.name="capture"',
    `model_providers.capture.base_url="http://127.0.0.1:${port}/v1"`, 'model_providers.capture.wire_api="responses"',
    'model_providers.capture.env_key="CODEX_API_KEY"', 'model_providers.capture.request_max_retries=0',
    'model_providers.capture.stream_max_retries=0',
  ].flatMap((c) => ['-c', c]);
  const captureArgs = (file: string, args: readonly string[]) => {
    const stage = args[0] === 'debug' && args[1] === 'models' ? 'catalog' : args[0] === 'exec' ? 'review' : undefined;
    if (file !== command) {
      assert.equal(stage, undefined, 'Codex subprocesses must match the normalized capture command');
      return args;
    }
    assert.ok(stage, 'every Codex subprocess must use the loopback capture configuration');
    routedStages.add(stage);
    return [...args, ...provider];
  };
  childProcess.execFile = ((...args: unknown[]) => {
    if (args[0] === command && Array.isArray(args[1])) args[1] = captureArgs(command, args[1]);
    return Reflect.apply(originalExecFile, childProcess, args);
  }) as typeof childProcess.execFile;
  Object.defineProperty(childProcess.execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: ExecFileOptions) => originalExecFileAsync(file, captureArgs(file, args), options),
  });
  childProcess.spawn = ((file: string, args: readonly string[], options: SpawnOptions) => originalSpawn(file, captureArgs(file, args), options)) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  // Load after installing the process fixture so the compiled runner receives it.
  const { runAgyCli, nativeCommand } = await import(new URL('../../dist/agents/common/src/agy-review.js', import.meta.url).href) as typeof import('../../agents/common/src/agy-review.js');
  const { codexExecutableRoots } = await import(new URL('../../dist/agents/common/src/codex-review.js', import.meta.url).href) as typeof import('../../agents/common/src/codex-review.js');
  await codexExecutableRoots(command);
  const wrapper = join(dir, 'wrapper');
  writeFileSync(wrapper, '#!/bin/sh\nexit 99\n');
  chmodSync(wrapper, 0o755);
  await assert.rejects(codexExecutableRoots(wrapper), /wrapper script/, 'the real runner still rejects wrappers');
  process.env.REVUTO_SMOKE_KEY = 'smoke';
  const spec = { api: 'codex' as const, baseURL: 'codex://openai', auth: 'bearer' as const, apiKeyEnv: 'REVUTO_SMOKE_KEY', model, command };
  assert.equal(nativeCommand(spec), command, 'fixture and runner command normalization must agree');
  await runAgyCli({ spec, cwd: process.cwd(), prompt: 'Say hi.', diffRange: `${head[0]}..${head[1]}`, timeoutMs: 60_000 });
  assert.deepEqual([...routedStages].sort(), ['catalog', 'review'], 'both native subprocess paths used capture configuration');
} finally {
  childProcess.spawn = originalSpawn;
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  if (previousSmokeKey === undefined) delete process.env.REVUTO_SMOKE_KEY;
  else process.env.REVUTO_SMOKE_KEY = previousSmokeKey;
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

assert.ok(bodies.length > 0, 'Codex sent a model request');
const request = JSON.parse(bodies[0]!) as { model?: string; tools?: unknown[]; input?: Array<{ type?: string; tools?: unknown[] }> };
assert.equal(request.model, model, 'the real CLI requested the selected model');
const names: string[] = [];
const walk = (tools: unknown[] = [], prefix = '') => {
  for (const tool of tools as Array<{ type?: string; name?: string; tools?: unknown[] }>) {
    if (tool.type === 'namespace') walk(tool.tools, `${prefix}${tool.name}.`);
    else names.push(`${prefix}${tool.name ?? tool.type}`);
  }
};
walk(request.tools);
for (const item of request.input ?? []) if (item.type === 'additional_tools') walk(item.tools);
const allowed = /^(functions\.)?(exec_command|write_stdin)$/;
assert.ok(names.some((n) => /(^|\.)exec_command$/.test(n)), `the review gets a shell: ${names.join(', ')}`);
assert.deepEqual(names.filter((n) => !allowed.test(n)), [], 'no tool beyond the sandboxed shell');
console.log(`codex tools ok (${model}): ${JSON.stringify(names).replace(/[\r\n\u2028\u2029]/g, '')}`);
