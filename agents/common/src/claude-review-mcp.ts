/** The only tool surface exposed to Claude: guarded reads and a fixed PR diff. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export async function claudeInspectionTools(workspaceRoot: string, diffRange?: string): Promise<readonly ToolDef[]> {
  workspaceRoot = await realpath(workspaceRoot);
  const bundle = await buildHarnessTools({ workspaceRoot, allowWrite: false });
  const tools = bundle.tools.filter(t => ['read', 'grep', 'glob'].includes(t.name)).map(tool => ({
    ...tool,
    callback: async (input: any) => {
      try {
        const path = await guardedPath(workspaceRoot, input.path);
        if (tool.name === 'read') return await tool.callback({ ...input, path });
        // The harness directory search checks its root, but not every matched
        // child's sensitive path. Enforce exclusions in the search itself.
        const args: string[] = tool.name === 'glob' ? ['--files', '--glob', input.pattern] : ['--line-number', '--max-columns', '2000', '--max-filesize', '5M'];
        if (tool.name === 'grep') {
          if (input.glob) args.push('--glob', input.glob);
          if (input.type) args.push('--type', input.type);
          if (input.fixed_strings) args.push('--fixed-strings');
          if (input.case_insensitive) args.push('--ignore-case');
          if (input.multiline) args.push('--multiline');
          if (input.output_mode === 'files_with_matches' || !input.output_mode) args.push('--files-with-matches');
          if (input.output_mode === 'count') args.push('--count');
          for (const [key, flag] of [['context', '--context'], ['context_before', '--before-context'], ['context_after', '--after-context']]) {
            if (input[key] !== undefined) args.push(flag!, String(Math.min(100, Math.max(0, input[key]))));
          }
        }
        // Last globs win in rg: keep the mandatory exclusions after user filters.
        for (const excluded of EXCLUDED) args.push('--glob', `!**/${excluded}`);
        args.push('--', ...(tool.name === 'grep' ? [input.pattern] : []), path);
        try {
          const result = await promisify(execFile)('rg', args, { cwd: workspaceRoot, timeout: 60_000, maxBuffer: 512_000,
            env: { PATH: process.env.PATH } });
          const offset = Math.max(0, input.offset ?? 0);
          return result.stdout.split('\n').slice(offset, offset + Math.min(2000, Math.max(1, input.head_limit ?? 250))).join('\n');
        } catch (error) {
          if ((error as { code?: number }).code === 1) return '(no matches)';
          throw error;
        }
      } catch (error) { return `ERROR: ${error instanceof Error ? error.message : String(error)}`; }
    },
  }));
  if (diffRange) {
    if (!/^[a-f0-9]{40}\.\.[a-f0-9]{40}$/.test(diffRange)) throw new Error('Invalid immutable diff range');
    tools.push({
      name: 'pr_diff', description: 'Read the exact pull request diff. No arbitrary commands or revisions are accepted.',
      inputSchema: z.object({}).strict(),
      callback: async () => {
        const result = await promisify(execFile)('git', [
          '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', diffRange, '--', '.',
          ...EXCLUDED.map(p => `:(exclude,glob)**/${p}`),
        ], { cwd: workspaceRoot, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
          env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
        return result.stdout || '(empty diff after sensitive-path exclusions)';
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
