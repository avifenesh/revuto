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
 * parents, and stopping the scope ends all of them: SIGTERM, then SIGKILL after
 * the grace. The scope is bound to the unit revuto itself runs in (revuto.service
 * for the daemon), so stopping or crashing the daemon stops it too, after the
 * daemon's own shutdown has run. `RuntimeMaxSec` bounds a run's processes even if
 * revuto's own timer never fires.
 *
 * Without a reachable systemd user manager (macOS, Windows, a container without
 * systemd) the child's process group is the handle, as before, and it is now also
 * killed when the child exits. A descendant that starts its own session can
 * outlive the run there.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
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
}

let tools: Promise<ScopeTools | undefined> | undefined;

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

/** The executable a spawn would run: a path as given (against `cwd`), a bare name through PATH. */
function which(name: string, path = process.env.PATH ?? '', cwd = process.cwd()): string | undefined {
  if (name.includes('/')) {
    const file = isAbsolute(name) ? name : resolve(cwd, name);
    return executable(file) ? file : undefined;
  }
  return path.split(delimiter).filter(Boolean).map((dir) => join(dir, name)).find(executable);
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(file, args, { env, timeout, encoding: 'utf8' }, (error, _stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
      resolveRun({ code, stderr: String(stderr ?? '').trim() });
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
  const binds = unit ? [['-p', `BindsTo=${unit}`, '-p', `Before=${unit}`], []] : [[]];
  let failure = '';
  for (const bind of binds) {
    // The same command shape a run uses, so a scope that cannot start is found here.
    const result = await run(systemdRun, ['--user', '--scope', '--quiet', '--collect', ...bind, '--', env, '-u', 'XDG_RUNTIME_DIR', 'true'],
      { PATH: process.env.PATH, ...bus }, 10_000);
    if (result.code === 0) {
      if (unit && !bind.length) console.error(`[review] review scopes are not bound to ${unit} (${failure.split('\n')[0]}): a crash of this process leaves them running`);
      return { systemdRun, systemctl, env, bus, bind };
    }
    failure = result.stderr || `exit ${result.code}`;
  }
  warn(failure);
  return undefined;
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
   * End whatever the run left behind, once the child has exited: stop the scope
   * (SIGTERM, then SIGKILL after the grace) and wait for it, or SIGKILL the
   * child's process group on the fallback. Never rejects.
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
  const props = ['-p', `TimeoutStopSec=${KILL_GRACE_MS}ms`, ...scope.bind,
    ...(runtimeMaxMs && runtimeMaxMs > 0 ? ['-p', `RuntimeMaxSec=${Math.ceil(runtimeMaxMs / 1000)}s`] : [])];
  const argv = ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, `--description=revuto ${label} run (pid ${process.pid})`, ...props, '--',
    ...(added.length ? [scope.env, ...added.flatMap((key) => ['-u', key])] : []), resolved, ...args];
  // systemd-run moves itself into the scope and then execs the command, so the
  // child keeps this pid, its stdio and its cwd, and leads its own process group.
  const child = spawn(scope.systemdRun, argv, { ...spawnOptions, env: { ...env, ...Object.fromEntries(added.map((key) => [key, scope.bus[key]])) }, detached: true });
  const systemctl = (verb: string[], timeout: number) => run(scope.systemctl, ['--user', ...verb, unit], { PATH: process.env.PATH, ...scope.bus }, timeout);
  let stopped: Promise<void> | undefined;
  return {
    child,
    unit,
    signal: (signal) => {
      killGroup(child, signal);
      void systemctl(['kill', `--signal=${signal}`], 10_000);
    },
    reap: () => {
      stopped ??= systemctl(['stop'], KILL_GRACE_MS + 15_000).then((result) => {
        // 5: the scope is already gone, because nothing was left in it.
        if (result.code === 0 || result.code === 5) return;
        console.error(`[review] could not stop ${unit}: ${result.stderr || `exit ${result.code}`}`);
        try { killGroup(child, 'SIGKILL'); } catch { /* best effort: the run is over */ }
      });
      return stopped;
    },
  };
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
