import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Octokit } from '@octokit/rest';
import { loadConfig, type ReviewerConfig } from '../agents/common/src/config.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';
import { createWebhookHealthCheck, runWebhookRepair } from '../daemon/src/webhook-health.js';

const config = {
  github: { app: {
    appId: 1234, allowedOwners: ['octo'], ignoredRepos: ['octo/ignored'],
    webhookRepairCommand: [['tailscale', 'funnel', '--https=8443', 'off'], ['tailscale', 'funnel', '--bg', '--https=8443']],
  } },
} as unknown as ReviewerConfig;

function delivery(id: number, status_code = 500, extra: Record<string, unknown> = {}) {
  return {
    id, guid: `guid-${id}`, delivered_at: new Date(id * 1000).toISOString(),
    status_code, status: status_code === 202 ? 'Accepted' : 'failed to connect',
    event: 'pull_request', action: 'synchronize', ...extra,
  };
}

function fixture() {
  let recent = [delivery(3), delivery(2), delivery(1)];
  let history: ReturnType<typeof delivery>[] | undefined;
  const payloads = new Map<number, unknown>();
  const repairs: readonly string[][] = [];
  const redeliveries: number[] = [];
  const repos: string[] = [];
  const logs: string[] = [];
  let rejectRepair = false;
  let rejectRedelivery = false;
  let rejectDemo = false;
  let beforeList: (() => Promise<void>) | undefined;
  const client = {
    apps: {
      listWebhookDeliveries: async () => { await beforeList?.(); return { data: recent }; },
      getWebhookDelivery: async ({ delivery_id }: { delivery_id: number }) => ({
        data: { request: { payload: payloads.get(delivery_id) ?? null, headers: { authorization: 'secret-header' } } },
      }),
      redeliverWebhookDelivery: async ({ delivery_id }: { delivery_id: number }) => {
        if (rejectRedelivery) throw new Error('secret-redelivery');
        redeliveries.push(delivery_id);
      },
    },
    paginate: async () => history ?? recent,
  } as unknown as Octokit;
  const check = createWebhookHealthCheck(config, {
    appClient: () => client,
    repos: () => ['octo/demo', 'octo/other', 'octo/ignored', 'outsider/repo'],
    authForRepo: async (_app, repo) => {
      repos.push(repo);
      if (rejectDemo && repo === 'octo/demo') throw new Error('secret-repository-error');
      return { octokit: {
        pulls: { list: () => {} },
        paginate: async () => repo === 'octo/demo'
          ? [{ number: 1, head: { sha: 'head-1' } }, { number: 2, head: { sha: 'head-2' } }]
          : [{ number: 3, head: { sha: 'head-3' } }],
      } } as unknown as GithubAuth;
    },
    repair: async (argv) => {
      (repairs as string[][]).push([...argv]);
      if (rejectRepair) throw new Error('secret-repair-output');
    },
    log: (message) => logs.push(message),
  });
  const payload = (id: number, repo: string, number: number, sha: string) => payloads.set(id, {
    repository: { full_name: repo }, number, pull_request: { head: { sha } }, secret: 'secret-payload',
  });
  return {
    check, repairs, redeliveries, repos, logs, payload,
    recent: (value: ReturnType<typeof delivery>[]) => { recent = value; },
    history: (value: ReturnType<typeof delivery>[]) => { history = value; },
    rejectRepair: (value: boolean) => { rejectRepair = value; },
    rejectRedelivery: (value: boolean) => { rejectRedelivery = value; },
    rejectDemo: (value: boolean) => { rejectDemo = value; },
    beforeList: (value: () => Promise<void>) => { beforeList = value; },
  };
}

test('consecutive failed deliveries trigger ordered repair once, never catch-up before GitHub succeeds', async () => {
  const f = fixture();
  f.recent([delivery(1), delivery(3, 0), delivery(2)]);
  await f.check();
  await f.check();
  assert.deepEqual(f.repairs, config.github.app!.webhookRepairCommand);
  assert.equal(f.redeliveries.length, 0);
  assert.equal(f.repos.length, 0);
  assert.ok(f.logs.some((line) => /ALERT: newest 3/.test(line)));
  assert.ok(f.logs.some((line) => /waiting for a successful/.test(line)));
});

test('failure threshold is configurable and a transient failure or pending delivery does not repair', async () => {
  const f = fixture();
  f.recent([delivery(3), delivery(2, 202), delivery(1)]);
  await f.check();
  f.recent([delivery(3, 0, { status: 'Pending' }), delivery(2), delivery(1)]);
  await f.check();
  assert.deepEqual(f.repairs, []);
  const repairs: string[][] = [];
  const check = createWebhookHealthCheck({
    github: { app: { ...config.github.app!, webhookFailureThreshold: 1, webhookRepairCommand: ['repair', '--once'] } },
  } as unknown as ReviewerConfig, {
    appClient: () => ({ apps: { listWebhookDeliveries: async () => ({ data: [delivery(1)] }) } }) as unknown as Octokit,
    repair: async (argv) => { repairs.push([...argv]); }, log: () => {},
  });
  await check();
  assert.deepEqual(repairs, [['repair', '--once']]);
});

