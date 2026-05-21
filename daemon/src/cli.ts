#!/usr/bin/env node
/**
 * reviewer CLI. Commands:
 *   reviewer daemon                 start the scheduler (review/learn/decay per repo)
 *   reviewer add <owner/repo>       register a repo (minimal; `init` adds onboarding)
 *   reviewer list                   list registered reviewers
 *   reviewer review <owner/repo> <pr>   review one PR now
 *   reviewer learn <owner/repo>     run one learn pass now
 *   reviewer decay <owner/repo>     run decay now
 *   reviewer approve <owner/repo> <skill-slug>   activate a draft skill
 */
import { loadConfig } from '../../agents/common/src/config.js';
import { getOctokit } from '../../agents/common/src/github-auth.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { listReviewers, readReviewer, writeReviewer } from './reviewers.js';
import { reviewOnePr, learnRepo, decayRepo } from './jobs.js';
import { startDaemon } from './scheduler.js';
import { runInit } from './init.js';
import { runDoctor, doctorOk } from './doctor.js';

function usage(): void {
  console.log(`reviewer <command>

  daemon                          start the scheduler (review/learn/decay)
  doctor                          ping configured model endpoints + GitHub token
  init <owner/repo> [maxPRs]      clone + onboard + backfill PRs + write textbook + register
  add <owner/repo>                register a repo (no onboarding)
  list                            list registered reviewers
  review <owner/repo> <pr>        review one PR now
  learn <owner/repo>              run one learn pass now
  decay <owner/repo>              run decay now
  approve <owner/repo> <slug>     activate a draft skill
`);
}

function requireReviewer(repo: string) {
  const config = loadConfig();
  const settings = readReviewer(config, repo) ?? { repo };
  return { config, settings };
}

async function cmdAdd(repo: string): Promise<void> {
  if (!repo?.includes('/')) throw new Error('usage: reviewer add <owner/repo>');
  const config = loadConfig();
  const { octokit } = getOctokit(config.github);
  const botLogin = (await octokit.users.getAuthenticated()).data.login;
  writeReviewer(config, { repo, botLogin });
  console.log(`registered ${repo} (botLogin=${botLogin}). Skills + memory will live in ${config.vaultPath}.`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'daemon': {
      startDaemon(loadConfig());
      console.log('daemon running — Ctrl-C to stop');
      break;
    }
    case 'init': {
      const repo = args[0];
      if (!repo?.includes('/')) throw new Error('usage: reviewer init <owner/repo> [maxPRs]');
      const maxPRs = args[1] ? parseInt(args[1], 10) : undefined;
      console.log(JSON.stringify(await runInit({ config: loadConfig(), repo, maxPRs }), null, 2));
      break;
    }
    case 'doctor': {
      const report = await runDoctor(loadConfig());
      console.log(`github: ${report.github.ok ? `ok (login=${report.github.login})` : `FAIL — ${report.github.error}`}`);
      for (const m of report.models) {
        console.log(`${m.ok ? 'ok  ' : 'FAIL'} [${m.kind}] ${m.roles.join('+')} → ${m.model} @ ${m.baseURL} (${m.ms}ms)${m.error ? ` — ${m.error}` : ''}`);
      }
      if (!doctorOk(report)) process.exitCode = 1;
      break;
    }
    case 'add':
      await cmdAdd(args[0]);
      break;
    case 'list': {
      const config = loadConfig();
      const rs = listReviewers(config);
      if (rs.length === 0) { console.log('no reviewers registered'); break; }
      for (const r of rs) {
        console.log(`${r.repo}  schedules=${JSON.stringify(r.schedules ?? {})}  allowlist=${r.authorAllowlist?.length ? r.authorAllowlist.join(',') : '(all)'}  autoActivate=${!!r.autoActivate}`);
      }
      break;
    }
    case 'review': {
      const repo = args[0]; const pr = parseInt(args[1] ?? '', 10);
      if (!repo?.includes('/') || !Number.isFinite(pr)) throw new Error('usage: reviewer review <owner/repo> <pr>');
      const config = loadConfig();
      const outcome = await reviewOnePr(config, repo, pr);
      console.log(JSON.stringify(outcome, null, 2));
      break;
    }
    case 'learn': {
      const { config, settings } = requireReviewer(args[0] ?? '');
      console.log(JSON.stringify(await learnRepo(config, settings), null, 2));
      break;
    }
    case 'decay': {
      const config = loadConfig();
      console.log(JSON.stringify(await decayRepo(config, args[0] ?? ''), null, 2));
      break;
    }
    case 'approve': {
      const repo = args[0]; const slug = args[1];
      if (!repo?.includes('/') || !slug) throw new Error('usage: reviewer approve <owner/repo> <skill-slug>');
      const store = await openStore(loadConfig(), repo);
      try {
        console.log((await store.setSkillStatus(slug, 'active')) ? `activated ${slug}` : `no skill "${slug}" in ${repo}`);
      } finally {
        await store.close();
      }
      break;
    }
    default:
      usage();
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
