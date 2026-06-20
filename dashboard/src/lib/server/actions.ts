import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const REVIEW_TARGET_RE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const LONG_JOB_TIMEOUT_MS = 660_000;

export interface DashboardActionResult {
  ok: boolean;
  output?: string;
  error?: string;
}

function ok(output: string): DashboardActionResult {
  const text = output.trim().slice(0, 2000);
  return text ? { ok: true, output: text } : { ok: true };
}

function fail(error: string): DashboardActionResult {
  return { ok: false, error: error.slice(0, 2000) };
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === 'revuto') return dir;
      } catch {
        // keep walking
      }
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return process.cwd();
}

function systemdEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === null ? undefined : `/run/user/${uid}`);
  return {
    ...process.env,
    ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? (runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined),
    SYSTEMD_PAGER: '',
  };
}

function revutoEnv(): NodeJS.ProcessEnv {
  const root = repoRoot();
  return {
    ...process.env,
    REVUTO_VAULT: process.env.REVUTO_VAULT ?? join(homedir(), 'revuto'),
    REVUTO_CONFIG: process.env.REVUTO_CONFIG ?? join(homedir(), 'revuto', 'revuto.config.json'),
    PATH: process.env.PATH ?? `${join(homedir(), '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    PWD: root,
  };
}

async function systemctl(action: 'start' | 'stop' | 'restart'): Promise<string> {
  const { stdout, stderr } = await execFileAsync('systemctl', ['--user', action, 'revuto.service'], {
    env: systemdEnv(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout || stderr || `revuto.service ${action}ed`;
}

async function revutoCli(args: string[], timeoutMs = LONG_JOB_TIMEOUT_MS): Promise<string> {
  const root = repoRoot();
  const cli = join(root, 'dist', 'daemon', 'src', 'cli.js');
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--enable-source-maps', cli, ...args], {
    cwd: root,
    env: revutoEnv(),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout || stderr;
}

async function restartDaemonAfterConfigChange(): Promise<void> {
  try {
    await systemctl('restart');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`saved reviewer change, but revuto.service restart failed: ${message}`);
  }
}

export async function runDashboardAction(action: string, target?: string): Promise<DashboardActionResult> {
  try {
    switch (action) {
      case 'start':
      case 'stop':
      case 'restart':
        return ok(await systemctl(action));

      case 'pause':
      case 'resume': {
        if (!target || !REPO_RE.test(target)) return fail('target must be owner/repo');
        const out = await revutoCli([action, target], 30_000);
        await restartDaemonAfterConfigChange();
        return ok(`${out.trim()}\nrevuto.service restarted`);
      }

      case 'doctor':
        return ok(await revutoCli(['doctor'], 60_000));

      case 'trigger':
      case 'learn':
      case 'decay': {
        if (!target || !REPO_RE.test(target)) return fail('target must be owner/repo');
        const args = action === 'trigger' ? ['trigger', target, 'review'] : [action, target];
        return ok(await revutoCli(args));
      }

      case 'review': {
        const match = target?.match(REVIEW_TARGET_RE);
        if (!match) return fail('target must be owner/repo#123');
        return ok(await revutoCli(['review', match[1], String(Number(match[2]))]));
      }

      default:
        return fail('unknown action');
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export const ACTION_TIMEOUT_MS = LONG_JOB_TIMEOUT_MS;
