/**
 * Locate the package root (nearest dir with a package.json), walking up from this
 * module. Robust across `tsx` (source tree), `node dist/...`, and a global npm
 * install (node_modules/revuto/...). Used to read bundled assets like
 * agent-knowledge/.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

let cached: string | null = null;

export function engineRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, 'package.json'))) { cached = dir; return dir; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = process.cwd();
  return cached;
}
