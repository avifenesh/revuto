/** The only tool surface exposed to Claude: guarded reads and a fixed PR diff. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildHarnessTools } from './tools/harness.js';
import { isToolErrorOutput } from './trace.js';
import type { ToolDef } from './tool-def.js';

const EXCLUDED = ['.git/**', '.env*', '.aws/**', 'id_rsa*', '*.pem', '*.key', 'node_modules/**'];
function sensitive(path: string): boolean {
  return path.split(/[\\/]/).some(p => ['.git', '.aws', 'node_modules'].includes(p)
    || p.startsWith('.env') || p.startsWith('id_rsa') || p.endsWith('.pem') || p.endsWith('.key'));
}

async function guardedPath(root: string, path = '.'): Promise<string> {
  const requested = resolve(root, path);
  const actual = await realpath(requested);
  for (const target of [requested, actual]) {
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || sensitive(rel)) throw new Error('Path is outside the allowed inspection surface');
  }
  return actual;
}

/** Drain a fixed inspection command with bounded retained memory. */
function commandPage(command: 'git' | 'rg', root: string, args: string[], offset: number, limit: number): Promise<string> {
  return new Promise((resolvePage, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    let total = 0, page = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} inspection timed out`)); }, 60_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const start = Math.max(0, offset - total);
      const end = Math.min(chunk.length, offset + limit - total);
      if (end > start) page += chunk.slice(start, end);
      total += chunk.length;
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk.slice(0, Math.max(0, 4000 - stderr.length)); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !(command === 'rg' && code === 1 && !stderr.trim())) { reject(new Error(`${command} inspection exited ${code}: ${stderr}`)); return; }
      const next = offset + page.length < total ? offset + page.length : null;
      resolvePage(JSON.stringify({ offset, next_offset: next, total_characters: total, text: page }));
    });
  });
}

export async function claudeInspectionTools(workspaceRoot: string, diffRange?: string): Promise<readonly ToolDef[]> {
  workspaceRoot = await realpath(workspaceRoot);
  const bundle = await buildHarnessTools({ workspaceRoot, allowWrite: false });
  const tools = bundle.tools.filter(t => ['read', 'grep', 'glob'].includes(t.name)).map(tool => ({
    ...tool,
    ...(tool.name === 'read' ? {} : {
      description: `${tool.name === 'grep' ? 'Search contents with ripgrep regex (or fixed_strings). Files over 5 MB are skipped; matching lines over 2000 columns are omitted by rg.' : 'Find paths with ripgrep glob syntax: slash-free globs match basenames at any depth.'} Results are sorted by path, respect ignore files and exclude sensitive paths. Returns {offset,next_offset,total_characters,text}. Offsets and limits are CHARACTER counts, not lines or matches. Keep paging with next_offset until null before claiming a complete result.`,
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional(),
        offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(12000).optional(),
        ...(tool.name === 'grep' ? { glob: z.string().optional(), type: z.string().optional(),
          fixed_strings: z.boolean().optional(), case_insensitive: z.boolean().optional(), multiline: z.boolean().optional(),
          output_mode: z.enum(['files_with_matches', 'content', 'count']).optional(),
          context: z.number().int().min(0).max(100).optional() } : {}),
      }).strict(),
    }),
    callback: async (input: any) => {
      try {
        const path = await guardedPath(workspaceRoot, input.path);
        if (tool.name === 'read') return await tool.callback({ ...input, path });
        // The harness directory search checks its root, but not every matched
        // child's sensitive path. Enforce exclusions in the search itself.
        const args: string[] = tool.name === 'glob' ? ['--files', '--glob', input.pattern] : ['--line-number', '--max-columns', '2000', '--max-filesize', '5M'];
        args.push('--sort', 'path');
        if (tool.name === 'grep') {
          if (input.glob) args.push('--glob', input.glob);
          if (input.type) args.push('--type', input.type);
          if (input.fixed_strings) args.push('--fixed-strings');
          if (input.case_insensitive) args.push('--ignore-case');
          if (input.multiline) args.push('--multiline');
          if (input.output_mode === 'files_with_matches' || !input.output_mode) args.push('--files-with-matches');
          if (input.output_mode === 'count') args.push('--count');
          if (input.context !== undefined) args.push('--context', String(input.context));
        }
        // Last globs win in rg: keep the mandatory exclusions after user filters.
        for (const excluded of EXCLUDED) args.push('--glob', `!**/${excluded}`);
        args.push('--', ...(tool.name === 'grep' ? [input.pattern] : []), path);
        return await commandPage('rg', workspaceRoot, args, input.offset ?? 0, input.limit ?? 10000);
      } catch (error) { return `ERROR: ${error instanceof Error ? error.message : String(error)}`; }
    },
  }));
  if (diffRange) {
    if (!/^[a-f0-9]{40}\.\.[a-f0-9]{40}$/.test(diffRange)) throw new Error('Invalid immutable diff range');
    tools.push({
      name: 'pr_diff', description: 'Read the exact PR diff. Start with mode=stat, then select a repository-relative path and page using next_offset until null. Offsets and limits count characters. No arbitrary commands or revisions are accepted.',
      inputSchema: z.object({ path: z.string().optional(), mode: z.enum(['patch', 'stat']).optional(),
        offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(12000).optional() }).strict(),
      callback: async (input: { path?: string; mode?: string; offset?: number; limit?: number }) => {
        let path = '.';
        if (input.path !== undefined) {
          path = relative(workspaceRoot, resolve(workspaceRoot, input.path));
          if (isAbsolute(input.path) || path === '..' || path.startsWith('../') || sensitive(path)) throw new Error('Invalid PR diff path');
        }
        return commandPage('git', workspaceRoot, [
          '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', ...(input.mode === 'stat' ? ['--stat'] : []), diffRange, '--', `:(literal)${path || '.'}`,
          ...EXCLUDED.map(p => `:(exclude,glob)**/${p}`),
        ], input.offset ?? 0, input.limit ?? 10000);
      },
    });
  }
  return tools;
}

async function main(): Promise<void> {
  const workspace = process.argv[2];
  if (!workspace || resolve(workspace) !== workspace) throw new Error('An absolute workspace is required');
  const tools = await claudeInspectionTools(workspace, process.argv[3] || undefined);
  const server = new Server({ name: 'revuto-inspection', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(t => ({
    name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.inputSchema) as any,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const tool = tools.find(t => t.name === request.params.name);
      if (!tool) throw new Error('Unknown inspection tool');
      const result = await tool.callback(tool.inputSchema.parse(request.params.arguments ?? {}));
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text' as const, text }], isError: isToolErrorOutput(result) };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
