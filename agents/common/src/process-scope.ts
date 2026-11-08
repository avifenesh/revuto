/**
 * Every process a review run starts ends with the run.
 *
 * A native reviewer CLI runs commands the model chooses, and a CLI may start them
 * in a session of their own: Codex's sandbox helper runs as a session leader. Such
 * a process leaves the process group revuto spawned the CLI in, so a group kill
 * misses it, and when the CLI exits it is reparented and keeps running.
 *
 * On Linux with a systemd user manager each process revuto starts for a run is
 * placed in its own transient scope unit, a cgroup. The kernel keeps every
 * descendant in that cgroup whatever it does with sessions, process groups or
 * parents. When the run ends revuto signals the whole scope, SIGTERM and then
 * SIGKILL after the grace, until the cgroup is empty. It signals with
 * `systemctl kill` rather than queueing a stop job: while the daemon itself is
 * being stopped, a scope's stop job waits for the daemon's, so waiting on one
 * from the daemon's shutdown would deadlock. The scope is bound to the unit
 * revuto itself runs in (revuto.service for the daemon), so stopping or crashing
 * the daemon stops it too, after the daemon's own shutdown has run. Once that
 * shutdown starts, new scopes are no longer bound: systemd refuses to start a
 * unit bound to one that is stopping, and the shutdown's own cleanup still runs
 * git. `RuntimeMaxSec` bounds a run's processes even if revuto's own timer never
 * fires. Arguments reach the command verbatim (systemd-run's `${VAR}` expansion is
 * off), and so does the environment: the bus address systemd-run needs and the
 * INVOCATION_ID it sets are put back as the caller had them.
 *
 * Without a reachable systemd user manager (a warning, once) and on macOS and
 * Windows, the child's process group is the handle, as before, and it is now also
 * killed when the child exits. A descendant that starts its own session can
 * outlive the run there.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { delimiter, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** SIGTERM to SIGKILL, for the scope and for the process-group fallback. */
export const KILL_GRACE_MS = 2000;
/** The variables systemd-run needs to reach the user manager; the child gets them only if its own env has them. */
const BUS_KEYS = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;

interface ScopeTools {
  readonly systemdRun: string;
  readonly systemctl: string;
  readonly env: string;
  readonly bus: NodeJS.ProcessEnv;
  /** `-p` properties binding each scope to revuto's own unit, when that unit is in the user manager. */
  readonly bind: readonly string[];
  /** Whether scopes take RuntimeMaxSec (systemd 244 and later). */
  readonly runtimeMax: boolean;
  /**
   * `--expand-environment=no` where systemd-run has it (v254+). It expands
   * `${VAR}` in a scope's command line by default since v258, and never did before v254.
   */
  readonly literal: readonly string[];
}

let tools: Promise<ScopeTools | undefined> | undefined;
let unbound = false;

/**
 * Stop binding new scopes to revuto's unit. Call it when revuto's shutdown
 * starts: the unit is then stopping, and systemd refuses a scope bound to it, so
 * the shutdown's own cleanup (review git) could not start. Scopes already
 * running keep their binding.
 */
export function unbindScopes(): void {
  unbound = true;
}

/** Whether run processes get a systemd scope here, probed once per process. */
function processScopes(): Promise<ScopeTools | undefined> {
  tools ??= probe();
  return tools;
}

/** The deepest unit (service or scope) of the user manager this process runs in. */
export function ownUserUnit(cgroup: string, uid: number | undefined): string | undefined {
  const path = cgroup.split('\n').find((line) => line.startsWith('0::'))?.slice(3) ?? '';
  const parts = path.split('/');
  const manager = parts.indexOf(`user@${uid}.service`);
  if (uid === undefined || manager < 0) return undefined;
  return parts.slice(manager + 1).reverse().find((part) => /\.(service|scope)$/.test(part));
}

/** The executable a spawn would run: a path as given, a bare name through PATH; relative ones against `cwd`. */
function which(name: string, path = process.env.PATH ?? '', cwd = process.cwd()): string | undefined {
  if (name.includes('/')) {
    const file = resolve(cwd, name);
    return executable(file) ? file : undefined;
  }
  return path.split(delimiter).filter(Boolean).map((dir) => resolve(cwd, dir, name)).find(executable);
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(file, args, { env, timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
      resolveRun({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '').trim() });
    });
  });
}

