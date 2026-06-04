import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, resolveConfigPath, type ModelSpec, type ReviewerConfig } from '../../../../agents/common/src/config.js';
import { runModelProbes } from '../../../../daemon/src/doctor.js';
import { effectiveSchedules, listReviewers } from '../../../../daemon/src/reviewers.js';
import type {
  DashboardSnapshot,
  JobEvent,
  LogLine,
  ModelStatus,
  ProcessStatus,
  ReviewerStatus,
  ServiceStatus,
  UnitKind
} from '../types.js';

const execFileAsync = promisify(execFile);

type ModelRole = ModelStatus['role'];
type ProbeStatus = ModelStatus['probe'];
type ProbeCache = {
  key: string;
  expiresAt: number;
  checkedAt: string;
  probesByRole: Map<ModelRole, ProbeStatus>;
};

const UNITS: Array<{ id: string; label: string; kind: UnitKind }> = [
  { id: 'revuto.service', label: 'Revuto daemon', kind: 'service' },
  { id: 'revuto-surreal.service', label: 'SurrealDB', kind: 'service' },
  { id: 'revuto-embedder.service', label: 'Embedder', kind: 'service' },
  { id: 'revuto-guard.timer', label: 'Guard timer', kind: 'timer' }
];
const JOB_HISTORY_LIMIT = 180;
const LOG_HISTORY_LIMIT = 140;
const MODEL_PROBE_TTL_MS = Number(process.env.REVUTO_DASHBOARD_PROBE_TTL_MS ?? 60_000);

let modelProbeCache: ProbeCache | null = null;
let modelProbeInFlight: { key: string; promise: Promise<ProbeCache> } | null = null;

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[], timeoutMs = 8_000): Promise<CommandResult> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === null ? undefined : `/run/user/${uid}`);
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      env: {
        ...process.env,
        ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? (runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined),
        SYSTEMD_PAGER: ''
      },
      timeout: timeoutMs,
      maxBuffer: 5_000_000
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message
    };
  }
}

