/**
 * Keep ripgrep's ignore rules inside the workspace being searched. By default
 * rg reads `.ignore`/`.rgignore` from every parent directory, treats a parent
 * `.git` as the repo root (so that parent's `.gitignore` applies), and reads the
 * machine's global gitignore. Any of them can silently hide workspace files.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { engineRoot } from './engine-root.js';

/**
 * `--no-require-git` is added only when the root has no `.git` (directory or a
 * worktree's file), so a plain directory still honors its own `.gitignore`. A
 * real checkout keeps git semantics: a worktree's `info/exclude` and the
 * boundary at a nested repository.
 */
export function rgScopeFlags(root: string): string[] {
  return ['--no-ignore-parent', '--no-ignore-global', ...(existsSync(join(root, '.git')) ? [] : ['--no-require-git'])];
}

/**
 * The same flags as a static rg config, for shells where the model runs rg
 * itself. The files live in the revuto package, outside any workspace.
 */
export function rgScopeConfigPath(root: string): string {
  return join(engineRoot(), 'agents', 'common', 'rg', existsSync(join(root, '.git')) ? 'scope.rc' : 'scope-no-git.rc');
}
