#!/usr/bin/env node
/**
 * revuto CLI. Commands:
 *   revuto daemon                 start the scheduler (review/learn/decay per repo)
 *   revuto add <owner/repo>       register a repo (minimal; `init` adds onboarding)
 *   revuto list                   list registered reviewers
 *   revuto review <owner/repo> <pr>   review one PR now
 *   revuto learn <owner/repo>     run one learn pass now
 *   revuto decay <owner/repo>     run decay now
 *   revuto approve <owner/repo> <skill-slug>   activate a draft skill
 */
import cron from 'node-cron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { loadConfig, defaultVaultPath, type ReviewerConfig } from '../../agents/common/src/config.js';
import { engineRoot } from '../../agents/common/src/engine-root.js';
import { getOctokit } from '../../agents/common/src/github-auth.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { listReviewers, readReviewer, writeReviewer, removeReviewer, setPaused, setSchedule } from './reviewers.js';
import { reviewOnePr, reviewRepo, learnRepo, decayRepo } from './jobs.js';
import { startDaemon } from './scheduler.js';
import { runQueuedForRepo } from './repo-queue.js';
import { runInit } from './init.js';
import { runDoctor, doctorOk } from './doctor.js';
import { isJob } from './types.js';
import { applyModelOverrides, extractModelOverrideArgs, modelOverrideUsage } from './model-overrides.js';

function usage(): void {
  console.log(`revuto <command>

  init-config [--local]           write a starter revuto.config.json into the vault (~/revuto or $REVUTO_VAULT); --local writes it to the current dir
  daemon                          start the scheduler (review/learn/decay)
  doctor                          ping model endpoints + store backend + GitHub token
  init <owner/repo> [maxPRs]      clone + onboard + backfill PRs + write textbook + register
  add <owner/repo>                register a repo (no onboarding)
  remove <owner/repo> [--purge]   unregister a repo (--purge also deletes skills + sqlite memory)
  pause <owner/repo>              stop scheduling this repo (until resume / daemon restart)
  resume <owner/repo>             re-enable scheduling
  cron <owner/repo> <job> <expr>  set a per-repo cron for review|learn|decay ("clear" to reset to default)
  trigger <owner/repo> [job]      run review|learn|decay now (default: review)
  list                            list registered reviewers
  review <owner/repo> <pr> [--force] review one specific PR now
  learn <owner/repo>              run one learn pass now
  decay <owner/repo>              run decay now
  approve <owner/repo> <slug>     activate a draft skill

${modelOverrideUsage().trimEnd()}
`);
}

function requireReviewer(config: ReviewerConfig, repo: string) {
  const settings = readReviewer(config, repo) ?? { repo };
  return { config, settings };
}

async function cmdAdd(config: ReviewerConfig, repo: string): Promise<void> {
  if (!repo?.includes('/')) throw new Error('usage: revuto add <owner/repo>');
  const { octokit } = getOctokit(config.github);
  const botLogin = (await octokit.users.getAuthenticated()).data.login;
  writeReviewer(config, { repo, botLogin });
  console.log(`registered ${repo} (botLogin=${botLogin}). Skills + memory will live in ${config.vaultPath}.`);
}

