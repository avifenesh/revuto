import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeInspectionTools } from '../agents/common/src/claude-review-mcp.js';
import { buildHarnessTools } from '../agents/common/src/tools/harness.js';
import { rgScopeConfigPath, rgScopeFlags } from '../agents/common/src/rg-scope.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' });
const files = ['top.ts', 'src/a.ts', 'src/gen/b.ts', 'lib[1]/c.ts'];
function populate(root: string): void {
  mkdirSync(join(root, 'src', 'gen'), { recursive: true }); mkdirSync(join(root, 'lib[1]'));
  writeFileSync(join(root, '.gitignore'), 'gen/\ndist/\n');
  for (const file of files) writeFileSync(join(root, file), 'SCOPE_SENTINEL\n');
}

// Stray ignore state above a workspace: a parent `.gitignore` of `*` next to an
// empty `.git` (the parent becomes the repo root), or a parent `.ignore` of `*`
// above a real checkout or a worktree. None may hide workspace files.
const layouts: { name: string; kind: 'plain' | 'checkout' | 'worktree'; setup: (parent: string) => string }[] = [
  { name: 'parent .gitignore and empty .git above a plain directory', kind: 'plain', setup: parent => {
    writeFileSync(join(parent, '.gitignore'), '*\n'); mkdirSync(join(parent, '.git'));
    const root = join(parent, 'ws'); populate(root); return root;
  } },
  { name: 'parent .ignore above a git checkout', kind: 'checkout', setup: parent => {
    writeFileSync(join(parent, '.ignore'), '*\n');
    const root = join(parent, 'ws'); populate(root); git(root, 'init', '-q'); return root;
  } },
  { name: 'parent .ignore above a git worktree', kind: 'worktree', setup: parent => {
    writeFileSync(join(parent, '.ignore'), '*\n');
    const main = join(parent, 'main'); populate(main); git(main, 'init', '-q');
    mkdirSync(join(main, 'dist')); writeFileSync(join(main, 'dist', 'forced.js'), 'SCOPE_SENTINEL\n');
    mkdirSync(join(main, 'localonly')); writeFileSync(join(main, 'localonly', 'l.ts'), 'SCOPE_SENTINEL\n');
    writeFileSync(join(main, '.gitignore'), 'gen/\ndist/\n*.gen\n');
    git(main, 'add', '.'); git(main, 'add', '-f', 'dist/forced.js'); git(main, 'commit', '-qm', 'base');
    const root = join(parent, 'ws'); git(main, 'worktree', 'add', '-q', '--detach', root);
    writeFileSync(join(main, '.git', 'info', 'exclude'), 'localonly/\n');
    // A nested repository is its own boundary: the root's `*.gen` does not reach it.
    mkdirSync(join(root, 'vendor', 'sub'), { recursive: true }); git(join(root, 'vendor', 'sub'), 'init', '-q');
    writeFileSync(join(root, 'vendor', 'sub', 'n.gen'), 'SCOPE_SENTINEL\n');
    return root;
  } },
];

for (const layout of layouts) {
  test(`Search ignores stray ignore files above the workspace: ${layout.name}`, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'revuto-stray-ignore-'));
    try {
      const root = layout.setup(parent);
      const tools = await claudeInspectionTools(root);
      const grep = tools.find(t => t.name === 'grep')!, glob = tools.find(t => t.name === 'glob')!;
      const call = async (tool: typeof grep, input: object) => JSON.parse(String(await tool.callback(input)));
      const lines = async (tool: typeof grep, input: object) => (await call(tool, input)).text.trim().split('\n');
      const visible = [join(root, 'lib[1]', 'c.ts'), join(root, 'src', 'a.ts'), join(root, 'top.ts'),
        ...(layout.kind === 'worktree' ? [join(root, 'vendor', 'sub', 'n.gen')] : [])];
      assert.deepEqual(await lines(grep, { pattern: 'SCOPE_SENTINEL' }), visible);
      // A subdirectory search keeps the workspace root's .gitignore and stays inside the directory.
      assert.deepEqual(await lines(grep, { pattern: 'SCOPE_SENTINEL', path: 'src' }), [join(root, 'src', 'a.ts')]);
      assert.deepEqual(await lines(grep, { pattern: 'SCOPE_SENTINEL', path: 'src', glob: '*.ts', output_mode: 'content' }), [`${join(root, 'src', 'a.ts')}:1:SCOPE_SENTINEL`]);
      assert.deepEqual(await lines(glob, { pattern: '*.ts', path: 'src' }), [join(root, 'src', 'a.ts')]);
      assert.deepEqual(await lines(glob, { pattern: '*.ts', path: 'lib[1]' }), [join(root, 'lib[1]', 'c.ts')]);
      assert.equal((await call(glob, { pattern: '.git' })).total_characters, 0, 'a worktree .git file is not listed');
      if (layout.kind === 'worktree') {
        // An explicit search into an ignored directory reaches its committed files and says so.
        const forced = await call(grep, { pattern: 'SCOPE_SENTINEL', path: 'dist' });
        assert.equal(forced.text.trim(), join(root, 'dist', 'forced.js'));
        assert.match(forced.note, /searched dist directly/);
        assert.equal((await call(grep, { pattern: 'NO_MATCH_VALUE', path: 'src' })).note, undefined, 'a plain miss carries no fallback note');
      }
      // The open-model tool set runs its own ripgrep; it must see the same files.
      // npm puts a WASI rg shim first on PATH; production shells run the native rg.
      const path = process.env.PATH;
      process.env.PATH = path?.split(delimiter).filter(p => !/node_modules/.test(p)).join(delimiter);
      try {
        const harness = await buildHarnessTools({ workspaceRoot: root });
        const run = async (name: string, input: object) => String(await harness.tools.find(t => t.name === name)!.callback(input as any));
        assert.match(await run('grep', { pattern: 'SCOPE_SENTINEL' }), /src\/a\.ts/);
        assert.match(await run('glob', { pattern: '**/*.ts' }), /src\/a\.ts/);
      } finally { process.env.PATH = path; }
      assert.deepEqual(readFileSync(rgScopeConfigPath(root), 'utf8').trim().split('\n'), rgScopeFlags(root));
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
}

test('A subdirectory search next to tens of thousands of siblings still runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revuto-wide-'));
  try {
    mkdirSync(join(root, 'wide', 'target'), { recursive: true });
    writeFileSync(join(root, 'wide', 'target', 'hit.ts'), 'WIDE_SENTINEL\n');
    const pad = 'sibling-'.padEnd(48, 'x');
    for (let i = 0; i < 50_000; i++) writeFileSync(join(root, 'wide', `${pad}${i}`), '');
    const grep = (await claudeInspectionTools(root)).find(t => t.name === 'grep')!;
    const page = String(await grep.callback({ pattern: 'WIDE_SENTINEL', path: 'wide/target' }));
    assert.equal(JSON.parse(page).text.trim(), join(root, 'wide', 'target', 'hit.ts'), page.slice(0, 300));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