async function probe(): Promise<ScopeTools | undefined> {
  if (process.platform !== 'linux') return undefined;
  const systemdRun = which('systemd-run'), systemctl = which('systemctl'), env = which('env');
  const bus: NodeJS.ProcessEnv = {};
  for (const key of BUS_KEYS) if (process.env[key]) bus[key] = process.env[key];
  if (!systemdRun || !systemctl || !env || !Object.keys(bus).length) {
    warn('systemd-run, systemctl or the user bus address is missing');
    return undefined;
  }
  let unit: string | undefined;
  try { unit = ownUserUnit(readFileSync('/proc/self/cgroup', 'utf8'), process.getuid?.()); } catch { unit = undefined; }
  const bindProps = unit ? ['-p', `BindsTo=${unit}`, '-p', `Before=${unit}`] : [];
  // Option parsing comes first, so an unknown option fails here without starting anything.
  const literal = (await run(systemdRun, ['--expand-environment=no', '--version'], { PATH: process.env.PATH }, 10_000)).code === 0
    ? ['--expand-environment=no'] : [];
  // The shape a run uses, so a scope that cannot start is found here, not in a review:
  // binding first, then RuntimeMaxSec (scopes take it since systemd 244).
  const shapes = [[true, true], [false, true], [true, false], [false, false]].filter(([bind]) => unit || !bind);
  let failure = '';
  for (const [bind, runtimeMax] of shapes) {
    const result = await run(systemdRun, ['--user', '--scope', '--quiet', '--collect', ...literal, ...scopeProps(bind ? bindProps : [], runtimeMax ? 60_000 : undefined),
      '--', env, '-u', 'XDG_RUNTIME_DIR', '-u', 'INVOCATION_ID', 'true'], { PATH: process.env.PATH, ...bus }, 10_000);
    if (result.code === 0) {
      if (unit && !bind) console.error(`[review] review scopes are not bound to ${unit} (${failure.split('\n')[0]}): a crash of this process leaves them running`);
      return { systemdRun, systemctl, env, bus, bind: bind ? bindProps : [], runtimeMax, literal };
    }
    failure = result.stderr || `exit ${result.code}`;
  }
  warn(failure);
  return undefined;
}

function scopeProps(bind: readonly string[], runtimeMaxMs: number | undefined): string[] {
  return ['-p', `TimeoutStopSec=${KILL_GRACE_MS}ms`, ...bind,
    ...(runtimeMaxMs && runtimeMaxMs > 0 ? ['-p', `RuntimeMaxSec=${Math.ceil(runtimeMaxMs / 1000)}s`] : [])];
}

function warn(reason: string): void {
  console.error(`[review] no systemd user scope for review processes (${reason.split('\n')[0]}): `
    + 'falling back to process groups, so a command that starts its own session can outlive its run');
}

export interface RunProcess {
  readonly child: ChildProcess;
  /** The scope holding the child and every process it starts; absent on the process-group fallback. */
  readonly unit?: string;
  /** Signal every process of the run: the whole scope, and the child's process group right away. */
  signal(signal: NodeJS.Signals): void;
  /**
   * End whatever the run left behind, once the child has exited: signal the
   * scope (SIGTERM, then SIGKILL after the grace) until its cgroup is empty, or
   * SIGKILL the child's process group on the fallback. Never rejects.
   */
  reap(): Promise<void>;
}

export interface RunSpawnOptions extends Omit<SpawnOptions, 'detached' | 'env'> {
  readonly env: NodeJS.ProcessEnv;
  /** Names the scope: `revuto-<label>-<pid>-<random>.scope`. */
  readonly label: string;
  /** The scope's RuntimeMaxSec: systemd stops it then even if revuto's own timer never fires. */
  readonly runtimeMaxMs?: number;
}

/**
 * Spawn one process of a review run: in its own scope when systemd allows it,
 * else detached into its own process group. The child sees `options.env`
 * exactly; the user bus address systemd-run needs is removed again before the
 * command runs unless that env already carried it. A command not found on the
 * child's PATH fails with ENOENT, as a plain spawn would.
 */
