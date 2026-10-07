import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Octokit } from '@octokit/rest';
import { loadConfig, type ReviewerConfig } from '../agents/common/src/config.js';
import { githubFetchWithDeadline, RepositoryNotInstalledError, type GithubAuth } from '../agents/common/src/github-auth.js';
import { createWebhookHealthCheck as createHealthCheck, runWebhookRepair, type WebhookHealthDependencies } from '../daemon/src/webhook-health.js';

const createWebhookHealthCheck = (cfg: ReviewerConfig, deps: WebhookHealthDependencies = {}) =>
  createHealthCheck(cfg, { now: () => 0, ...deps });

const config = {
  github: { app: {
    appId: 1234, allowedOwners: ['octo'], ignoredRepos: ['octo/ignored'],
    webhookRepairCommand: [['tailscale', 'funnel', '--https=8443', 'off'], ['tailscale', 'funnel', '--bg', '--https=8443']],
  } },
} as unknown as ReviewerConfig;

function delivery(id: number, status_code = 500, extra: Record<string, unknown> = {}) {
  return {
    id: String(id), guid: `guid-${id}`, delivered_at: new Date(id * 1000).toISOString(),
    status_code, status: status_code === 202 ? 'Accepted' : 'failed to connect',
    event: 'pull_request', action: 'synchronize', ...extra,
  };
}

function fixture(extraDeps: WebhookHealthDependencies = {}) {
  let recent = [delivery(3), delivery(2), delivery(1)];
  let history: ReturnType<typeof delivery>[] | undefined;
  const payloads = new Map<string, unknown>();
  const details: string[] = [];
  const repairs: readonly string[][] = [];
  const redeliveries: string[] = [];
  const repos: string[] = [];
  const logs: string[] = [];
  let rejectRepair = false;
  let rejectRedelivery = false;
  let rejectDemo = false;
  let demoNotInstalled = false;
  let metadataMissing = false;
  const gone = new Set<string>();
  const detailErrors = new Map<string, number>();
  const pages: string[] = [];
  let beforeList: (() => Promise<void>) | undefined;
  const getWebhookDelivery = async ({ delivery_id }: { delivery_id: string }) => {
    details.push(delivery_id);
    if (gone.has(delivery_id)) throw Object.assign(new Error('secret-expired-delivery'), { status: 404 });
    if (detailErrors.has(delivery_id)) throw Object.assign(new Error('secret-detail-error'), { status: detailErrors.get(delivery_id) });
    return { data: { request: { payload: payloads.get(delivery_id) ?? null, headers: { authorization: 'secret-header' } } } };
  };
  const redeliverWebhookDelivery = async ({ delivery_id }: { delivery_id: string }) => {
    if (rejectRedelivery) throw new Error('secret-redelivery');
    redeliveries.push(delivery_id);
    return { data: undefined };
  };
  const client = {
    apps: {
      listWebhookDeliveries: async ({ cursor }: { cursor?: string } = {}) => {
        pages.push(cursor ?? 'first');
        await beforeList?.();
        return {
          data: cursor ? history ?? recent : recent,
          headers: !cursor && history ? { link: '<https://api.github.com/app/hook/deliveries?cursor=history>; rel="next"' } : {},
        };
      },
      getWebhookDelivery,
      redeliverWebhookDelivery,
    },
    request: async (route: string) => {
      const match = route.match(/^(GET|POST) \/app\/hook\/deliveries\/(\d+)(?:\/attempts)?$/);
      assert.ok(match, 'exact string delivery ID in request path');
      return match[1] === 'GET' ? getWebhookDelivery({ delivery_id: match[2] }) : redeliverWebhookDelivery({ delivery_id: match[2] });
    },
    paginate: async () => history ?? recent,
  } as unknown as Octokit;
  const check = createWebhookHealthCheck(config, {
    appClient: () => client,
    repos: () => ['octo/demo', 'octo/other', 'octo/ignored', 'outsider/repo'],
    authForRepo: async (_app, repo) => {
      repos.push(repo);
      if (demoNotInstalled && repo === 'octo/demo') throw new RepositoryNotInstalledError();
      if (metadataMissing && repo === 'octo/demo') throw Object.assign(new Error('secret-App-metadata-error'), { status: 404 });
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
    ...extraDeps,
  });
  const payload = (id: number | string, repo: string, number: number, sha: string, draft = false) => payloads.set(String(id), {
    repository: { full_name: repo }, number, pull_request: { head: { sha }, draft }, secret: 'secret-payload',
  });
  return {
    check, repairs, redeliveries, repos, logs, payload, details, pages,
    recent: (value: ReturnType<typeof delivery>[]) => { recent = value; },
    history: (value: ReturnType<typeof delivery>[]) => { history = value; },
    rejectRepair: (value: boolean) => { rejectRepair = value; },
    rejectRedelivery: (value: boolean) => { rejectRedelivery = value; },
    rejectDemo: (value: boolean) => { rejectDemo = value; },
    demoNotInstalled: (value: boolean) => { demoNotInstalled = value; },
    metadataMissing: (value: boolean) => { metadataMissing = value; },
    gone: (id: number | string) => gone.add(String(id)),
    detailError: (id: number | string, code: number) => detailErrors.set(String(id), code),
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
  assert.deepEqual(f.redeliveries, [40, 11, 9].map(String));
  assert.deepEqual([...f.repos].sort(), ['octo/demo', 'octo/other']);
  await f.check();
  assert.deepEqual(f.redeliveries, [40, 11, 9].map(String));
  // A later unrelated success must not cause an older event for that PR to replay.
  f.recent([delivery(101, 202)]);
  await f.check();
  assert.deepEqual(f.redeliveries, [40, 11, 9].map(String));
  assert.doesNotMatch(f.logs.join('\n'), /secret|tailscale/);
});

test('restart catches up after recovery and skips events with a successful redelivery GUID', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20), delivery(10), delivery(9)]);
  f.history([delivery(50, 202), delivery(21, 202, { guid: 'guid-20' }), delivery(20), delivery(19), delivery(10), delivery(9)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.payload(19, 'octo/demo', 1, 'obsolete');
  f.payload(10, 'octo/demo', 2, 'head-2');
  f.payload(9, 'octo/demo', 2, 'head-2');
  await f.check();
  assert.deepEqual(f.repairs, []);
  assert.deepEqual(f.redeliveries, [10].map(String));
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
  assert.deepEqual(f.redeliveries, [10].map(String));
  assert.doesNotMatch(f.logs.join('\n'), /secret/);
});

