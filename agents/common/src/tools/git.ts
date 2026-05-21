import { spawn } from 'node:child_process';
import { z } from 'zod';
import { tool } from '../tool-def.js';

/**
 * Whitelisted git subcommands. Ordering matters for prefix-match; this
 * is an equality match on argv[0] after 'git'.
 */
const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log', 'show', 'blame', 'diff', 'status', 'rev-parse', 'rev-list',
  'cat-file', 'ls-tree', 'ls-files', 'grep', 'shortlog', 'describe',
  'branch', 'tag', 'reflog', 'merge-base', 'name-rev',
]);

/**
 * Forbidden argv patterns — block args that would turn a read op into a write.
 * `git log --patch` is fine; `git log --delete-branch` doesn't exist but the
 * list is here for clarity about intent, not completeness. Git flags that
 * could mutate state never appear on the read subcommands in GIT_READONLY_SUBCOMMANDS.
 */
const GIT_FORBIDDEN_ARG_PREFIXES: ReadonlyArray<string> = [
  '--exec', '-c core.', '-c alias.',
];

function runBounded(cmd: string, args: readonly string[], opts: { cwd: string; timeoutMs: number; maxBytes: number }): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args as string[], { cwd: opts.cwd });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let truncated = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, opts.timeoutMs);

    child.stdout.on('data', (b: Buffer) => {
      if (out.length + b.length > opts.maxBytes) {
        out = Buffer.concat([out, b.subarray(0, Math.max(0, opts.maxBytes - out.length))]);
        truncated = true;
        child.kill('SIGTERM');
      } else {
        out = Buffer.concat([out, b]);
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length + b.length > 64_000) return;
      err = Buffer.concat([err, b]);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const outStr = out.toString('utf8') + (truncated ? '\n[output truncated]' : '');
      resolve({ code: code ?? 1, out: outStr, err: err.toString('utf8') });
    });
  });
}

export function buildGitTool(opts: { workspaceRoot: string }) {
  return tool({
    name: 'git',
    description:
`Run a read-only git command against the checked-out PR workspace.

Allowed subcommands: ${[...GIT_READONLY_SUBCOMMANDS].sort().join(', ')}.

Use this for:
- \`git log --oneline -20 <mergeBase>..<head>\` — PR commit history.
- \`git show <sha> -- <path>\` — inspect a specific commit or file.
- \`git blame -L <start>,<end> <path>\` — who last touched these lines.
- \`git diff <mergeBase>..<head> -- <path>\` — just the PR's changes on a file.
- \`git grep <pattern>\` — fast content search at the checked-out ref.

Arguments are passed as an ARRAY of tokens — no shell interpolation.
E.g. args=["log","--oneline","-20","abc..def"], not args=["log --oneline -20 abc..def"].

Output is capped at 500 KB and 60 s.`,
    inputSchema: z.object({
      args: z.array(z.string()).min(1).describe('git argv tokens after "git", e.g. ["log","--oneline","-20"]'),
    }),
    callback: async (input: { args: string[] }) => {
      const args = input.args;
      const sub = args[0];
      if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) {
        return `ERROR: subcommand "${sub ?? ''}" is not on the allowlist. Allowed: ${[...GIT_READONLY_SUBCOMMANDS].join(', ')}.`;
      }
      for (const a of args) {
        for (const forbid of GIT_FORBIDDEN_ARG_PREFIXES) {
          if (a === forbid || a.startsWith(`${forbid}=`)) {
            return `ERROR: argument "${a}" is not allowed.`;
          }
        }
      }
      const r = await runBounded('git', args, { cwd: opts.workspaceRoot, timeoutMs: 60_000, maxBytes: 500_000 });
      if (r.code !== 0) return `git exited ${r.code}\n${r.err}\n${r.out}`;
      return r.out;
    },
  });
}
