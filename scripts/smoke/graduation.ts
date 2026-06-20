/**
 * Deterministic Phase 2 smoke: store + 4x reinforcement + graduation + area-glob
 * skill selection. No LLM or embedder required. (SQLite backend.)
 *
 *   npx tsx scripts/smoke/graduation.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../../agents/common/src/store/sqlite-store.js';
import { graduate } from '../../agents/curator/src/tools/submit-skill.js';
import { selectSkills } from '../../agents/common/src/skills/select.js';

const vault = mkdtempSync(join(tmpdir(), 'reviewer-vault-'));
const store = new SqliteStore(vault, 'octo/demo');

// 1. create + reinforce to the graduation threshold (4)
const rec = await store.createConcern({
  areaBucket: 'src',
  area: ['src/cluster/**'],
  subject: 'reconnect backoff in cluster client',
  concern: 'Ensure exponential backoff caps; unbounded retries flooded the cluster bus before.',
  context: 'Regression seen when a node flapped during failover.',
});
assert.equal(rec.reinforcementCount, 1, 'starts at 1');
let last = rec;
for (let i = 0; i < 3; i++) last = (await store.bumpConcern(rec.recordId))!;
assert.equal(last.reinforcementCount, 4, 'reinforced to 4');

// 2. graduate -> draft skill note + source concern removed
const note = await graduate(store, {
  subject: 'cluster reconnect backoff',
  description: 'Use when reviewing PRs that touch src/cluster reconnect/backoff logic.',
  skillMd: '## Use when\nA PR changes cluster client reconnect or backoff.\n\n## Patterns\n### Unbounded retry\nSkip unless: the diff touches the reconnect loop.',
  sourceRecordId: rec.recordId,
});
assert.equal(note.status, 'draft', 'graduates as draft');
assert.deepEqual(note.area, ['src/cluster/**'], 'inherits source area globs');
assert.equal(await store.getConcern(rec.recordId), null, 'source concern deleted after graduation');
assert.ok(existsSync(join(vault, 'skills', 'octo__demo', `${note.slug}.md`)), 'skill note file written');

// 3. draft skills are not selected; active skills are (area-glob, no embedder)
assert.equal(await selectSkills(store, null, ['src/cluster/foo.c']), '', 'draft skill not loaded');
assert.equal(await store.setSkillStatus(note.slug, 'active'), true, 'approve flips to active');
assert.ok((await selectSkills(store, null, ['src/cluster/foo.c'])).includes(note.slug), 'active skill selected for matching file');
assert.equal(await selectSkills(store, null, ['docs/readme.md']), '', 'skill not selected for non-matching file');

// 3b. auto-activate writes active skills directly.
const rec2 = await store.createConcern({
  areaBucket: 'src',
  area: ['src/cache/**'],
  subject: 'cache eviction ordering',
  concern: 'Preserve eviction ordering invariants when touching cache cleanup.',
  context: '',
});
const activeNote = await graduate(store, {
  subject: 'cache eviction ordering',
  description: 'Use when reviewing PRs that touch src/cache eviction cleanup.',
  skillMd: '## Use when\nA PR changes cache eviction cleanup.\n\n## Patterns\n### Ordering drift\nSkip unless: cleanup ordering changes.',
  sourceRecordId: rec2.recordId,
  status: 'active',
});
assert.equal(activeNote.status, 'active', 'auto-activate graduates active');

// 4. cursors + idempotency
await store.setCursor('review', '2026-05-21T00:00:00Z');
assert.equal(await store.getCursor('review'), '2026-05-21T00:00:00Z', 'cursor round-trip');
assert.equal(await store.seen('octo/demo#1@abc'), false);
await store.mark('octo/demo#1@abc');
assert.equal(await store.seen('octo/demo#1@abc'), true, 'idempotency mark/seen');

// 5. daily counters (the limit-enforcement primitive)
assert.equal(await store.getCounter('reviews:2026-05-21'), 0, 'absent counter is 0');
assert.equal(await store.incrCounter('reviews:2026-05-21'), 1, 'counter starts at 1');
assert.equal(await store.incrCounter('tokens:2026-05-21', 500), 500, 'counter adds by N');
assert.equal(await store.incrCounter('tokens:2026-05-21', 250), 750, 'counter accumulates');
assert.equal(await store.getCounter('tokens:2026-05-21'), 750, 'getCounter reads total');

await store.close();
console.log('PASS: store + 4x graduation + draft-gate + area-glob selection + cursors + counters');