test('recovery paginates history and replays only the newest failed matching head per registered open PR', async () => {
  const f = fixture();
  await f.check();
  f.recent([delivery(100, 202)]);
  f.history([
    delivery(40, 500, { action: 'reopened' }), delivery(20), delivery(11), delivery(10), delivery(9),
    delivery(8), delivery(7), delivery(6), delivery(5, 500, { action: 'closed' }),
    delivery(4, 500, { event: 'push' }), delivery(3), delivery(2), delivery(1), delivery(100, 202),
  ]);
  f.payload(40, 'octo/other', 3, 'head-3');
  f.payload(20, 'octo/demo', 1, 'obsolete');
  f.payload(11, 'octo/demo', 1, 'head-1');
  f.payload(10, 'octo/demo', 1, 'head-1');
  f.payload(9, 'octo/demo', 2, 'head-2');
  f.payload(8, 'octo/demo', 4, 'closed-pr-head');
  f.payload(7, 'unregistered/repo', 5, 'head');
  f.payload(6, 'octo/ignored', 6, 'head');
  f.payload(3, 'octo/demo', 2, 'old-head');
  await f.check();
  assert.deepEqual(f.redeliveries, [40, 11, 9]);
  assert.deepEqual(f.repos, ['octo/demo', 'octo/other']);
  await f.check();
  assert.deepEqual(f.redeliveries, [40, 11, 9]);
  // A later unrelated success must not cause an older event for that PR to replay.
  f.recent([delivery(101, 202)]);
  await f.check();
  assert.deepEqual(f.redeliveries, [40, 11, 9]);
  assert.doesNotMatch(f.logs.join('\n'), /secret|tailscale/);
});

test('restart catches up after recovery and skips events with a successful redelivery GUID', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20), delivery(10), delivery(9)]);
  f.history([delivery(50, 202), delivery(21, 202, { guid: 'guid-20' }), delivery(20), delivery(19), delivery(10), delivery(9)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.payload(19, 'octo/demo', 1, 'head-1');
  f.payload(10, 'octo/demo', 2, 'head-2');
  f.payload(9, 'octo/demo', 2, 'head-2');
  await f.check();
  assert.deepEqual(f.repairs, []);
  assert.deepEqual(f.redeliveries, [10]);
});

test('repair and redelivery failures retry without exposing exception secrets', async () => {
  const f = fixture();
  f.rejectRepair(true);
  await f.check();
  f.rejectRepair(false);
  await f.check();
  assert.equal(f.repairs.length, 3);
  f.recent([delivery(50, 202), delivery(10)]);
  f.payload(10, 'octo/demo', 1, 'head-1');
  f.rejectRedelivery(true);
  await f.check();
  f.rejectRedelivery(false);
  await f.check();
  assert.deepEqual(f.redeliveries, [10]);
  assert.doesNotMatch(f.logs.join('\n'), /secret/);
});

