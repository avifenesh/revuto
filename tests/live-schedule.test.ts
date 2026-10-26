import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewerConfig } from '../agents/common/src/config.js';
import { removeReviewer, setPaused, setSchedule, writeReviewer, type ReviewerSettings } from '../daemon/src/reviewers.js';
import { followRegistry, LiveSchedule, type SchedulerJobs } from '../daemon/src/scheduler.js';

function vault(): { cfg: ReviewerConfig; done: () => void } {
  const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache`, 'revuto-live-schedule-'));
  const cfg = {
    vaultPath: root,
    github: { tokenEnv: 'TEST_UNUSED' },
    schedules: { review: '*/30 * * * *', learn: '0 */6 * * *', decay: '0 3 * * *' },
  } as unknown as ReviewerConfig;
  return { cfg, done: () => rmSync(root, { recursive: true, force: true }) };
}

const noJobs: SchedulerJobs = { review: () => null, learn: () => null, decay: () => null };

test('the schedule follows add, pause, cron change and remove without a restart', () => {
  const { cfg, done } = vault();
  const schedule = new LiveSchedule(cfg, noJobs);
  try {
    writeReviewer(cfg, { repo: 'me/a' });
    assert.deepEqual(schedule.reconcile(), { added: ['me/a'], removed: [], changed: [] });
    writeReviewer(cfg, { repo: 'me/b' });
    assert.deepEqual(schedule.reconcile(), { added: ['me/b'], removed: [], changed: [] });
    // nothing changed: untouched repos keep their timers
    assert.deepEqual(schedule.reconcile(), { added: [], removed: [], changed: [] });
    assert.deepEqual(schedule.scheduled().sort(), ['me/a', 'me/b']);

    setPaused(cfg, 'me/a', true);
    assert.deepEqual(schedule.reconcile().changed, ['me/a']);
    assert.deepEqual(schedule.scheduled(), ['me/b']);
    setPaused(cfg, 'me/a', false);
    setSchedule(cfg, 'me/b', 'learn', '0 1 * * *');
    assert.deepEqual(schedule.reconcile().changed.sort(), ['me/a', 'me/b']);

    removeReviewer(cfg, 'me/b');
    assert.deepEqual(schedule.reconcile(), { added: [], removed: ['me/b'], changed: [] });
    assert.deepEqual(schedule.scheduled(), ['me/a']);
  } finally {
    schedule.stop();
    done();
  }
});

test('a fired job reads the settings on disk, not the ones from schedule time', async () => {
  const { cfg, done } = vault();
  const seen: ReviewerSettings[] = [];
  const schedule = new LiveSchedule(cfg, { ...noJobs, review: (_c, r) => { seen.push(r); return null; } });
  try {
    // every second, so the test sees one fire
    writeReviewer(cfg, { repo: 'me/a', schedules: { review: '* * * * * *' } });
    schedule.reconcile();
    writeReviewer(cfg, { repo: 'me/a', schedules: { review: '* * * * * *' }, authorAllowlist: ['someone'] });
    await new Promise((r) => setTimeout(r, 2200));
    assert.ok(seen.length > 0, 'the review job fired');
    assert.deepEqual(seen.at(-1)?.authorAllowlist, ['someone']);
  } finally {
    schedule.stop();
    done();
  }
});

test('followRegistry picks up a new repo from a file change', async () => {
  const { cfg, done } = vault();
  writeReviewer(cfg, { repo: 'me/a' });
  const schedule = new LiveSchedule(cfg, noJobs);
  schedule.reconcile();
  const stop = followRegistry(cfg, schedule);
  try {
    writeReviewer(cfg, { repo: 'me/new' });
    const deadline = Date.now() + 5000;
    while (!schedule.scheduled().includes('me/new') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(schedule.scheduled().sort(), ['me/a', 'me/new']);
  } finally {
    stop();
    schedule.stop();
    done();
  }
});
