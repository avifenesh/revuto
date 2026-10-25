/**
 * The workspace a native reviewer (Claude Code, Codex) gets: real tools, inside a
 * sandbox.
 *
 * The reviewer is trusted to act well, and auto mode (Claude) or the sandbox
 * policy (Codex) catches a bad action. What is not trusted is the checkout: a PR
 * can plant instructions (AGENTS.md, CLAUDE.md, skills), configuration that runs
 * code on its own (hooks, .mcp.json, settings with env or helpers), and files a
 * command would run without asking (a `json.py` next to a script, conftest.py,
 * build scripts). So the reviewer gets a shell, file tools, git history, Python
 * and a scratch directory, while:
 *
 * - nothing from the checkout is loaded as configuration or instructions;
 * - every shell command runs in the sandbox: no network, writes only to the
 *   checkout and the run's own directory, never to `.git` or the shared git cache;
 * - credentials never reach a command (no key in its environment, no home reads);
 * - Python never imports from the directory it runs in.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseFrontMatter } from './store/front-matter.js';

/** One review run's private directories, all removed when the run ends. */
export interface ReviewRunLayout {
  /** CLAUDE_CONFIG_DIR / CODEX scratch HOME: no user settings, plugins or memory. */
  readonly configDir: string;
  /** Where the reviewer writes notes, scripts and intermediate results. */
  readonly scratch: string;
  /** A copy of the repository's revuto skills and textbook, readable by the reviewer. */
  readonly skills: string;
}

export function reviewRunLayout(dir: string): ReviewRunLayout {
  return { configDir: join(dir, 'config'), scratch: join(dir, 'scratch'), skills: join(dir, 'skills') };
}

/**
 * Copy the repository's vetted knowledge into the run: the textbook and the
 * `status: active` skills, the same set review selection serves. Drafts (curator
 * output not yet approved), revision notes and `_history/` stay out, and so does
 * anything that is not a regular file.
 */
