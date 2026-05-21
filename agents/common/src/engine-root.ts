/**
 * Locate the engine repo root (the dir holding this project's package.json).
 * Robust across `tsx` (source tree) and `node dist/...` because it walks up
 * looking for the package.json named "reviewer" rather than assuming depth.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

let cached: string | null = null;

export function engineRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'reviewer') { cached = dir; return dir; }
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = process.cwd();
  return cached;
}
