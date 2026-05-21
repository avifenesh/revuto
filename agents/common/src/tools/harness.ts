/**
 * Wire the harness-tools read/write/grep/glob/bash/lsp tools with a
 * permission policy scoped to the workspace + a readonly bash allowlist.
 */
import {
  read, readToolDefinition,
  write, writeToolDefinition, edit, editToolDefinition,
  grep, grepToolDefinition,
  glob, globToolDefinition,
  bash, bashToolDefinition,
  lsp, lspToolDefinition,
} from '@agent-sh/harness-tools';
import {
  defaultNodeOperations,
  defaultNodeWriteOperations,
  InMemoryLedger,
  InMemoryCache,
  type PermissionPolicy,
  type PermissionHook,
} from '@agent-sh/harness-core';
import { createSpawnLspClient, loadManifest, type LspManifest } from '@agent-sh/harness-tools/lsp';
import { adaptHarnessTool } from './adapter.js';
import type { ToolDef } from '../tool-def.js';

export interface HarnessToolsBundle {
  readonly tools: readonly ToolDef[];
  readonly workspaceRoot: string;
}

/**
 * Bash permission hook: a shallow allowlist of commands the reviewer
 * legitimately needs. Anything destructive is denied — the agent must
 * use the dedicated `git` / `gh` wrappers, which have their own
 * per-subcommand allowlist.
 */
const BASH_ALLOWLIST: ReadonlyArray<RegExp> = [
  // Read-only inspection
  /^\s*(ls|cat|head|tail|wc|file|stat|du|find|tree|which|type|pwd|echo)\b/,
  // Text tools
  /^\s*(rg|ripgrep|grep|sed\s+-n|awk|sort|uniq|cut|tr|xargs)\b/,
  /^\s*(jq|yq)\b/,
  // Compiler inspection (doesn't modify repo)
  /^\s*(clang|gcc|cpp|nm|objdump|readelf|addr2line|c\+\+filt)\b/,
  // Build targets (writes to build dir, not source; sandbox-safe)
  /^\s*make\b/,
];

const BASH_DENYLIST: ReadonlyArray<RegExp> = [
  /\brm\s+-rf?\s+\//, // scorched-earth
  /:\(\)\s*\{/,        // fork bomb
  /\bsudo\b/,
  /\bchown\b/,
  /\bchmod\s+\d{3,4}\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
];

const bashPermissionHook: PermissionHook = async (req) => {
  // req.metadata.command is set by the bash tool.
  const cmd = (req.metadata?.command as string | undefined) ?? '';
  for (const deny of BASH_DENYLIST) if (deny.test(cmd)) return 'deny';
  for (const allow of BASH_ALLOWLIST) if (allow.test(cmd)) return 'allow';
  // Explicit deny for everything else — forces the agent onto the
  // narrow git/gh/make tool surfaces we wire below.
  return 'deny';
};

export async function buildHarnessTools(opts: { workspaceRoot: string; allowWrite?: boolean }): Promise<HarnessToolsBundle> {
  const roots = [opts.workspaceRoot] as const;
  const ledger = new InMemoryLedger();
  const readCache = new InMemoryCache<any>();

  const permissions: PermissionPolicy = {
    roots,
    sensitivePatterns: [
      '**/.env*', '**/.aws/**', '**/id_rsa*', '**/*.pem', '**/*.key',
      '**/node_modules/**',
    ],
    bypassWorkspaceGuard: false,
  };

  const bashPermissions: PermissionPolicy = {
    roots,
    sensitivePatterns: permissions.sensitivePatterns,
    bypassWorkspaceGuard: false,
    hook: bashPermissionHook,
  };

  const ops = defaultNodeOperations();
  const writeOps = defaultNodeWriteOperations();

  const readSession = { cwd: opts.workspaceRoot, permissions, ops, cache: readCache, ledger };
  const grepSession = { cwd: opts.workspaceRoot, permissions, ops };
  const globSession = { cwd: opts.workspaceRoot, permissions, ops };
  const writeSession = { cwd: opts.workspaceRoot, permissions, ops, writeOps, ledger };
  const bashSession = {
    cwd: opts.workspaceRoot,
    permissions: bashPermissions,
    maxOutputBytes: 512_000,
    defaultTimeoutMs: 180_000,
  };

  // LSP: .lsp.json at the workspace root registers clangd for .c/.h files.
  // When absent, fall through to the default manifest baked below.
  const loadedManifest = await loadManifest(undefined, opts.workspaceRoot);
  const lspManifest: LspManifest = loadedManifest ?? {
    servers: {
      clangd: {
        language: 'c',
        extensions: ['.c', '.h'],
        command: ['clangd', '--background-index', '--header-insertion=never'],
        rootPatterns: ['compile_commands.json', '.git'],
      },
    },
  };
  const lspSession = {
    cwd: opts.workspaceRoot,
    permissions,
    manifest: lspManifest,
    client: createSpawnLspClient(),
  };

  const tools: ToolDef[] = [
    adaptHarnessTool({ def: readToolDefinition, fn: read, session: readSession }),
    adaptHarnessTool({ def: grepToolDefinition, fn: grep, session: grepSession }),
    adaptHarnessTool({ def: globToolDefinition, fn: glob, session: globSession }),
    adaptHarnessTool({ def: bashToolDefinition, fn: bash, session: bashSession }),
    adaptHarnessTool({ def: lspToolDefinition, fn: lsp, session: lspSession }),
  ];

  // The agent occasionally needs to scratch a file (e.g. write a
  // targeted search query to /tmp), but it never edits source.
  // Gated by `allowWrite` which defaults to false.
  if (opts.allowWrite) {
    tools.push(adaptHarnessTool({ def: writeToolDefinition, fn: write, session: writeSession }));
    tools.push(adaptHarnessTool({ def: editToolDefinition, fn: edit, session: writeSession }));
  }

  return { tools, workspaceRoot: opts.workspaceRoot };
}