test('an asynchronous replay failure retries after recovery without needing a newer successful event', async () => {
  const f = fixture();
  await f.check();
  f.recent([delivery(50, 202), delivery(20), delivery(10)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.payload(10, 'octo/demo', 2, 'head-2');
  await f.check();
  assert.deepEqual(f.redeliveries, [20, 10]);
  // One accepted replay succeeds, then the other completes with a failure.
  // Also cover APIs updating the same delivery ID with a new attempt time.
  f.recent([
    delivery(10, 500, { delivered_at: new Date(61_000).toISOString() }),
    delivery(60, 202, { guid: 'guid-20' }), delivery(50, 202), delivery(20),
  ]);
  await f.check();
  assert.deepEqual(f.redeliveries, [20, 10, 10]);
  await f.check();
  assert.deepEqual(f.redeliveries, [20, 10, 10]);
});

test('a slow health check never overlaps another tick and no-App configurations are inert', async () => {
  const f = fixture();
  let release!: () => void;
  f.beforeList(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = f.check();
  await f.check();
  assert.equal(f.repairs.length, 0);
  release();
  await first;
  assert.equal(f.repairs.length, 2);
  await createWebhookHealthCheck({ github: {} } as ReviewerConfig, {
    appClient: () => { throw new Error('must not authenticate'); },
  })();
});

test('a repository API failure does not prevent another repository catching up and retries next tick', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20), delivery(10), delivery(9)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.payload(10, 'octo/other', 3, 'head-3');
  f.payload(9, 'octo/other', 3, 'head-3');
  f.rejectDemo(true);
  await f.check();
  assert.deepEqual(f.redeliveries, [10]);
  f.rejectDemo(false);
  await f.check();
  assert.deepEqual(f.redeliveries, [10, 20]);
  assert.doesNotMatch(f.logs.join('\n'), /secret/);
});

test('alerting works without a repair command and API error details are never logged', async () => {
  const logs: string[] = [];
  let reject = false;
  const check = createWebhookHealthCheck({
    github: { app: { appId: 1234, allowedOwners: [] } },
  } as unknown as ReviewerConfig, {
    appClient: () => ({ apps: {
      listWebhookDeliveries: async () => {
        if (reject) throw new Error('secret-api-headers');
        return { data: [delivery(3), delivery(2), delivery(1)] };
      },
    } }) as unknown as Octokit,
    repair: async () => { throw new Error('must not repair'); },
    log: (message) => logs.push(message),
  });
  await check();
  assert.match(logs[0], /ALERT/);
  reject = true;
  await check();
  assert.match(logs[1], /will retry/);
  assert.doesNotMatch(logs.join('\n'), /secret/);
});

test('repair argv stays literal without a shell and child output is discarded', async () => {
  const root = join(homedir(), '.cache');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'revuto-repair-test-'));
  try {
    const output = join(dir, 'argv.json');
    const script = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); console.log("secret-output")';
    const args = ['$(echo secret)', 'a; echo secret', '`echo secret`', 'a b'];
    await runWebhookRepair([process.execPath, '-e', script, output, ...args]);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), args);
    const probe = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { runWebhookRepair } = await import(process.env.REVUTO_TEST_REPAIR_MODULE);
      await runWebhookRepair([process.execPath, '-e', 'console.log("secret-output"); console.error("secret-error")']);
    `], {
      env: { ...process.env, REVUTO_TEST_REPAIR_MODULE: new URL('../daemon/src/webhook-health.ts', import.meta.url).href },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, '');
    assert.equal(probe.stderr, '');
    await assert.rejects(runWebhookRepair([process.execPath, '-e', 'console.error("secret"); process.exit(1)']), /^Error: webhook repair failed or timed out$/);
    await assert.rejects(runWebhookRepair([join(dir, 'missing')]), /^Error: webhook repair could not start$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timed-out repair kills its process group, including wrapper descendants', { skip: process.platform !== 'linux' }, async () => {
  const root = join(homedir(), '.cache');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'revuto-repair-timeout-test-'));
  let descendant: number | undefined;
  try {
    const pidFile = join(dir, 'pid');
    const script = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `;
    await assert.rejects(runWebhookRepair([process.execPath, '-e', script, pidFile], 500), /timed out/);
    descendant = Number(readFileSync(pidFile, 'utf8'));
    const running = () => {
      try { return !/\) Z /.test(readFileSync(`/proc/${descendant}/stat`, 'utf8')); }
      catch { return false; }
    };
    const deadline = Date.now() + 2000;
    while (running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(running(), false);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config validates argv shapes and health settings without echoing supplied values', () => {
  const root = join(homedir(), '.cache');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'revuto-health-config-test-'));
  try {
    const file = join(dir, 'config.json');
    const model = { baseURL: 'http://example.test/v1', model: 'test' };
    const load = (app: Record<string, unknown>) => {
      writeFileSync(file, JSON.stringify({
        github: { app: { appId: 1234, privateKeyPath: 'unused.pem', ...app } },
        models: { review: model, curator: model, distill: model },
      }));
      return loadConfig(file).github.app!;
    };
    assert.equal(load({}).webhookFailureThreshold, 3);
    assert.equal(load({}).webhookHealthIntervalMinutes, 3);
    assert.deepEqual(load({ webhookRepairCommand: ['repair', ''] }).webhookRepairCommand, ['repair', '']);
    assert.deepEqual(load({ webhookRepairCommand: [['first'], ['second', '--arg']] }).webhookRepairCommand, [['first'], ['second', '--arg']]);
    for (const invalid of ['secret-value', [], [''], [['ok'], []], ['ok', 2], ['ok', 'secret\0value']]) {
      assert.throws(() => load({ webhookRepairCommand: invalid }), (err: Error) => {
        assert.doesNotMatch(err.message, /secret-value|secret\0value/);
        return /webhookRepairCommand must be/.test(err.message);
      });
    }
    for (const value of [0, -1, 1.2, '3', 35792]) assert.throws(() => load({ webhookHealthIntervalMinutes: value }));
    for (const value of [0, -1, 101, 1.2, '3']) assert.throws(() => load({ webhookFailureThreshold: value }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