export async function spawnRunProcess(command: string, args: readonly string[], options: RunSpawnOptions): Promise<RunProcess> {
  const { label, runtimeMaxMs, env, ...spawnOptions } = options;
  const scope = await processScopes();
  if (!scope) {
    const child = spawn(command, args, { ...spawnOptions, env, detached: process.platform !== 'win32' });
    return {
      child,
      signal: (signal) => killGroup(child, signal),
      reap: async () => { try { killGroup(child, 'SIGKILL'); } catch { /* best effort: the run is over */ } },
    };
  }
  // Without PATH in the env, a spawn searches the default path; so does this.
  const resolved = which(command, env.PATH ?? '/usr/bin:/bin', typeof spawnOptions.cwd === 'string' ? spawnOptions.cwd : undefined);
  if (!resolved) {
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${command}`, path: command, spawnargs: [...args] });
  }
  const unit = `revuto-${label.replace(/[^A-Za-z0-9_-]/g, '_')}-${process.pid}-${randomBytes(4).toString('hex')}.scope`;
  const added = BUS_KEYS.filter((key) => env[key] === undefined && scope.bus[key] !== undefined);
  const props = scopeProps(unbound ? [] : scope.bind, scope.runtimeMax ? runtimeMaxMs : undefined);
  // systemd-run sets INVOCATION_ID to the scope's; the command gets the caller's back, or none.
  const restore = [...added.flatMap((key) => ['-u', key]),
    ...(env.INVOCATION_ID === undefined ? ['-u', 'INVOCATION_ID'] : [`INVOCATION_ID=${env.INVOCATION_ID}`])];
  const argv = ['--user', '--scope', '--quiet', '--collect', ...scope.literal, `--unit=${unit}`, `--description=revuto ${label} run (pid ${process.pid})`, ...props, '--',
    scope.env, ...restore, resolved, ...args];
  // systemd-run moves itself into the scope and then execs the command, so the
  // child keeps this pid, its stdio and its cwd, and leads its own process group.
  const child = spawn(scope.systemdRun, argv, { ...spawnOptions, env: { ...env, ...Object.fromEntries(added.map((key) => [key, scope.bus[key]])) }, detached: true });
  const systemctl = (verb: string[], timeout = 10_000) => run(scope.systemctl, ['--user', ...verb, unit], { PATH: process.env.PATH, ...scope.bus }, timeout);
  let reaped: Promise<void> | undefined;
  return {
    child,
    unit,
    signal: (signal) => {
      void systemctl(['kill', `--signal=${signal}`]);
      try { killGroup(child, signal); } catch { /* the scope signal above covers the group */ }
    },
    reap: () => {
      reaped ??= reapScope(systemctl).catch((error: unknown) => {
        console.error(`[review] could not empty ${unit}: ${error instanceof Error ? error.message : String(error)}`);
        try { killGroup(child, 'SIGKILL'); } catch { /* best effort: the run is over */ }
      });
      return reaped;
    },
  };
}

/** How often reap checks whether a scope's cgroup has emptied. */
const REAP_POLL_MS = 50;
/** After SIGKILL the kernel needs no grace, only time to tear the processes down. */
const SIGKILL_SETTLE_MS = 5000;

/**
 * How to ask the kernel whether a scope's cgroup still holds a process, by the
 * hierarchy this host mounts: `cgroup.events` on the unified (v2) hierarchy, at
 * the root or under `unified/` on a hybrid host, else the systemd v1
 * hierarchy's `cgroup.procs`. A missing file there means the cgroup is gone, so
 * empty. `undefined`: this host gives no answer.
 */
export function cgroupPopulated(cgroup: string, root = '/sys/fs/cgroup'): () => boolean | undefined {
  const read = (file: string, populated: (text: string) => boolean) => (): boolean | undefined => {
    try { return populated(readFileSync(file, 'utf8')); } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
    }
  };
  const events = (text: string) => /^populated 1$/m.test(text);
  if (existsSync(join(root, 'cgroup.controllers'))) return read(join(root, cgroup, 'cgroup.events'), events);
  if (existsSync(join(root, 'unified', 'cgroup.controllers'))) return read(join(root, 'unified', cgroup, 'cgroup.events'), events);
  if (existsSync(join(root, 'systemd', 'cgroup.procs'))) return read(join(root, 'systemd', cgroup, 'cgroup.procs'), (text) => text.trim() !== '');
  return () => undefined;
}

/**
 * Signal what is left in a scope until its cgroup is empty. A scope whose last
 * process exited is already gone (`--collect`), which is the common case.
 */
async function reapScope(systemctl: (verb: string[], timeout?: number) => Promise<{ code: number; stdout: string }>): Promise<void> {
  // Empty, or a failure (not loaded), when the scope is already gone.
  const shown = await systemctl(['show', '--value', '--property=ControlGroup']);
  const cgroup = shown.code === 0 ? shown.stdout.trim() : '';
  if (!cgroup) return;
  const populated = cgroupPopulated(cgroup);
  const state = populated();
  if (state === false) return;
  if (state === undefined) {
    // No way to see the cgroup empty: each signal gets its full wait.
    await systemctl(['kill', '--signal=SIGTERM']);
    await delay(KILL_GRACE_MS);
    await systemctl(['kill', '--signal=SIGKILL']);
    return;
  }
  const emptied = async (ms: number): Promise<boolean> => {
    for (let waited = 0; ; waited += REAP_POLL_MS) {
      if (populated() === false) return true;
      if (waited >= ms) return false;
      await delay(REAP_POLL_MS);
    }
  };
  await systemctl(['kill', '--signal=SIGTERM']);
  if (await emptied(KILL_GRACE_MS)) return;
  await systemctl(['kill', '--signal=SIGKILL']);
  if (!(await emptied(SIGKILL_SETTLE_MS))) throw new Error('processes remain after SIGKILL');
}

/** Signal the child's process group (the child itself on Windows). */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  // A POSIX process group can outlive its leader. Escalation remains necessary
  // until stdio closes; callers clear their escalation timers on the close event.
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } else process.kill(-child.pid, signal);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