async function main(): Promise<void> {
  const parsed = extractModelOverrideArgs(process.argv.slice(2));
  const [cmd, ...args] = parsed.args;
  const config = (): ReviewerConfig => applyModelOverrides(loadConfig(), parsed);
  switch (cmd) {
    case 'init-config': {
      const vault = defaultVaultPath();
      const dest = args.includes('--local') ? resolve('revuto.config.json') : join(vault, 'revuto.config.json');
      const cfg = JSON.parse(readFileSync(join(engineRoot(), 'revuto.config.example.json'), 'utf8'));
      cfg.vaultPath = vault;
      mkdirSync(dirname(dest), { recursive: true });
      // Exclusive create (wx) — no exists pre-check, so there is no TOCTOU window.
      // EEXIST (file already there, or created concurrently) means "leave it".
      try {
        writeFileSync(dest, JSON.stringify(cfg, null, 2) + '\n', { flag: 'wx' });
        console.log(`wrote ${dest}\nedit models, then: revuto doctor`);
      } catch (e: any) {
        if (e && e.code === 'EEXIST') {
          console.log(`${dest} already exists — leaving it`);
        } else {
          throw e;
        }
      }
      break;
    }
    case 'daemon': {
      startDaemon(config());
      console.log('daemon running — Ctrl-C to stop');
      break;
    }
    case 'init': {
      const repo = args[0];
      if (!repo?.includes('/')) throw new Error('usage: revuto init <owner/repo> [maxPRs]');
      const maxPRs = args[1] ? parseInt(args[1], 10) : undefined;
      console.log(JSON.stringify(await runInit({ config: config(), repo, maxPRs }), null, 2));
      break;
    }
    case 'doctor': {
      const report = await runDoctor(config());
      console.log(`github: ${report.github.ok ? `ok (login=${report.github.login})` : `FAIL — ${report.github.error}`}`);
      console.log(`store:  ${report.store.ok ? `ok (${report.store.backend}, ${report.store.ms}ms)` : `FAIL (${report.store.backend}) — ${report.store.error}`}`);
      for (const m of report.models) {
        const label = m.api ? `${m.kind}/${m.api}` : m.kind;
        console.log(`${m.ok ? 'ok  ' : 'FAIL'} [${label}] ${m.roles.join('+')} → ${m.model} @ ${m.baseURL} (${m.ms}ms)${m.error ? ` — ${m.error}` : ''}`);
      }
      if (!doctorOk(report)) process.exitCode = 1;
      break;
    }
    case 'add':
      await cmdAdd(config(), args[0]);
      break;
    case 'list': {
      const cfg = config();
      const rs = listReviewers(cfg);
      // --json emits the reviewer list as machine-readable JSON (for the eigen
      // working-station's Revuto connector). The default stays human-formatted.
      if (args.includes('--json')) {
        console.log(JSON.stringify(rs, null, 2));
        break;
      }
      if (rs.length === 0) { console.log('no reviewers registered'); break; }
      for (const r of rs) {
        console.log(`${r.repo}  ${r.paused ? 'PAUSED  ' : ''}schedules=${JSON.stringify(r.schedules ?? {})}  allowlist=${r.authorAllowlist?.length ? r.authorAllowlist.join(',') : '(all)'}  autoActivate=${!!r.autoActivate}`);
      }
      break;
    }
    case 'review': {
      const repo = args[0]; const pr = parseInt(args[1] ?? '', 10);
      if (!repo?.includes('/') || !Number.isFinite(pr)) throw new Error('usage: revuto review <owner/repo> <pr>');
      const cfg = config();
      const outcome = await runQueuedForRepo(cfg, repo, () => reviewOnePr(cfg, repo, pr, { force: args.includes('--force') }));
      console.log(JSON.stringify(outcome, null, 2));
      break;
    }
    case 'learn': {
      const { config: cfg, settings } = requireReviewer(config(), args[0] ?? '');
      console.log(JSON.stringify(await runQueuedForRepo(cfg, settings.repo, () => learnRepo(cfg, settings)), null, 2));
      break;
    }
    case 'decay': {
      const cfg = config();
      const repo = args[0] ?? '';
      console.log(JSON.stringify(await runQueuedForRepo(cfg, repo, () => decayRepo(cfg, repo)), null, 2));
      break;
    }
    case 'approve': {
      const repo = args[0]; const slug = args[1];
      if (!repo?.includes('/') || !slug) throw new Error('usage: revuto approve <owner/repo> <skill-slug>');
      const store = await openStore(config(), repo);
      try {
        console.log((await store.setSkillStatus(slug, 'active')) ? `activated ${slug}` : `no skill "${slug}" in ${repo}`);
      } finally {
        await store.close();
      }
      break;
    }
    case 'remove': {
      const repo = args[0];
      if (!repo?.includes('/')) throw new Error('usage: revuto remove <owner/repo> [--purge]');
      const purge = args.includes('--purge');
      const ok = removeReviewer(config(), repo, { purge });
      console.log(ok ? `removed ${repo}${purge ? ' (skills + sqlite memory purged)' : ''}` : `not registered: ${repo}`);
      break;
    }
    case 'pause':
    case 'resume': {
      const repo = args[0];
      if (!repo?.includes('/')) throw new Error(`usage: revuto ${cmd} <owner/repo>`);
      const ok = setPaused(config(), repo, cmd === 'pause');
      console.log(ok ? `${cmd}d ${repo} (applies on daemon restart)` : `not registered: ${repo}`);
      break;
    }
    case 'cron': {
      const repo = args[0]; const job = args[1] ?? ''; const expr = args.slice(2).join(' ').trim();
      if (!repo?.includes('/') || !isJob(job) || !expr) {
        throw new Error('usage: revuto cron <owner/repo> <review|learn|decay> "<cron-expr>" | clear');
      }
      const clear = expr === 'clear' || expr === '-';
      if (!clear && !cron.validate(expr)) throw new Error(`invalid cron expression: "${expr}"`);
      const ok = setSchedule(config(), repo, job, clear ? null : expr);
      console.log(ok ? `${repo} ${job} cron ${clear ? 'cleared (uses config default)' : `set to "${expr}"`} — applies on daemon restart` : `not registered: ${repo}`);
      break;
    }
    case 'trigger': {
      const repo = args[0]; const job = args[1] ?? 'review';
      if (!repo?.includes('/') || !isJob(job)) throw new Error('usage: revuto trigger <owner/repo> <review|learn|decay>');
      const cfg = config();
      const settings = readReviewer(cfg, repo) ?? { repo };
      const res = await runQueuedForRepo(cfg, repo, async () => {
        if (job === 'review') return reviewRepo(cfg, settings, { force: true });
        if (job === 'learn') return learnRepo(cfg, settings);
        return decayRepo(cfg, repo);
      });
      console.log(JSON.stringify(res, null, 2));
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
