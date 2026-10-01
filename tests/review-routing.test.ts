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
import { applyModelOverrides, extractModelOverrideArgs } from '../daemon/src/model-overrides.js';

const http = (model: string, name?: string): ModelSpec => ({ baseURL: 'http://localhost', model, ...(name ? { name } : {}) });

function config(overrides: { reviewSmall?: ModelSpec; reviewMedium?: ModelSpec; small?: Partial<ReviewerConfig['review']['small']>; medium?: ReviewerConfig['review']['medium'] } = {}): ReviewerConfig {
  return {
    vaultPath: '/tmp/vault',
    github: { tokenEnv: 'GH_TOKEN' },
    models: {
      review: http('big-model', 'opus'),
      ...(overrides.reviewSmall ? { reviewSmall: overrides.reviewSmall } : {}),
      ...(overrides.reviewMedium ? { reviewMedium: overrides.reviewMedium } : {}),
      curator: http('c'),
      distill: http('d'),
      embedder: null,
    },
    schedules: { review: '* * * * *', learn: '* * * * *', decay: '* * * * *' },
    review: { maxSteps: 10, allowWrite: false, workspaceDir: '/tmp/ws', ...(overrides.small ? { small: { ...DEFAULT_SMALL_REVIEW, ...overrides.small } } : {}), ...(overrides.medium ? { medium: overrides.medium } : {}) },
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

test('the medium tier takes PRs with few changed code lines; tests and docs do not count', () => {
  const cfg = config({ reviewSmall: http('small-model', 'sol-medium'), reviewMedium: http('medium-model', 'sol-high') });
  const changes = (...c: Array<[string, number]>) => ({
    fileList: c.map(([path]) => path),
    fileChanges: c.map(([path, n]) => ({ path, additions: n, deletions: 0 })),
    additions: c.reduce((sum, [, n]) => sum + n, 0), deletions: 0, changedFiles: c.length,
  });
  const small = chooseReviewModel(cfg, changes(['src/a.ts', 150]));
  assert.equal(small.tier, 'small'); assert.equal(small.label, 'sol-medium');
  const medium = chooseReviewModel(cfg, changes(['src/a.ts', 400], ['src/a.test.ts', 2000], ['tests/b.py', 900], ['docs/x.md', 600]));
  assert.equal(medium.tier, 'medium'); assert.equal(medium.label, 'sol-high'); assert.equal(medium.small, false);
  assert.match(medium.reason, /3900 changed lines, 400 in code, across 4 file\(s\) \(<= 500 code lines\)/);
  const large = chooseReviewModel(cfg, changes(['src/a.ts', 300], ['src/b.ts', 201]));
  assert.equal(large.tier, 'large'); assert.equal(large.label, 'opus'); assert.match(large.reason, /501 in code/);
  // without per-file counts the PR total stands in, which can only push a PR up a tier
  const noCounts = chooseReviewModel(cfg, { fileList: ['src/a.ts', 'tests/b.ts'], additions: 400, deletions: 200, changedFiles: 2 });
  assert.equal(noCounts.tier, 'large'); assert.match(noCounts.reason, /600 in code/);
  // a file list cut at one page never routes below large
  assert.equal(chooseReviewModel(cfg, { ...changes(['src/a.ts', 300]), changedFiles: 150 }).tier, 'large');
  // maxCodeLines 0 turns the medium tier off
  assert.equal(chooseReviewModel(config({ reviewMedium: http('m'), medium: { maxCodeLines: 0 } }), changes(['src/a.ts', 300])).tier, 'large');
  // without a small tier, small PRs go to the medium tier
  assert.equal(chooseReviewModel(config({ reviewMedium: http('m') }), changes(['src/a.ts', 10])).tier, 'medium');
});

test('risk paths and hotspots send even a small PR to the large tier; docs and tests do not trigger them', () => {
  const cfg = { ...config({ reviewSmall: http('s', 'small'), reviewMedium: http('m', 'medium') }) };
  const risky = { ...cfg, review: { ...cfg.review, risk: { paths: ['**/auth/**', '.github/workflows/**'], hotspotMinReinforcement: 2 } } };
  const one = (path: string, extra: object = {}) => ({ fileList: [path], fileChanges: [{ path, additions: 5, deletions: 0 }], additions: 5, deletions: 0, changedFiles: 1, ...extra });
  const auth = chooseReviewModel(risky, one('src/auth/session.ts'));
  assert.equal(auth.tier, 'large'); assert.match(auth.reason, /touches risk path src\/auth\/session\.ts \(\*\*\/auth\/\*\*\)/);
  assert.equal(chooseReviewModel(risky, one('.github/workflows/ci.yml')).tier, 'large');
  assert.equal(chooseReviewModel(risky, one('src/auth/session.test.ts')).tier, 'small', 'a test file under a risk path does not count');
  assert.equal(chooseReviewModel(risky, one('docs/auth/guide.md')).tier, 'small', 'docs under a risk path do not count');
  const hotspots = [{ glob: 'crates/transport/src/**', subject: 'lease reuse after reap' }];
  const hot = chooseReviewModel(risky, one('crates/transport/src/adapter.rs', { hotspots }));
  assert.equal(hot.tier, 'large'); assert.match(hot.reason, /touches hotspot crates\/transport\/src\/adapter\.rs \(crates\/transport\/src\/\*\*: lease reuse after reap\)/);
  assert.equal(chooseReviewModel(cfg, one('src/other.ts', { hotspots })).tier, 'small', 'no match, normal routing');
  assert.equal(chooseReviewModel(cfg, one('src/auth/x.ts')).tier, 'small', 'no risk paths by default');
});

test('review.risk loads with validation and defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-risk-'));
  const path = join(dir, 'revuto.config.json');
  const base = { vaultPath: dir, models: { review: http('r'), curator: http('c'), distill: http('d') } };
  try {
    writeFileSync(path, JSON.stringify(base));
    assert.deepEqual(loadConfig(path).review.risk, { paths: [], hotspotMinReinforcement: 3 });
    writeFileSync(path, JSON.stringify({ ...base, review: { risk: { paths: [' **/auth/** '], hotspotMinReinforcement: 0 } } }));
    assert.deepEqual(loadConfig(path).review.risk, { paths: ['**/auth/**'], hotspotMinReinforcement: 0 });
    writeFileSync(path, JSON.stringify({ ...base, review: { risk: { paths: [''] } } }));
    assert.throws(() => loadConfig(path), /review\.risk\.paths must be an array of non-empty strings/);
    writeFileSync(path, JSON.stringify({ ...base, review: { risk: { hotspotMinReinforcement: -1 } } }));
    assert.throws(() => loadConfig(path), /hotspotMinReinforcement must be a non-negative integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without models.reviewMedium the log says what the medium tier would take', () => {
  const route = chooseReviewModel(config(), { fileList: ['src/a.ts'], fileChanges: [{ path: 'src/a.ts', additions: 300, deletions: 0 }], additions: 300, deletions: 0 });
  assert.equal(route.tier, 'large');
  assert.equal(route.spec.model, 'big-model');
  assert.match(route.reason, /the medium tier would take it, but models\.reviewMedium is not set/);
});

test('reviewMedium and review.medium load with validation and defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revuto-medium-'));
  const path = join(dir, 'revuto.config.json');
  const base = { vaultPath: dir, models: { review: http('r'), curator: http('c'), distill: http('d') } };
  try {
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, reviewMedium: { baseURL: 'codex://bedrock', model: 'openai.gpt-6.1-sol', api: 'codex', reasoningEffort: 'high' } } }));
    const loaded = loadConfig(path);
    assert.equal(loaded.models.reviewMedium?.api, 'codex');
    assert.equal(loaded.review.medium?.maxCodeLines, 500);
    writeFileSync(path, JSON.stringify({ ...base, review: { medium: { maxCodeLines: -1 } } }));
    assert.throws(() => loadConfig(path), /review\.medium\.maxCodeLines must be a non-negative integer/);
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, curator: { baseURL: 'codex://bedrock', model: 'x', api: 'codex' } } }));
    assert.throws(() => loadConfig(path), /native Codex CLI is supported only for models\.review/);
    // native CLIs as each other's refusal fallbacks on review tiers, but not on other roles
    const codex = { baseURL: 'codex://bedrock', model: 'openai.gpt-6.1-sol', api: 'codex' };
    const claude = { baseURL: 'claude-cli://local', model: 'global.anthropic.claude-opus-5-5[1m]', api: 'claude' };
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, review: { ...claude, fallbacks: [codex] }, reviewSmall: { ...codex, fallbacks: [claude] }, reviewMedium: { ...codex, fallbacks: [claude] } } }));
    const chained = loadConfig(path);
    assert.equal(chained.models.review.fallbacks?.[0]?.api, 'codex');
    assert.equal(chained.models.reviewSmall?.fallbacks?.[0]?.api, 'claude');
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, curator: { ...base.models.curator, fallbacks: [codex] } } }));
    assert.throws(() => loadConfig(path), /native Codex CLI is supported only for models\.review/);
    // native first, then HTTP, is runnable; HTTP before a native CLI is not
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, review: { ...claude, fallbacks: [codex, http('h')] } } }));
    assert.equal(loadConfig(path).models.review.fallbacks?.length, 2);
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, review: { ...http('h'), fallbacks: [codex] } } }));
    assert.throws(() => loadConfig(path), /native CLI fallback after an HTTP model/);
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, reviewMedium: { ...codex, fallbacks: [{ ...http('h'), fallbacks: [claude] }] } } }));
    assert.throws(() => loadConfig(path), /models\.reviewMedium has a native CLI fallback after an HTTP model/);
    writeFileSync(path, JSON.stringify({ ...base, models: { ...base.models, review: { baseURL: 'codex://bedrock', model: 'x', api: 'codex', reasoningEffort: 'minimal' } } }));
    assert.throws(() => loadConfig(path), /native Codex CLI reasoningEffort must be low/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pinning the review model drops the small and medium tiers unless they are pinned too', () => {
  const cfg = config({ reviewSmall: http('s'), reviewMedium: http('m') });
  const pinned = applyModelOverrides(cfg, extractModelOverrideArgs(['--review-model', 'opus']));
  assert.equal(pinned.models.reviewSmall, undefined);
  assert.equal(pinned.models.reviewMedium, undefined);
  const both = applyModelOverrides(cfg, extractModelOverrideArgs(['--review-model', 'opus', '--review-medium-model', 'codex']));
  assert.equal(both.models.reviewMedium?.api, 'codex');
  assert.equal(both.models.reviewMedium?.awsRegion, 'us-east-1');
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

test('the signed footer and the check summary do not name the model that reviewed', () => {
  const signed = signReviewBody('finding');
  assert.equal(signed, '<!-- revuto-signed -->\n*This is an auto review done by [revuto](https://github.com/avifenesh/revuto).*\n\n---\n\nfinding');
  assert.equal(signReviewBody(signed), signed, 'already signed bodies are left alone');
  const outcome: ReviewOutcome = {
    terminal: 'skip_review', hasFindings: false, result: 'clean', headSha: 'a'.repeat(40), steps: 3, tokens: 10,
    inspections: 4, toolErrors: 0, postFailures: 0, forcedTerminal: false, ranModel: true, model: 'claude-cli-sonnet-5',
  };
  const result = checkResultForOutcome(outcome);
  assert.equal(result.conclusion, 'success');
  assert.doesNotMatch(result.summary, /claude-cli-sonnet-5|Reviewed by/);
  assert.deepEqual(checkResultForOutcome({ ...outcome, model: undefined }), result);
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
    assert.throws(() => loadConfig(path), /only for models\.review, models\.reviewSmall and models\.reviewMedium/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pinned --review-model reviews every PR; --review-small-model pins the small reviewer', () => {
  const cfg = config({ reviewSmall: http('small-model', 'sonnet') });
  const pinned = applyModelOverrides(cfg, extractModelOverrideArgs(['review', 'o/r', '1', '--review-model', 'grok']));
  assert.equal(pinned.models.reviewSmall, undefined, 'the vault small reviewer steps aside');
  assert.equal(pinned.models.review.name, 'grok-code');
  assert.equal(chooseReviewModel(pinned, { fileList: ['README.md'], additions: 1, deletions: 0 }).label, 'grok-code');
  const both = applyModelOverrides(cfg, extractModelOverrideArgs(['--review-model', 'grok', '--review-small-model=grok', 'daemon']));
  assert.equal(both.models.reviewSmall?.name, 'grok-code');
  const viaModel = applyModelOverrides(cfg, extractModelOverrideArgs(['--model', 'reviewsmall=grok']));
  assert.equal(viaModel.models.reviewSmall?.name, 'grok-code');
  assert.equal(viaModel.models.review, cfg.models.review, 'review untouched when only the small role is pinned');
  assert.throws(() => extractModelOverrideArgs(['--model', 'tiny=grok']), /reviewSmall/);
});
