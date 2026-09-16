import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SMALL_REVIEW, loadConfig, type ModelSpec, type ReviewerConfig } from '../agents/common/src/config.js';
import { chooseReviewModel, isDocsFile, logIgnoredOnce, repoIgnored, resetIgnoredLog, withReviewModel } from '../agents/common/src/review-routing.js';
import { signReviewBody } from '../agents/common/src/tools/gh.js';
import { checkResultForOutcome } from '../daemon/src/review-check.js';
import type { ReviewOutcome } from '../agents/common/src/run-agent.js';

const http = (model: string, name?: string): ModelSpec => ({ baseURL: 'http://localhost', model, ...(name ? { name } : {}) });

function config(overrides: { reviewSmall?: ModelSpec; small?: Partial<ReviewerConfig['review']['small']> } = {}): ReviewerConfig {
  return {
    vaultPath: '/tmp/vault',
    github: { tokenEnv: 'GH_TOKEN' },
    models: {
      review: http('big-model', 'opus'),
      ...(overrides.reviewSmall ? { reviewSmall: overrides.reviewSmall } : {}),
      curator: http('c'),
      distill: http('d'),
      embedder: null,
    },
    schedules: { review: '* * * * *', learn: '* * * * *', decay: '* * * * *' },
    review: { maxSteps: 10, allowWrite: false, workspaceDir: '/tmp/ws', ...(overrides.small ? { small: { ...DEFAULT_SMALL_REVIEW, ...overrides.small } } : {}) },
    limits: { maxOutputTokens: { review: 1, curator: 1, distill: 1 }, dailyReviews: 0, learnBatch: 0, dailyLearn: 0, dailyTokens: 0 },
    store: { backend: 'sqlite', surreal: { url: '', namespace: '' } },
  };
}

test('ignoredRepos matches full names and owner wildcards, case-insensitively', () => {
  const list = ['avifenesh/extensions', 'Agent-Sh/*'];
  assert.equal(repoIgnored(list, 'avifenesh/extensions'), true);
  assert.equal(repoIgnored(list, 'Avifenesh/Extensions'), true);
  assert.equal(repoIgnored(list, 'avifenesh/sglang'), false);
  assert.equal(repoIgnored(list, 'agent-sh/agnix'), true);
  assert.equal(repoIgnored(list, 'someone/agent-sh'), false);
  assert.equal(repoIgnored(undefined, 'avifenesh/extensions'), false);
  assert.equal(repoIgnored([], 'avifenesh/extensions'), false);
});

