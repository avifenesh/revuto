/**
 * Wire the harness read/grep/glob (and, behind allowWrite, write/edit)
 * tools with a permission policy scoped to the workspace. There is no shell or
 * LSP tool: a reviewer reads an attacker-controlled checkout, and a command
 * runner or a checkout-supplied .lsp.json would let that checkout execute code.
 */
import { read, readToolDefinition } from '@agent-sh/harness-read';
import { write, writeToolDefinition, edit, editToolDefinition } from '@agent-sh/harness-write';
import { grep, grepToolDefinition } from '@agent-sh/harness-grep';
import { glob, globToolDefinition } from '@agent-sh/harness-glob';
import {
  defaultNodeOperations,
  defaultNodeWriteOperations,
  InMemoryLedger,
  InMemoryCache,
  type PermissionPolicy,
} from '@agent-sh/harness-core';
import { adaptHarnessTool } from './adapter.js';
import type { ToolDef } from '../tool-def.js';

export interface HarnessToolsBundle {
  readonly tools: readonly ToolDef[];
  readonly workspaceRoot: string;
}

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

  const ops = defaultNodeOperations();
  const writeOps = defaultNodeWriteOperations();

  const readSession = { cwd: opts.workspaceRoot, permissions, ops, cache: readCache, ledger };
  const grepSession = { cwd: opts.workspaceRoot, permissions, ops };
  const globSession = { cwd: opts.workspaceRoot, permissions, ops };
  const writeSession = { cwd: opts.workspaceRoot, permissions, ops, writeOps, ledger };

  const tools: ToolDef[] = [
    adaptHarnessTool({ def: readToolDefinition, fn: read, session: readSession }),
    adaptHarnessTool({ def: grepToolDefinition, fn: grep, session: grepSession }),
    adaptHarnessTool({ def: globToolDefinition, fn: glob, session: globSession }),
  ];

  // The agent never edits source. Gated by `allowWrite`, which defaults to false,
  // and confined to the workspace like every other tool here.
  if (opts.allowWrite) {
    tools.push(adaptHarnessTool({ def: writeToolDefinition, fn: write, session: writeSession }));
    tools.push(adaptHarnessTool({ def: editToolDefinition, fn: edit, session: writeSession }));
  }

  return { tools, workspaceRoot: opts.workspaceRoot };
}
