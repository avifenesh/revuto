import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeInspectionTools } from '../agents/common/src/claude-review-mcp.js';
import { buildHarnessTools } from '../agents/common/src/tools/harness.js';

// Stray ignore state above a workspace: a parent `.gitignore` of `*` next to an
// empty `.git` (the parent becomes the repo root), or a parent `.ignore` of `*`
// above a real checkout. Neither may hide workspace files from search.
const layouts = [
  { name: 'parent .gitignore and empty .git above a plain directory', parent: (dir: string) => {
    writeFileSync(join(dir, '.gitignore'), '*\n'); mkdirSync(join(dir, '.git'));
  }, git: false },
  { name: 'parent .ignore above a git checkout', parent: (dir: string) => {
    writeFileSync(join(dir, '.ignore'), '*\n');
  }, git: true },
];

for (const layout of layouts) {
  test(`Search ignores stray ignore files above the workspace: ${layout.name}`, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'revuto-stray-ignore-'));
    try {
      layout.parent(parent);
      const root = join(parent, 'ws');
      mkdirSync(join(root, 'src', 'gen'), { recursive: true }); mkdirSync(join(root, 'lib[1]'));
      if (layout.git) execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(join(root, '.gitignore'), 'gen/\n');
      for (const file of ['top.ts', 'src/a.ts', 'src/gen/b.ts', 'lib[1]/c.ts']) writeFileSync(join(root, file), 'SCOPE_SENTINEL\n');
      const tools = await claudeInspectionTools(root);
      const grep = tools.find(t => t.name === 'grep')!, glob = tools.find(t => t.name === 'glob')!;
      const lines = async (tool: typeof grep, input: object) => JSON.parse(String(await tool.callback(input))).text.trim().split('\n');
      assert.deepEqual(await lines(grep, { pattern: 'SCOPE_SENTINEL' }),
        [join(root, 'lib[1]', 'c.ts'), join(root, 'src', 'a.ts'), join(root, 'top.ts')]);
      // A subdirectory search keeps the workspace root's .gitignore and stays inside the directory.
      assert.deepEqual(await lines(grep, { pattern: 'SCOPE_SENTINEL', path: 'src' }), [join(root, 'src', 'a.ts')]);
      assert.deepEqual(await lines(grep, { pattern: 'SCOPE_SENTINEL', path: 'src', glob: '*.ts', output_mode: 'content' }), [`${join(root, 'src', 'a.ts')}:1:SCOPE_SENTINEL`]);
      assert.deepEqual(await lines(glob, { pattern: '*.ts', path: 'src' }), [join(root, 'src', 'a.ts')]);
      assert.deepEqual(await lines(glob, { pattern: '*.ts', path: 'lib[1]' }), [join(root, 'lib[1]', 'c.ts')]);
      // The open-model tool set runs its own ripgrep; it must see the same files.
      const harness = (await buildHarnessTools({ workspaceRoot: root })).tools;
      assert.match(String(await harness.find(t => t.name === 'grep')!.callback({ pattern: 'SCOPE_SENTINEL' })), /src\/a\.ts/);
      assert.match(String(await harness.find(t => t.name === 'glob')!.callback({ pattern: '**/*.ts' })), /src\/a\.ts/);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}