test('an asynchronous replay failure retries after recovery without needing a newer successful event', async () => {
  const f = fixture();
  await f.check();
  f.recent([delivery(50, 202), delivery(20), delivery(10)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.payload(10, 'octo/demo', 2, 'head-2');
  await f.check();
  assert.deepEqual(f.redeliveries, [20, 10].map(String));
  // One accepted replay succeeds, then the other completes with a failure.
  // Also cover APIs updating the same delivery ID with a new attempt time.
  f.recent([
    delivery(10, 500, { delivered_at: new Date(61_000).toISOString() }),
    delivery(60, 202, { guid: 'guid-20' }), delivery(50, 202), delivery(20),
  ]);
  await f.check();
  assert.deepEqual(f.redeliveries, [20, 10, 10].map(String));
  await f.check();
  assert.deepEqual(f.redeliveries, [20, 10, 10].map(String));
});

test('a pending replay failure below an unchanged newest delivery is reconsidered across history pages', async () => {
  const f = fixture();
  f.recent([delivery(50, 202)]);
  f.history([delivery(50, 202), delivery(20)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  await f.check();
  assert.deepEqual(f.redeliveries, [20].map(String));
  f.history([delivery(50, 202), delivery(40, 0, { status: 'Pending', guid: 'guid-20' }), delivery(20)]);
  await f.check();
  assert.deepEqual(f.redeliveries, [20].map(String));
  f.payload(40, 'octo/demo', 1, 'head-1');
  f.history([delivery(50, 202), delivery(40, 0, { guid: 'guid-20' }), delivery(20)]);
  await f.check();
  assert.deepEqual(f.redeliveries, [20, 40].map(String));
});

test('a newer successful delivery with the same timestamp as the outage establishes recovery', async () => {
  const f = fixture();
  const timestamp = new Date(1000).toISOString();
  const failures = [delivery(1, 500, { delivered_at: timestamp }), delivery(3, 500, { delivered_at: timestamp }), delivery(2, 500, { delivered_at: timestamp })];
  f.recent(failures);
  await f.check();
  f.recent([delivery(4, 202, { delivered_at: timestamp }), ...failures]);
  f.payload(3, 'octo/demo', 1, 'head-1');
  await f.check();
  assert.deepEqual(f.redeliveries, [3].map(String));
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
  assert.deepEqual(f.redeliveries, [10].map(String));
  f.rejectDemo(false);
  await f.check();
  assert.deepEqual(f.redeliveries, [10, 20].map(String));
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
  assert.match(logs.at(-1)!, /will retry/);
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
    assert.deepEqual(load({}).webhookRepairEnvAllowlist, []);
    assert.deepEqual(load({ webhookRepairEnvAllowlist: ['REPAIR_SOCKET'] }).webhookRepairEnvAllowlist, ['REPAIR_SOCKET']);
    for (const invalid of ['secret-value', [''], ['REPAIR-SOCKET'], ['X=value'], [2]]) {
      assert.throws(() => load({ webhookRepairEnvAllowlist: invalid }), /webhookRepairEnvAllowlist must be/);
    }
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

test('raw delivery IDs above 2^53 stay strings through list, detail and redelivery URLs', async () => {
  const id = '9007199254740993';
  const paths: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === '/app/hook/deliveries') {
      return new Response(`[${JSON.stringify(delivery(50, 202))},{"id":${id},"guid":"lost","delivered_at":"1970-01-01T00:00:20Z","status_code":500,"status":"failed","event":"pull_request","action":"synchronize"}]`, {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === `/app/hook/deliveries/${id}`) {
      return new Response(`{"id":${id},"request":{"payload":{"repository":{"full_name":"octo/demo"},"number":1,"pull_request":{"head":{"sha":"head-1"},"draft":false}}}}`, {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === `/app/hook/deliveries/${id}/attempts`) return new Response(null, { status: 202 });
    throw new Error('unexpected fixture URL');
  };
  const client = new Octokit({ request: { fetch: githubFetchWithDeadline(fakeFetch) } });
  const listed = await client.apps.listWebhookDeliveries({ per_page: 100 });
  assert.equal(listed.data[1].id, id);
  const check = createWebhookHealthCheck(config, {
    appClient: () => client, repos: () => ['octo/demo'],
    authForRepo: async () => ({ octokit: {
      pulls: { list: () => {} }, paginate: async () => [{ number: 1, head: { sha: 'head-1' } }],
    } }) as unknown as GithubAuth,
    log: () => {},
  });
  await check();
  assert.ok(paths.includes(`GET /app/hook/deliveries/${id}`));
  assert.ok(paths.includes(`POST /app/hook/deliveries/${id}/attempts`));
});

test('delivery ID ties use integer ordering, and adjacent large repair IDs remain distinct', async () => {
  const f = fixture();
  const timestamp = new Date(1000).toISOString();
  f.recent([
    delivery(11, 202, { delivered_at: timestamp }),
    delivery(9, 500, { delivered_at: timestamp }),
    delivery(10, 500, { delivered_at: timestamp }),
  ]);
  f.payload(9, 'octo/demo', 1, 'head-1');
  f.payload(10, 'octo/demo', 1, 'head-1');
  await f.check();
  assert.deepEqual(f.redeliveries, ['10']);
  const outages = [delivery(1), delivery(2), delivery(3)];
  f.recent(outages.map((item) => ({ ...item, id: item.id === '3' ? '9007199254740992' : item.id })));
  await f.check();
  f.recent(outages.map((item) => ({ ...item, id: item.id === '3' ? '9007199254740993' : item.id })));
  await f.check();
  assert.equal(f.repairs.length, 4);
});

test('new unrelated successes do not refetch cached failed-delivery details', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  await f.check();
  f.recent([delivery(51, 202), delivery(50, 202), delivery(20)]);
  await f.check();
  assert.deepEqual(f.details, [20].map(String));
  assert.deepEqual(f.repos, ['octo/demo']);
});

test('polls with no unresolved candidates never list repository PRs', async () => {
  const f = fixture();
  f.recent([delivery(50, 202)]);
  await f.check();
  assert.deepEqual(f.repos, []);
  assert.deepEqual(f.details, []);
});

test('an installation 404 is cached, commits the scan and logs once', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.demoNotInstalled(true);
  await f.check();
  await f.check();
  f.recent([delivery(51, 202), delivery(50, 202), delivery(20)]);
  await f.check();
  assert.deepEqual(f.repos, ['octo/demo']);
  assert.equal(f.logs.filter((line) => /not installed/.test(line)).length, 1);
  assert.doesNotMatch(f.logs.join('\n'), /secret/);
});

test('incremental delivery paging stops at the previous scan instead of the retention tail', async () => {
  let tick = 0;
  const cursors: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get('cursor') ?? 'first';
    cursors.push(cursor);
    const pages = tick === 0
      ? { first: [delivery(30, 202)], second: [delivery(20, 202)], third: [delivery(10, 202)] }
      : { first: [delivery(31, 202), delivery(30, 202), delivery(29, 202)], second: [delivery(20, 202)], third: [delivery(10, 202)] };
    const next = cursor === 'first' ? 'second' : cursor === 'second' ? 'third' : undefined;
    return new Response(JSON.stringify(pages[cursor as keyof typeof pages]), { headers: {
      'content-type': 'application/json',
      ...(next ? { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=${next}>; rel="next"` } : {}),
    } });
  };
  const client = new Octokit({ request: { fetch: githubFetchWithDeadline(fakeFetch) } });
  const check = createWebhookHealthCheck(config, { appClient: () => client, repos: () => [], log: () => {} });
  await check();
  assert.deepEqual(cursors, ['first', 'second', 'third']);
  cursors.length = 0;
  tick++;
  await check();
  assert.deepEqual(cursors, ['first']);
});

test('catch-up replays ready_for_review and skips draft payloads', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20, 500, { action: 'ready_for_review' }), delivery(10, 500, { action: 'opened' })]);
  f.payload(20, 'octo/demo', 1, 'head-1', false);
  f.payload(10, 'octo/demo', 2, 'head-2', true);
  await f.check();
  assert.deepEqual(f.redeliveries, [20].map(String));
});

test('repair inherits only PATH, HOME and configured environment names', async () => {
  const root = join(homedir(), '.cache');
  const dir = mkdtempSync(join(root, 'revuto-repair-env-test-'));
  process.env.REVUTO_REPAIR_ALLOWED = 'fixture-allowed';
  process.env.REVUTO_REPAIR_SECRET = 'fixture-secret';
  try {
    const output = join(dir, 'keys.json');
    const check = createWebhookHealthCheck({
      github: { app: {
        ...config.github.app!, webhookRepairEnvAllowlist: ['REVUTO_REPAIR_ALLOWED'],
        webhookRepairCommand: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(Object.keys(process.env)))', output],
      } },
    } as unknown as ReviewerConfig, {
      appClient: () => ({ apps: { listWebhookDeliveries: async () => ({ data: [delivery(3), delivery(2), delivery(1)] }) } }) as unknown as Octokit,
      log: () => {},
    });
    await check();
    const keys = JSON.parse(readFileSync(output, 'utf8')) as string[];
    assert.ok(keys.includes('PATH'));
    assert.ok(keys.includes('HOME'));
    assert.ok(keys.includes('REVUTO_REPAIR_ALLOWED'));
    assert.ok(keys.every((key) => ['PATH', 'HOME', 'REVUTO_REPAIR_ALLOWED'].includes(key)));
  } finally {
    delete process.env.REVUTO_REPAIR_ALLOWED;
    delete process.env.REVUTO_REPAIR_SECRET;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client-side failures alert individually but never trigger ingress repair', async () => {
  for (const code of [301, 401, 403, 404]) {
    const f = fixture();
    f.recent([delivery(3, code), delivery(2, code), delivery(1, code)]);
    await f.check();
    assert.deepEqual(f.repairs, []);
    for (const id of [1, 2, 3]) assert.ok(f.logs.some((line) => line.includes(`delivery=${id}`) && /ALERT/.test(line)));
  }
});

test('a single failed delivery alerts even below the repair threshold', async () => {
  const f = fixture();
  f.recent([delivery(3), delivery(2, 202), delivery(1, 202)]);
  await f.check();
  assert.deepEqual(f.repairs, []);
  assert.ok(f.logs.some((line) => /ALERT.*delivery=3/.test(line)));
});

test('recovery evidence survives pruning before a pending replay fails', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  await f.check();
  f.recent([delivery(60), delivery(55, 202, { guid: 'guid-20' }), delivery(50, 202)]);
  f.payload(60, 'octo/demo', 2, 'head-2');
  await f.check();
  f.recent([delivery(80, 0, { status: 'Pending', guid: 'guid-60' }), delivery(60)]);
  await f.check();
  f.recent([delivery(80, 0, { guid: 'guid-60' }), delivery(60)]);
  await f.check();
  assert.deepEqual(f.redeliveries, ['20', '60', '80']);
});

test('an expired delivery detail is retired once and cannot poison other candidates', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(40), delivery(30)]);
  f.payload(40, 'octo/demo', 1, 'head-1');
  f.gone(30);
  await f.check();
  assert.deepEqual(f.redeliveries, ['40']);
  f.recent([delivery(50, 202), delivery(40)]);
  await f.check();
  await f.check();
  assert.equal(f.details.filter((id) => id === '30').length, 1);
  assert.doesNotMatch(f.logs.join('\n'), /secret/);
});

test('App metadata 404s remain retryable instead of being classified as not installed', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.metadataMissing(true);
  await f.check();
  f.metadataMissing(false);
  await f.check();
  assert.deepEqual(f.redeliveries, ['20']);
  assert.deepEqual(f.repos, ['octo/demo', 'octo/demo']);
  assert.equal(f.logs.filter((line) => /not installed/.test(line)).length, 0);
});

test('new candidate deliveries revalidate a prior installation 404 with the same installation ID', async () => {
  const f = fixture();
  f.recent([delivery(50, 202), delivery(20, 500, { installation_id: 17 })]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  f.demoNotInstalled(true);
  await f.check();
  f.demoNotInstalled(false);
  f.recent([delivery(60, 500, { installation_id: 17 }), delivery(50, 202)]);
  f.payload(60, 'octo/demo', 1, 'head-1');
  await f.check();
  assert.deepEqual(f.redeliveries, ['60']);
  assert.deepEqual(f.repos, ['octo/demo', 'octo/demo']);
  assert.equal(f.logs.filter((line) => /not installed/.test(line)).length, 1);
});

test('routing and GUID caches expire after the GitHub delivery retention window', async () => {
  let now = 0;
  const f = fixture({ now: () => now });
  f.recent([delivery(50, 202), delivery(20)]);
  f.payload(20, 'octo/demo', 1, 'head-1');
  await f.check();
  now = 3 * 24 * 60 * 60_000 + 60_000;
  f.recent([
    delivery(100, 202, { delivered_at: new Date(now).toISOString() }),
    delivery(101, 500, { guid: 'guid-20', delivered_at: new Date(now - 1).toISOString() }),
  ]);
  f.payload(101, 'octo/demo', 1, 'head-1');
  await f.check();
  assert.deepEqual(f.details, ['20', '101']);
  assert.deepEqual(f.redeliveries, ['20', '101']);
});

test('a successful GUID clears detail retry state and advances the paging boundary', async () => {
  const f = fixture();
  f.recent([delivery(50, 202)]);
  f.history([delivery(20)]);
  f.detailError(20, 503);
  await f.check();
  f.history([delivery(40, 202, { guid: 'guid-20' }), delivery(20)]);
  await f.check();
  f.pages.length = 0;
  await f.check();
  await f.check();
  assert.deepEqual(f.pages, ['first', 'first']);
  assert.deepEqual(f.details, ['20']);
});

test('attempt histories expire by their own time even when the same delivery ID keeps updating', async () => {
  let now = 0;
  const sizes: Array<{ attempts: number; failures: number }> = [];
  const f = fixture({ now: () => now, onCacheStats: (stats) => sizes.push(stats) });
  f.payload(20, 'octo/demo', 1, 'head-1');
  for (let day = 0; day < 10; day++) {
    now = day * 24 * 60 * 60_000;
    f.recent([
      delivery(100 + day, 202, { delivered_at: new Date(now).toISOString() }),
      delivery(20, 500, { delivered_at: new Date(now - 1).toISOString() }),
    ]);
    await f.check();
  }
  assert.equal(f.redeliveries.length, 10);
  assert.deepEqual(f.details, ['20']);
  assert.ok(sizes.at(-1)!.attempts <= 4);
  assert.ok(sizes.at(-1)!.failures <= 4);
});
