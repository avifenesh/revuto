import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Octokit } from '@octokit/rest';

export interface InvocationPayload {
  readonly repo: string; // "owner/name"
  readonly pr_number: number;
  readonly pr_title?: string;
  readonly pr_body?: string;
}

export interface PrContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly author: string;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly fileList: readonly string[];
  readonly existingReviews: readonly {
    readonly id: number;
    readonly user: string;
    readonly state: string;
    readonly submittedAt: string | null;
    readonly body: string;
  }[];
  readonly existingReviewComments: readonly {
    readonly id: number;
    readonly user: string;
    readonly path: string;
    readonly line: number | null;
    readonly originalLine: number | null;
    readonly body: string;
    readonly diffHunk: string;
  }[];
  readonly existingIssueComments: readonly {
    readonly id: number;
    readonly user: string;
    readonly body: string;
  }[];
  readonly workspacePath: string;
  readonly diffRefSpec: string; // "<mergeBaseSha>..<headSha>"
}

function run(cmd: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args as string[], { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

/**
 * Ensure the repo is cloned at `workspaceRoot`. Generic — no pre-baked remotes;
 * we clone the target repo on first use and reuse the checkout after that.
 */
async function ensureClone(owner: string, repoName: string, workspaceRoot: string, token: string): Promise<void> {
  const env = { GIT_TERMINAL_PROMPT: '0' };
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`;
  if (!existsSync(`${workspaceRoot}/.git`)) {
    await mkdir(dirname(workspaceRoot), { recursive: true });
    await run('git', ['clone', '--filter=tree:0', remoteUrl, workspaceRoot], { env });
  } else {
    await run('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: workspaceRoot, env });
  }
}

/** Clone (or refresh the origin of) a repo into `dir`. Used by `init` for onboarding. */
export async function cloneRepo(repo: string, token: string, dir: string): Promise<void> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo: ${repo}`);
  await ensureClone(owner, name, dir, token);
}

async function checkoutPr(workspaceRoot: string, prNumber: number, token: string): Promise<string> {
  const env = { GIT_TERMINAL_PROMPT: '0' };
  // GitHub exposes every PR head at pull/<N>/head. tree:0 filter hydrates lazily.
  await run('git', ['fetch', '--filter=tree:0', 'origin', `pull/${prNumber}/head:refs/remotes/origin/pr-${prNumber}`], { cwd: workspaceRoot, env });
  const headSha = (await run('git', ['rev-parse', `refs/remotes/origin/pr-${prNumber}`], { cwd: workspaceRoot })).trim();
  // Detached checkout at the PR tip keeps the working tree clean for LSP.
  await run('git', ['checkout', '--detach', headSha], { cwd: workspaceRoot, env });
  return headSha;
}

export async function prepareWorkspace(
  payload: InvocationPayload,
  octokit: Octokit,
  token: string,
  workspaceRoot: string,
): Promise<PrContext> {
  const [owner, repoName] = payload.repo.split('/');
  if (!owner || !repoName) throw new Error(`bad repo: ${payload.repo}`);

  const { data: pr } = await octokit.pulls.get({ owner, repo: repoName, pull_number: payload.pr_number });

  await ensureClone(owner, repoName, workspaceRoot, token);
  const headSha = await checkoutPr(workspaceRoot, payload.pr_number, token);

  // Base SHA comes from the PR object, not the ref name — the ref may have
  // advanced since the PR was opened. Fetch the base ref + sha explicitly.
  await run('git', ['fetch', '--filter=tree:0', 'origin', `${pr.base.ref}:refs/remotes/origin/${pr.base.ref}`], { cwd: workspaceRoot }).catch(() => {});
  const baseSha = pr.base.sha;
  await run('git', ['fetch', '--filter=tree:0', 'origin', baseSha], { cwd: workspaceRoot }).catch(() => {});

  const mergeBaseSha = (await run('git', ['merge-base', headSha, baseSha], { cwd: workspaceRoot })).trim();

  const [reviewsResp, reviewCommentsResp, issueCommentsResp, filesResp] = await Promise.all([
    octokit.pulls.listReviews({ owner, repo: repoName, pull_number: payload.pr_number, per_page: 100 }),
    octokit.pulls.listReviewComments({ owner, repo: repoName, pull_number: payload.pr_number, per_page: 100 }),
    octokit.issues.listComments({ owner, repo: repoName, issue_number: payload.pr_number, per_page: 100 }),
    octokit.pulls.listFiles({ owner, repo: repoName, pull_number: payload.pr_number, per_page: 300 }),
  ]);

  return {
    owner,
    repo: repoName,
    prNumber: payload.pr_number,
    headSha,
    baseSha,
    mergeBaseSha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    author: pr.user?.login ?? '',
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    fileList: filesResp.data.map((f) => f.filename),
    existingReviews: reviewsResp.data.map((r) => ({
      id: r.id,
      user: r.user?.login ?? '',
      state: r.state ?? '',
      submittedAt: r.submitted_at ?? null,
      body: r.body ?? '',
    })),
    existingReviewComments: reviewCommentsResp.data.map((c) => ({
      id: c.id,
      user: c.user?.login ?? '',
      path: c.path,
      line: c.line ?? null,
      originalLine: c.original_line ?? null,
      body: c.body,
      diffHunk: c.diff_hunk ?? '',
    })),
    existingIssueComments: issueCommentsResp.data.map((c) => ({
      id: c.id,
      user: c.user?.login ?? '',
      body: c.body ?? '',
    })),
    workspacePath: workspaceRoot,
    diffRefSpec: `${mergeBaseSha}..${headSha}`,
  };
}

export function renderPrOverview(ctx: PrContext): string {
  const lines: string[] = [];
  lines.push(`# PR #${ctx.prNumber}: ${ctx.title}`);
  lines.push('');
  lines.push(`Repository: ${ctx.owner}/${ctx.repo}`);
  lines.push(`Author: ${ctx.author}`);
  lines.push(`Head: ${ctx.headRef} @ ${ctx.headSha}`);
  lines.push(`Base: ${ctx.baseRef} @ ${ctx.baseSha}`);
  lines.push(`Merge-base: ${ctx.mergeBaseSha}`);
  lines.push(`Diff range: \`${ctx.diffRefSpec}\` (use this with \`git diff\` / \`git log\`)`);
  lines.push(`Workspace: \`${ctx.workspacePath}\` (HEAD is already checked out at the PR tip)`);
  lines.push(`Size: +${ctx.additions} / -${ctx.deletions} across ${ctx.changedFiles} files`);
  lines.push('');
  lines.push('## Body');
  lines.push(ctx.body.trim() || '(empty)');
  lines.push('');
  lines.push(`## Changed files (${ctx.fileList.length})`);
  for (const f of ctx.fileList) lines.push(`- ${f}`);
  lines.push('');
  if (ctx.existingReviews.length > 0) {
    lines.push(`## Existing reviews (${ctx.existingReviews.length})`);
    for (const r of ctx.existingReviews) {
      lines.push(`- ${r.user} (${r.state}) at ${r.submittedAt ?? '?'}: ${r.body.slice(0, 240).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  if (ctx.existingReviewComments.length > 0) {
    lines.push(`## Existing inline comments (${ctx.existingReviewComments.length})`);
    for (const c of ctx.existingReviewComments) {
      lines.push(`- ${c.user} on ${c.path}:${c.line ?? c.originalLine ?? '?'}: ${c.body.slice(0, 240).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  if (ctx.existingIssueComments.length > 0) {
    lines.push(`## Existing PR comments (${ctx.existingIssueComments.length})`);
    for (const c of ctx.existingIssueComments) {
      lines.push(`- ${c.user}: ${c.body.slice(0, 240).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