test('an ignored PR is logged once, not on every poll tick', () => {
  resetIgnoredLog();
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    assert.equal(logIgnoredOnce('avifenesh/extensions', 61), true);
    assert.equal(logIgnoredOnce('avifenesh/extensions', 61), false);
    assert.equal(logIgnoredOnce('avifenesh/extensions', 62, 'webhook'), true);
    assert.equal(logIgnoredOnce('avifenesh/extensions'), true);
    assert.equal(logIgnoredOnce('avifenesh/extensions'), false);
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[review\] avifenesh\/extensions#61: skipped: repo ignored/);
  assert.match(lines[1], /^\[webhook\] avifenesh\/extensions#62: skipped: repo ignored/);
});

test('docs detection by extension and by path prefix', () => {
  const small = DEFAULT_SMALL_REVIEW;
  assert.equal(isDocsFile('README.md', small), true);
  assert.equal(isDocsFile('docs/guide/index.html', small), true);
  assert.equal(isDocsFile('packages/x/notes/a.json', small), true);
  assert.equal(isDocsFile('src/notes.ts', small), false);
  assert.equal(isDocsFile('src/index.ts', small), false);
  assert.equal(isDocsFile('CHANGELOG.MD', small), true);
});

test('without models.reviewSmall every PR goes to models.review', () => {
  const cfg = config();
  const route = chooseReviewModel(cfg, { fileList: ['README.md'], additions: 1, deletions: 0 });
  assert.equal(route.small, false);
  assert.equal(route.label, 'opus');
  assert.equal(route.spec, cfg.models.review);
});

test('docs-only and small diffs route to models.reviewSmall; large code diffs do not', () => {
  const cfg = config({ reviewSmall: http('small-model', 'sonnet') });
  const docs = chooseReviewModel(cfg, { fileList: ['README.md', 'docs/a.rst'], additions: 900, deletions: 300 });
  assert.equal(docs.small, true); assert.equal(docs.label, 'sonnet'); assert.match(docs.reason, /docs only/);
  const tiny = chooseReviewModel(cfg, { fileList: ['src/a.ts', 'README.md'], additions: 120, deletions: 80 });
  assert.equal(tiny.small, true); assert.match(tiny.reason, /small diff \(200 <= 200/);
  const big = chooseReviewModel(cfg, { fileList: ['src/a.ts'], additions: 150, deletions: 51 });
  assert.equal(big.small, false); assert.equal(big.label, 'opus'); assert.match(big.reason, /201 changed lines/);
  // an empty file list is not "docs only"
  const empty = chooseReviewModel(cfg, { fileList: [], additions: 5000, deletions: 0 });
  assert.equal(empty.small, false);
  // a truncated file list (GitHub pages at 100) never passes as docs only or small
  const docsPage = Array.from({ length: 100 }, (_, i) => `docs/page-${i}.md`);
  const truncated = chooseReviewModel(cfg, { fileList: docsPage, additions: 10, deletions: 0, changedFiles: 150 });
  assert.equal(truncated.small, false); assert.match(truncated.reason, /file list truncated \(100 of 150/);
  assert.equal(chooseReviewModel(cfg, { fileList: docsPage, additions: 10, deletions: 0, changedFiles: 100 }).small, true);
  // a zero size with files in the PR means the size fields were missing, not a tiny diff
  const sizeless = chooseReviewModel(cfg, { fileList: ['src/a.ts'], additions: 0, deletions: 0, changedFiles: 1 });
  assert.equal(sizeless.small, false); assert.match(sizeless.reason, /diff size unknown/);
  assert.equal(chooseReviewModel(cfg, { fileList: [], additions: 0, deletions: 0, changedFiles: 0 }).small, true, 'a genuinely empty diff is small');
  // the size rule can be disabled and docsOnly turned off
  const strict = config({ reviewSmall: http('small-model'), small: { maxChangedLines: 0, docsOnly: false } });
  assert.equal(chooseReviewModel(strict, { fileList: ['README.md'], additions: 1, deletions: 0 }).small, false);
  assert.equal(chooseReviewModel(strict, { fileList: ['README.md'], additions: 1, deletions: 0 }).label, 'opus');
  const routed = withReviewModel(cfg, docs.spec);
  assert.equal(routed.models.review, docs.spec);
  assert.equal(routed.models.curator, cfg.models.curator);
  assert.equal(withReviewModel(cfg, cfg.models.review), cfg);
});

test('the signed footer and the check summary name the model that reviewed', () => {
  const signed = signReviewBody('finding', 'claude-cli-sonnet-5');
  assert.match(signed, /^<!-- revuto-signed -->\n\*This is an auto review done by \[revuto\]\(https:\/\/github\.com\/avifenesh\/revuto\), reviewed by claude-cli-sonnet-5\.\*\n\n---\n\nfinding$/);
  assert.equal(signReviewBody('finding'), '<!-- revuto-signed -->\n*This is an auto review done by [revuto](https://github.com/avifenesh/revuto).*\n\n---\n\nfinding');
  assert.equal(signReviewBody(signed, 'other'), signed, 'already signed bodies are left alone');
  const outcome: ReviewOutcome = {
    terminal: 'skip_review', hasFindings: false, result: 'clean', headSha: 'a'.repeat(40), steps: 3, tokens: 10,
    inspections: 4, toolErrors: 0, postFailures: 0, forcedTerminal: false, ranModel: true, model: 'claude-cli-sonnet-5',
  };
  const result = checkResultForOutcome(outcome);
  assert.equal(result.conclusion, 'success');
  assert.equal(result.reviewedBy, 'claude-cli-sonnet-5');
  assert.match(result.summary, /Reviewed by claude-cli-sonnet-5\.$/);
  assert.equal(checkResultForOutcome({ ...outcome, model: undefined }).reviewedBy, undefined);
});

test('config: ignoredRepos, reviewSmall and review.small load with validation and defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-routing-'));
  const path = join(dir, 'revuto.config.json');
  const base = {
    github: { tokenEnv: 'GH_TOKEN', app: { appId: 1, privateKeyPath: join(dir, 'k.pem'), allowedOwners: ['avifenesh'] } },
    models: { review: http('big'), curator: http('c'), distill: http('d') },
  };
  try {
    writeFileSync(path, JSON.stringify(base));
    const plain = loadConfig(path);
    assert.deepEqual(plain.github.app?.ignoredRepos, []);
    assert.equal(plain.models.reviewSmall, undefined);
    assert.deepEqual(plain.review.small, DEFAULT_SMALL_REVIEW);

    writeFileSync(path, JSON.stringify({
      ...base,
      github: { ...base.github, app: { ...base.github.app, ignoredRepos: [' avifenesh/extensions ', 'agent-sh/*'] } },
      models: { ...base.models, reviewSmall: { baseURL: 'claude-cli://local', model: 'global.anthropic.claude-sonnet-5[1m]', api: 'claude', auth: 'none', name: 'claude-cli-sonnet-5', reasoningEffort: 'medium' } },
      review: { small: { maxChangedLines: 50, docsExtensions: ['.MD'] } },
    }));
    const full = loadConfig(path);
    assert.deepEqual(full.github.app?.ignoredRepos, ['avifenesh/extensions', 'agent-sh/*']);
    assert.equal(full.models.reviewSmall?.name, 'claude-cli-sonnet-5');
    assert.equal(full.models.reviewSmall?.api, 'claude', 'native Claude CLI is allowed for the small reviewer');
    assert.deepEqual(full.review.small, { ...DEFAULT_SMALL_REVIEW, maxChangedLines: 50, docsExtensions: ['.md'] });

    writeFileSync(path, JSON.stringify({ ...base, github: { ...base.github, app: { ...base.github.app, ignoredRepos: ['extensions'] } } }));
    assert.throws(() => loadConfig(path), /ignoredRepos must be an array of "owner\/name" or "owner\/\*"/);
    writeFileSync(path, JSON.stringify({ ...base, review: { small: { maxChangedLines: -1 } } }));
    assert.throws(() => loadConfig(path), /review\.small\.maxChangedLines/);
    writeFileSync(path, JSON.stringify({ ...base, review: { small: { docsOnly: 'yes' } } }));
    assert.throws(() => loadConfig(path), /review\.small\.docsOnly/);
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, curator: { ...http('c'), api: 'claude' } } }));
    assert.throws(() => loadConfig(path), /only for models\.review and models\.reviewSmall/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