function parseKeyValues(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function blankToNull(value: string | undefined): string | null {
  return value && value.trim() ? value : null;
}

function parsePid(value: string | undefined): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readServices(): Promise<ServiceStatus[]> {
  const res = await run('systemctl', [
    '--user',
    'show',
    ...UNITS.map((unit) => unit.id),
    '-p',
    'Id',
    '-p',
    'ActiveState',
    '-p',
    'SubState',
    '-p',
    'MainPID',
    '-p',
    'ActiveEnterTimestamp',
    '-p',
    'FragmentPath',
    '-p',
    'NextElapseUSecRealtime',
    '-p',
    'LastTriggerUSec',
    '-p',
    'UnitFileState',
    '--no-pager'
  ]);

  const blocks = res.stdout.trim().split(/\n\s*\n/).filter(Boolean).map(parseKeyValues);
  const byId = new Map(blocks.map((block) => [block.Id, block]));

  return UNITS.map((unit) => {
    const row = byId.get(unit.id);
    return {
      id: unit.id,
      label: unit.label,
      kind: unit.kind,
      activeState: row?.ActiveState ?? 'unknown',
      subState: row?.SubState ?? 'unknown',
      mainPid: parsePid(row?.MainPID),
      since: blankToNull(row?.ActiveEnterTimestamp),
      fragmentPath: blankToNull(row?.FragmentPath),
      unitFileState: blankToNull(row?.UnitFileState),
      nextElapse: blankToNull(row?.NextElapseUSecRealtime),
      lastTrigger: blankToNull(row?.LastTriggerUSec)
    };
  });
}

function parseJsonResult(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeResult(result: Record<string, unknown> | null, fallback: string): string {
  if (!result) return fallback.trim();
  const interesting = ['reviewed', 'skipped', 'initialized', 'limited', 'curated', 'seen', 'deleted', 'decayed'];
  const parts = interesting
    .filter((key) => key in result)
    .map((key) => `${key}=${String(result[key])}`);
  return parts.length ? parts.join(' / ') : JSON.stringify(result);
}

function parseJournalLine(raw: string): LogLine {
  const match = raw.match(/^(\S+)\s+\S+\s+[^:]+:\s+(.*)$/);
  const message = match?.[2] ?? raw;
  const lower = message.toLowerCase();
  const level = lower.includes('failed') || lower.includes('error') || lower.includes('fail')
    ? 'error'
    : lower.includes('warn') || lower.includes('limited') || /"skipped":(?!0)\d+/.test(lower)
      ? 'warn'
      : 'info';

  return {
    timestamp: match?.[1] ?? null,
    level,
    message,
    raw
  };
}

function parseJobEvent(raw: string): JobEvent | null {
  const log = parseJournalLine(raw);
  const match = log.message.match(/^\[(review|learn|decay)\]\s+(\S+)\s+(.+?)(?:\s+\((\d+)ms\))?$/);
  if (!match) return null;

  const resultText = match[3] ?? '';
  const failed = resultText.startsWith('failed:');
  const result = failed ? null : parseJsonResult(resultText);

  return {
    timestamp: log.timestamp ?? '',
    job: match[1] as JobEvent['job'],
    repo: match[2] ?? '',
    status: failed ? 'failed' : result ? 'ok' : 'unknown',
    durationMs: match[4] ? Number(match[4]) : null,
    result,
    summary: failed ? resultText.replace(/^failed:\s*/, '') : summarizeResult(result, resultText),
    raw
  };
}

async function readJournal(since: string): Promise<{ jobs: JobEvent[]; logs: LogLine[] }> {
  const res = await run('journalctl', [
    '--user',
    '-u',
    'revuto.service',
    '--since',
    since,
    '-o',
    'short-iso',
    '--no-pager',
    '-n',
    '3000'
  ], 10_000);

  const lines = res.stdout.split('\n').filter((line) => line.trim().length > 0);
  const daemonLines = lines.filter((line) => /\snode\[\d+\]:\s/.test(line));
  const jobs = daemonLines.map(parseJobEvent).filter((job): job is JobEvent => !!job).reverse().slice(0, JOB_HISTORY_LIMIT);
  const logs = daemonLines.map(parseJournalLine).reverse().slice(0, LOG_HISTORY_LIMIT);
  return { jobs, logs };
}

function safeProviderName(spec: ModelSpec): string {
  if (spec.name) return spec.name;
  try {
    return new URL(spec.baseURL).hostname;
  } catch {
    return spec.baseURL;
  }
}

function apiSurface(role: ModelRole, spec: ModelSpec): string {
  if (role === 'embedder') return 'embeddings';
  return spec.api ?? 'chat';
}

function isBedrockMantle(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.startsWith('bedrock-mantle.');
  } catch {
    return false;
  }
}

function configuredAuth(spec: ModelSpec): string {
  if (spec.auth) return spec.auth;
  if (spec.api === 'responses') return 'auto';
  if (spec.apiKeyEnv) return 'bearer';
  return 'none';
}

function authInfo(spec: ModelSpec): Pick<ModelStatus, 'auth' | 'effectiveAuth' | 'authDetail' | 'apiKeyAvailable'> {
  const auth = configuredAuth(spec);
  const apiKeyAvailable = spec.apiKeyEnv ? Boolean(process.env[spec.apiKeyEnv]) : null;
  const envDetail = spec.apiKeyEnv ? `${spec.apiKeyEnv} ${apiKeyAvailable ? 'set' : 'unset'}` : null;
  const regionDetail = spec.awsRegion ? `region ${spec.awsRegion}` : null;
  const detail = [envDetail, regionDetail].filter(Boolean).join(' / ') || null;

  if (auth === 'none') return { auth, effectiveAuth: 'none', authDetail: detail, apiKeyAvailable };
  if (auth === 'bearer') {
    return {
      auth,
      effectiveAuth: apiKeyAvailable === false ? 'bearer missing key' : 'bearer',
      authDetail: detail,
      apiKeyAvailable
    };
  }
  if (auth === 'aws') return { auth, effectiveAuth: 'aws sigv4', authDetail: detail, apiKeyAvailable };
  if (apiKeyAvailable) return { auth, effectiveAuth: 'bearer', authDetail: detail, apiKeyAvailable };
  if (spec.api === 'responses' && isBedrockMantle(spec.baseURL)) {
    return { auth, effectiveAuth: 'aws sigv4', authDetail: detail, apiKeyAvailable };
  }
  return { auth, effectiveAuth: 'none', authDetail: detail, apiKeyAvailable };
}

function disabledProbe(): ProbeStatus {
  return { state: 'disabled', kind: 'none', checkedAt: null, ms: null, error: null, sharedRoles: [] };
}

function unknownProbe(role: ModelRole): ProbeStatus {
  return { state: 'unknown', kind: role === 'embedder' ? 'embedding' : 'chat', checkedAt: null, ms: null, error: null, sharedRoles: [role] };
}

function modelStatus(role: ModelRole, spec: ModelSpec | null, probe?: ProbeStatus): ModelStatus {
  if (!spec) {
    return {
      role,
      enabled: false,
      name: 'disabled',
      api: 'none',
      model: 'none',
      baseURL: 'none',
      auth: 'none',
      effectiveAuth: 'none',
      authDetail: null,
      reasoningEffort: null,
      awsRegion: null,
      apiKeyEnv: null,
      apiKeyAvailable: null,
      probe: disabledProbe()
    };
  }

  const auth = authInfo(spec);
  return {
    role,
    enabled: true,
    name: safeProviderName(spec),
    api: apiSurface(role, spec),
    model: spec.model,
    baseURL: spec.baseURL,
    ...auth,
    reasoningEffort: spec.reasoningEffort ?? null,
    awsRegion: spec.awsRegion ?? null,
    apiKeyEnv: spec.apiKeyEnv ?? null,
    probe: probe ?? unknownProbe(role)
  };
}

function modelProbeKey(config: ReviewerConfig): string {
  const specs: Array<[ModelRole, ModelSpec | null]> = [
    ['review', config.models.review],
    ['curator', config.models.curator],
    ['distill', config.models.distill],
    ['embedder', config.models.embedder]
  ];
  return JSON.stringify(specs.map(([role, spec]) => spec
    ? {
        role,
        baseURL: spec.baseURL,
        model: spec.model,
        api: spec.api ?? null,
        auth: spec.auth ?? null,
        reasoningEffort: spec.reasoningEffort ?? null,
        awsRegion: spec.awsRegion ?? null,
        apiKeyEnv: spec.apiKeyEnv ?? null,
        apiKeyAvailable: spec.apiKeyEnv ? Boolean(process.env[spec.apiKeyEnv]) : null
      }
    : { role, disabled: true }));
}

function probeStatusesFromModelProbes(checkedAt: string, probes: Awaited<ReturnType<typeof runModelProbes>>): Map<ModelRole, ProbeStatus> {
  const out = new Map<ModelRole, ProbeStatus>();
  for (const probe of probes) {
    const sharedRoles = probe.roles as ModelRole[];
    for (const role of sharedRoles) {
      out.set(role, {
        state: probe.ok ? 'ok' : 'failed',
        kind: probe.kind,
        checkedAt,
        ms: probe.ms,
        error: probe.error ?? null,
        sharedRoles
      });
    }
  }
  return out;
}

function failedProbeStatuses(config: ReviewerConfig, checkedAt: string, error: string): Map<ModelRole, ProbeStatus> {
  const out = new Map<ModelRole, ProbeStatus>();
  for (const role of ['review', 'curator', 'distill'] as ModelRole[]) {
    out.set(role, { state: 'failed', kind: 'chat', checkedAt, ms: null, error, sharedRoles: [role] });
  }
  if (config.models.embedder) {
    out.set('embedder', { state: 'failed', kind: 'embedding', checkedAt, ms: null, error, sharedRoles: ['embedder'] });
  }
  return out;
}

async function buildModelProbeCache(config: ReviewerConfig, key: string): Promise<ProbeCache> {
  const checkedAt = new Date().toISOString();
  try {
    const probes = await runModelProbes(config);
    return {
      key,
      checkedAt,
      expiresAt: Date.now() + MODEL_PROBE_TTL_MS,
      probesByRole: probeStatusesFromModelProbes(checkedAt, probes)
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      key,
      checkedAt,
      expiresAt: Date.now() + MODEL_PROBE_TTL_MS,
      probesByRole: failedProbeStatuses(config, checkedAt, error)
    };
  }
}

async function readModelProbeStatuses(config: ReviewerConfig): Promise<Map<ModelRole, ProbeStatus>> {
  const key = modelProbeKey(config);
  const now = Date.now();
  if (modelProbeCache?.key === key && modelProbeCache.expiresAt > now) return modelProbeCache.probesByRole;
  if (modelProbeInFlight?.key === key) return (await modelProbeInFlight.promise).probesByRole;

  modelProbeInFlight = { key, promise: buildModelProbeCache(config, key) };
  try {
    modelProbeCache = await modelProbeInFlight.promise;
    return modelProbeCache.probesByRole;
  } finally {
    modelProbeInFlight = null;
  }
}

function reviewersFor(config: ReviewerConfig): ReviewerStatus[] {
  return listReviewers(config)
    .map((reviewer) => ({
      repo: reviewer.repo,
      paused: !!reviewer.paused,
      autoActivate: !!reviewer.autoActivate,
      authorAllowlist: reviewer.authorAllowlist ?? [],
      botLogin: reviewer.botLogin ?? null,
      schedules: effectiveSchedules(config, reviewer)
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

async function readProcesses(): Promise<ProcessStatus[]> {
  const res = await run('ps', ['-eo', 'pid=,etimes=,pcpu=,pmem=,args='], 5_000);
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\brevuto\b|llama-server|surreal/i.test(line))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ageSeconds: Number(match[2]),
        cpu: Number(match[3]),
        memory: Number(match[4]),
        command: match[5] ?? ''
      };
    })
    .filter((process): process is ProcessStatus => !!process)
    .slice(0, 16);
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const services = await readServices();
  const daemonSince = services.find((service) => service.id === 'revuto.service')?.since ?? '48 hours ago';

  let config: ReviewerConfig | null = null;
  let configError: string | null = null;
  let configPath: string | null = null;
  try {
    configPath = resolveConfigPath();
    config = loadConfig(configPath);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }

  const [journal, processes, modelProbes] = await Promise.all([
    readJournal(daemonSince),
    readProcesses(),
    config ? readModelProbeStatuses(config) : Promise.resolve(new Map<ModelRole, ProbeStatus>())
  ]);

  const reviewers = config ? reviewersFor(config) : [];
  const models = config
    ? [
        modelStatus('review', config.models.review, modelProbes.get('review')),
        modelStatus('curator', config.models.curator, modelProbes.get('curator')),
        modelStatus('distill', config.models.distill, modelProbes.get('distill')),
        modelStatus('embedder', config.models.embedder, modelProbes.get('embedder'))
      ]
    : [];

  return {
    generatedAt: new Date().toISOString(),
    configError,
    configPath,
    vaultPath: config?.vaultPath ?? null,
    workspaceDir: config?.review.workspaceDir ?? null,
    store: config
      ? {
          backend: config.store.backend,
          url: config.store.surreal.url,
          namespace: config.store.surreal.namespace
        }
      : null,
    schedules: config?.schedules ?? null,
    limits: config
      ? {
          maxSteps: config.review.maxSteps,
          maxOutputTokens: config.limits.maxOutputTokens,
          dailyReviews: config.limits.dailyReviews,
          dailyLearn: config.limits.dailyLearn,
          dailyTokens: config.limits.dailyTokens
        }
      : null,
    counts: {
      servicesActive: services.filter((service) => service.activeState === 'active').length,
      servicesTotal: services.length,
      reviewers: reviewers.length,
      pausedReviewers: reviewers.filter((reviewer) => reviewer.paused).length,
      recentJobs: journal.jobs.length,
      recentFailures: journal.jobs.filter((job) => job.status === 'failed').length
    },
    services,
    models,
    reviewers,
    jobs: journal.jobs,
    logs: journal.logs,
    processes
  };
}