export async function copySkills(from: string | undefined, to: string): Promise<void> {
  if (!from) return;
  const names = await readdir(from).catch(() => []);
  const vetted: Array<{ name: string; text: string }> = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    // One open, never following a link: what is checked is what is copied.
    const file = await open(join(from, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (!file) continue;
    try {
      if (!(await file.stat()).isFile()) continue;
      const text = await file.readFile('utf8');
      if (name === '_textbook.md' || parseFrontMatter(text)?.data.status === 'active') vetted.push({ name, text });
    } finally {
      await file.close();
    }
  }
  if (!vetted.length) return;
  await mkdir(to, { recursive: true });
  for (const { name, text } of vetted) await writeFile(join(to, name), text);
}

/**
 * The git directory behind a checkout: `<checkout>/.git` itself, or the
 * directory a worktree's `.git` pointer file names. The reviewer reads it for
 * history and never writes it: revuto runs git there later, outside the sandbox.
 */
export async function checkoutGitDir(checkout: string): Promise<{ readonly gitDir: string; readonly commonDir: string } | undefined> {
  const dotGit = join(checkout, '.git');
  const info = await lstat(dotGit).catch(() => undefined);
  if (!info) return undefined;
  if (info.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  const pointer = (await readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)\s*$/m)?.[1];
  if (!pointer) throw new Error('checkout .git is neither a directory nor a gitdir pointer');
  const gitDir = isAbsolute(pointer) ? pointer : resolve(checkout, pointer);
  const common = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

/** Variables that keep a reviewer's commands from importing or running checkout code by accident. */
export const REVIEW_COMMAND_ENV = {
  // Python never puts the working directory or a script's directory on sys.path,
  // so a planted json.py or os.py is not imported.
  PYTHONSAFEPATH: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  // History comes from the local cache only: no network, so no lazy fetch.
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/** Credential variables a sandboxed command must never see. */
const CREDENTIAL_ENV = [
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GH_TOKEN', 'GITHUB_TOKEN',
];

/**
 * Unix sockets that reach outside the sandbox. Claude Code's seccomp helper,
 * which would block Unix sockets, cannot start on this kernel (anthropics/
 * claude-code#81799), so sockets stay allowed and these paths are hidden: the
 * session bus (which can start units with systemd-run and reach the keyring),
 * the system bus, container runtimes, X11 and agents.
 */
const SOCKET_PATHS = [
  '/run/user', '/run/dbus', '/var/run/dbus', '/run/docker.sock', '/var/run/docker.sock', '/run/containerd',
  '/run/podman', '/run/snapd.socket', '/run/snapd-snap.socket', '/tmp/.X11-unix', '/tmp/.ICE-unix',
];

/**
 * Codex permission profile for a review, as one inline TOML table for `-c
 * permissions=...`. The whole filesystem is closed (`:root`), system paths that
 * common tools need are re-opened (`:minimal`), the checkout is writable with its
 * `.git` read-only (`:workspace_roots`), and the run's scratch dir (write) and the
 * git, skills and Codex dirs (read) are added. /tmp is then a private empty
 * tmpfs that holds only those grants. No network.
 *
 * `:workspace` is not the base: it grants /tmp, and denying /tmp again hides the
 * read grants inside it (Codex keeps only the write ones there).
 */
export const CODEX_REVIEW_PROFILE = 'revuto-review';

export function codexReviewPermissions(opts: { writable: readonly string[]; readable: readonly string[] }): string {
  const toml = (value: string) => JSON.stringify(value);
  const entries = [
    [':root', 'deny'], [':minimal', 'read'],
    ...opts.readable.map((dir) => [dir, 'read']),
    ...opts.writable.map((dir) => [dir, 'write']),
  ];
  const filesystem = [...entries.map(([path, access]) => `${toml(path!)}=${toml(access!)}`), `${toml(':workspace_roots')}={${toml('.')}=${toml('write')}}`].join(',');
  return `{${toml(CODEX_REVIEW_PROFILE)}={extends=${toml(':read-only')},filesystem={${filesystem}},network={enabled=false}}}`;
}

/** Claude Code tools a reviewer gets. */
export const CLAUDE_REVIEW_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'] as const;

/**
 * Claude Code settings for one review, passed with --settings while every other
 * settings source is off. Auto mode reviews each action; this file sets what no
 * action may do.
 */
export function claudeReviewSettings(opts: { checkout: string; gitDir?: string; commonDir?: string; runDirs?: readonly string[] }): Record<string, unknown> {
  const gitDirs = [opts.gitDir, opts.commonDir].filter((dir): dir is string => !!dir);
  const writeDenied = [...new Set([`${opts.checkout}/.git`, ...gitDirs])];
  const permissionPath = (path: string) => `/${path}`; // `//abs/path` in permission rules
  return {
    disableBundledSkills: true,
    permissions: {
      // Read, Grep and Glob see only the checkout and the run's directory; the
      // sandbox gives commands the same view, plus the git directory below.
      blockReadsOutsideWorkingDirectories: true,
      // Edit rules cover every file-editing tool (Write included).
      deny: writeDenied.flatMap((path) => [`Edit(${permissionPath(path)}/**)`, `Edit(${permissionPath(path)})`]),
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        // The whole home directory is unreadable (logins, keys, the vault and its
        // other repositories); the checkout, the run's directories and the git
        // directories are re-opened. A file a command reads could end up quoted
        // in the posted review, so nothing else is readable.
        denyRead: ['~', ...SOCKET_PATHS],
        allowRead: [opts.checkout, ...gitDirs, ...(opts.runDirs ?? [])],
        denyWrite: writeDenied,
      },
      // strictAllowlist: an unlisted host is refused, never put to auto mode's
      // classifier, so a command cannot name its own hosts to reach.
      network: { allowedDomains: [], strictAllowlist: true, allowAllUnixSockets: true },
      credentials: {
        envVars: CREDENTIAL_ENV.map((name) => ({ name, mode: 'deny' })),
        files: [{ path: '~/.aws', mode: 'deny' }, { path: '~/.ssh', mode: 'deny' }],
      },
    },
  };
}
