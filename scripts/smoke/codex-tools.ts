/**
 * Smoke for the tools a real Codex CLI offers a review. The run goes through
 * runAgyCli against a local server that records Codex's first model request;
 * the only tools in it must be the sandboxed shell (exec_command, write_stdin):
 * no code mode, sub-agents, tool search or patch tool. Run it after every Codex
 * upgrade. It uses the build, because the MCP
 * server Codex starts is the compiled one.
 *
 *   npm run build && npx tsx scripts/smoke/codex-tools.ts [model]   # default gpt-6.1-sol
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The compiled runner: its MCP server path resolves to the compiled server beside it.
const { runAgyCli } = await import(new URL('../../dist/agents/common/src/agy-review.js', import.meta.url).href) as typeof import('../../agents/common/src/agy-review.js');

// Model ids only: the value is printed and passed to Codex.
const model = (process.argv[2] ?? 'gpt-6.1-sol').replace(/[^\w.:-]/g, '');
const bodies: string[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url?.endsWith('/responses')) bodies.push(body);
    res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"smoke capture","type":"invalid_request_error"}}');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;

const dir = mkdtempSync(join(tmpdir(), 'revuto-codex-tools-'));
try {
  // The fixed diff range the MCP server needs: the last commit of this checkout.
  const head = execFileSync('git', ['rev-parse', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  // Point Codex at the capture server; everything else is revuto's own arguments.
  const command = join(dir, 'codex');
  const provider = [
    'model_provider="capture"', 'model_providers.capture.name="capture"',
    `model_providers.capture.base_url="http://127.0.0.1:${port}/v1"`, 'model_providers.capture.wire_api="responses"',
    'model_providers.capture.env_key="CODEX_API_KEY"', 'model_providers.capture.request_max_retries=0',
    'model_providers.capture.stream_max_retries=0',
  ].flatMap((c) => ['-c', `'${c}'`]).join(' ');
  writeFileSync(command, `#!/bin/sh\nexec codex "$@" ${provider}\n`);
  chmodSync(command, 0o755);
  process.env.REVUTO_SMOKE_KEY = 'smoke';
  const spec = { api: 'codex' as const, baseURL: 'codex://openai', auth: 'bearer' as const, apiKeyEnv: 'REVUTO_SMOKE_KEY', model, command };
  await runAgyCli({ spec, cwd: process.cwd(), prompt: 'Say hi.', diffRange: `${head[0]}..${head[1]}`, timeoutMs: 60_000 }).catch(() => undefined);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

assert.ok(bodies.length > 0, 'Codex sent a model request');
const request = JSON.parse(bodies[0]!) as { tools?: unknown[]; input?: Array<{ type?: string; tools?: unknown[] }> };
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
console.log(`codex tools ok (${model}): ${names.join(', ')}`);
