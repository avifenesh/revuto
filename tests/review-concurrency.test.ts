import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReviewerConfig } from '../agents/common/src/config.js';
import { runQueuedReview } from '../daemon/src/review-queue.js';
import { withReviewWorktree, reviewCachePath, reapReviewWorktrees, reviewGit } from '../agents/common/src/review-worktree.js';
import { runAgyCli } from '../agents/common/src/agy-review.js';
import { prepareWorkspace } from '../agents/common/src/workspace.js';
import { runQueuedForRepo } from '../daemon/src/repo-queue.js';
import { reviewOnePr } from '../daemon/src/jobs.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';

function config(root: string): ReviewerConfig {
  return { vaultPath: root, review: { workspaceDir: join(root,'workspaces'), maxConcurrent:4, maxConcurrentPerRepo:2 } } as ReviewerConfig;
}

test('Review admission permits four global/two per repo and never overlaps the same PR', async () => {
  const root=mkdtempSync(join(tmpdir(),'review-queue-'));const cfg=config(root);
  let global=0, peak=0;const perRepo=new Map<string,number>(), keys=new Set<string>();
  try {
    await Promise.all([['a/repo',1],['a/repo',2],['a/repo',3],['b/repo',1],['b/repo',2],['a/repo',1],['c/repo',1]].map(async ([repo,pr]) => {
      await runQueuedReview(cfg,String(repo),Number(pr),async()=>{
        const key=`${repo}#${pr}`;assert.equal(keys.has(key),false);keys.add(key);
        global++;peak=Math.max(peak,global);perRepo.set(String(repo),(perRepo.get(String(repo))??0)+1);
        assert.ok(global<=4);assert.ok(perRepo.get(String(repo))!<=2);
        await delay(150);
        global--;perRepo.set(String(repo),perRepo.get(String(repo))!-1);keys.delete(key);
      });
    }));
    assert.equal(peak,4);assert.equal(readdirSync(join(root,'.locks','reviews')).length,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Review slots are shared across processes and released on errors', async () => {
  const root=mkdtempSync(join(tmpdir(),'review-processes-'));const cfg=config(root);
  const worker=join(root,'worker.mjs'),release=join(root,'release');
  writeFileSync(worker,`import {runQueuedReview} from ${JSON.stringify(new URL('../daemon/src/review-queue.ts',import.meta.url).href)};
import {existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const cfg=JSON.parse(process.env.TEST_CONFIG),repo=process.env.TEST_REPO,pr=Number(process.env.TEST_PR);
process.send({type:'ready'});await new Promise(r=>process.once('message',r));
await runQueuedReview(cfg,repo,pr,async()=>{process.send({type:'start',repo,pr});while(!existsSync(process.env.TEST_RELEASE))await delay(10);await delay(30);process.send({type:'end',repo,pr});});
process.disconnect();`);
  const children: ReturnType<typeof spawn>[]=[];
  try {
    let active=0,peak=0;const repos=new Map<string,number>();const keys=new Set<string>();
    const ready: Promise<void>[]=[], done: Promise<void>[]=[];
    for(const [repo,pr] of [['a/repo',1],['a/repo',2],['a/repo',3],['b/repo',1],['b/repo',2],['a/repo',1]]) {
      const child=spawn(process.execPath,['--import','tsx',worker],{cwd:process.cwd(),env:{...process.env,TEST_CONFIG:JSON.stringify(cfg),TEST_REPO:String(repo),TEST_PR:String(pr),TEST_RELEASE:release},stdio:['ignore','ignore','pipe','ipc']});children.push(child);
      let errors='';child.stderr!.on('data',b=>{errors+=b.toString();});
      ready.push(new Promise(resolveReady=>child.on('message',(m:any)=>{
        if(m.type==='ready')resolveReady();
        const key=`${m.repo}#${m.pr}`;
        if(m.type==='start') {
          assert.equal(keys.has(key),false);keys.add(key);active++;peak=Math.max(peak,active);
          repos.set(m.repo,(repos.get(m.repo)??0)+1);assert.ok(active<=4);assert.ok(repos.get(m.repo)!<=2);
          if(active===4)writeFileSync(release,'go');
        } else if(m.type==='end') {active--;keys.delete(key);repos.set(m.repo,repos.get(m.repo)!-1);}
      })));
      done.push(new Promise((resolveDone,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolveDone():reject(new Error(errors||`child exit ${code}`)));}));
    }
    await Promise.race([Promise.all(ready),delay(10000).then(()=>{throw new Error('Workers did not start');})]);
    for(const child of children)child.send!('start');
    await Promise.race([Promise.all(done),delay(10000).then(()=>{throw new Error('Concurrent reviews stalled');})]);
    assert.equal(peak,4);
    await assert.rejects(runQueuedReview(cfg,'a/repo',9,async()=>{throw new Error('model failed');}),/model failed/);
    assert.equal(readdirSync(join(root,'.locks','reviews')).length,0);
  } finally {for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');rmSync(root,{recursive:true,force:true});}
});

function seedCache(cfg: ReviewerConfig, root: string): string {
  const source=join(root,'source');mkdirSync(source);const git=(...args:string[])=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.test');writeFileSync(join(source,'file.txt'),'source');git('add','.');git('commit','-qm','base');
  const cache=reviewCachePath(cfg,'a/repo');mkdirSync(join(cfg.review.workspaceDir,'.review-cache'),{recursive:true});execFileSync('git',['clone','--bare',source,cache],{stdio:'ignore'});return git('rev-parse','HEAD');
}

test('Worktrees and Git registrations are removed after success, error and cancellation', async () => {
  const root=mkdtempSync(join(tmpdir(),'review-worktree-'));const cfg=config(root),head=seedCache(cfg,root);
  try {
    let last='';
    const prepare=async(path:string,cache:string,signal:AbortSignal)=>{last=path;await reviewGit(['worktree','add','--detach',path,head],{cwd:cache,signal});assert.equal(readFileSync(join(path,'file.txt'),'utf8'),'source');};
    await withReviewWorktree(cfg,'a/repo',1,prepare);assert.equal(existsSync(last),false);
    await assert.rejects(withReviewWorktree(cfg,'a/repo',2,async(...args)=>{await prepare(...args);throw new Error('review failed');}),/review failed/);assert.equal(existsSync(last),false);
    const abort=new AbortController();let started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
    const pending=withReviewWorktree(cfg,'a/repo',3,async(...args)=>{await prepare(...args);started();await delay(10000,undefined,{signal:args[2]});},abort.signal);
    await entered;abort.abort();await assert.rejects(pending);assert.equal(existsSync(last),false);
    assert.equal(readdirSync(join(cfg.review.workspaceDir,'.review-runs')).length,0);
    const list=await reviewGit(['worktree','list','--porcelain'],{cwd:reviewCachePath(cfg,'a/repo')});assert.equal(list.split('\n').filter(x=>x.startsWith('worktree ')).length,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Startup reaps worktrees whose process crashed without running finally', async () => {
  const root=mkdtempSync(join(tmpdir(),'review-crash-'));const cfg=config(root),head=seedCache(cfg,root);
  const worker=join(root,'crash.mjs');
  try {
    writeFileSync(worker,`import {withReviewWorktree,reviewGit} from ${JSON.stringify(new URL('../agents/common/src/review-worktree.ts',import.meta.url).href)};
import {runQueuedReview} from ${JSON.stringify(new URL('../daemon/src/review-queue.ts',import.meta.url).href)};
const cfg=JSON.parse(process.env.TEST_CONFIG);
await runQueuedReview(cfg,'a/repo',7,()=>withReviewWorktree(cfg,'a/repo',7,async(path,cache)=>{await reviewGit(['worktree','add','--detach',path,process.env.TEST_HEAD],{cwd:cache});process.exit(0);}));`);
    const child=spawnSync(process.execPath,['--import','tsx',worker],{cwd:process.cwd(),env:{...process.env,TEST_CONFIG:JSON.stringify(cfg),TEST_HEAD:head},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    assert.equal(await reapReviewWorktrees(cfg),1);
    assert.equal(readdirSync(join(cfg.review.workspaceDir,'.review-runs')).length,0);
    assert.equal(await reapReviewWorktrees(cfg),0);
    await runQueuedReview({...cfg,review:{...cfg.review,maxConcurrent:1}},'a/repo',8,async()=>{});
    assert.equal(readdirSync(join(root,'.locks','reviews')).length,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Two PR preparations share a bare cache without changing each other’s checkout', async () => {
  const root=mkdtempSync(join(tmpdir(),'review-prepare-'));const cfg=config(root),base=seedCache(cfg,root);
  const source=join(root,'source');const git=(...args:string[])=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim();
  try {
    const heads:string[]=[];
    for(const value of ['first','second']) {writeFileSync(join(source,'file.txt'),value);git('commit','-qam',value);heads.push(git('rev-parse','HEAD'));}
    const octokit={pulls:{
      get:async({pull_number:n}:{pull_number:number})=>({data:{head:{sha:heads[n-1],ref:`pr${n}`},base:{sha:base,ref:'main'},user:{login:'author'},title:'PR',body:'',state:'open'}}),
      listReviews:async()=>({data:[]}),listReviewComments:async()=>({data:[]}),listFiles:async()=>({data:[{filename:'file.txt'}]}),
    },issues:{listComments:async()=>({data:[]})}} as never;
    let ready=0,release!:()=>void;const both=new Promise<void>(r=>{release=r;});const paths:string[]=[];
    await Promise.all([1,2].map(pr=>withReviewWorktree(cfg,'a/repo',pr,async(path,cache,signal)=>{
      const ctx=await runQueuedForRepo(cfg,'_review-cache/a/repo',()=>prepareWorkspace({repo:'a/repo',pr_number:pr,headSha:heads[pr-1]},octokit,'unused',path,{cacheRoot:cache,signal}));
      paths.push(path);ready++;if(ready===2)release();await both;
      assert.equal(ctx.headSha,heads[pr-1]);assert.equal(readFileSync(join(path,'file.txt'),'utf8'),pr===1?'first':'second');
      const diff=await reviewGit(['diff','--no-ext-diff',ctx.diffRefSpec,'--','file.txt'],{cwd:path});assert.match(diff,new RegExp(pr===1?'first':'second'));
    })));
    assert.equal(new Set(paths).size,2);assert.ok(paths.every(p=>!existsSync(p)));
    assert.equal(readdirSync(join(cfg.review.workspaceDir,'.review-runs')).length,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('SIGTERM aborts an active review and removes its worktree before process exit', async () => {
  const root=mkdtempSync(join(tmpdir(),'review-sigterm-'));const cfg=config(root),head=seedCache(cfg,root);
  const worker=join(root,'term.mjs'),ready=join(root,'ready');let child: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(worker,`import {withReviewWorktree,reviewGit} from ${JSON.stringify(new URL('../agents/common/src/review-worktree.ts',import.meta.url).href)};
import {writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
await withReviewWorktree(JSON.parse(process.env.TEST_CONFIG),'a/repo',7,async(path,cache,signal)=>{await reviewGit(['worktree','add','--detach',path,process.env.TEST_HEAD],{cwd:cache,signal});writeFileSync(process.env.TEST_READY,path);await delay(60000,undefined,{signal});});`);
    child=spawn(process.execPath,['--import','tsx',worker],{cwd:process.cwd(),env:{...process.env,TEST_CONFIG:JSON.stringify(cfg),TEST_HEAD:head,TEST_READY:ready},stdio:'ignore'});
    const done=new Promise<void>((resolveDone,reject)=>{child!.on('exit',()=>resolveDone());child!.on('error',reject);});
    for(let i=0;!existsSync(ready)&&i<200;i++)await delay(20);
    assert.ok(existsSync(ready));const path=readFileSync(ready,'utf8');child.kill('SIGTERM');await done;
    assert.equal(existsSync(path),false);assert.equal(readdirSync(join(cfg.review.workspaceDir,'.review-runs')).length,0);
  } finally {if(child?.exitCode===null)child.kill('SIGKILL');rmSync(root,{recursive:true,force:true});}
});

test('Cancellation terminates the native reviewer process group', {skip:process.platform==='win32'}, async () => {
  const root=mkdtempSync(join(tmpdir(),'review-cancel-cli-')),command=join(root,'fake.mjs'),marker=join(root,'pids');
  const abort=new AbortController();
  let pids:number[]=[];
  try {
    writeFileSync(command,`#!/usr/bin/env node
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit','ipc']});
child.on('message',()=>writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000);`,{mode:0o755});
    const pending=runAgyCli({spec:{api:'agy',baseURL:'agy://local',model:'fake',command},cwd:root,prompt:'review',signal:abort.signal});
    for(let i=0;!existsSync(marker)&&i<100;i++)await delay(20);
    assert.ok(existsSync(marker));pids=JSON.parse(readFileSync(marker,'utf8'));
    abort.abort(new Error('cancelled review'));
    await assert.rejects(Promise.race([pending,delay(5000).then(()=>{throw new Error('Escalation did not settle the review');})]),/cancelled review/);
    for(const pid of pids) {
      const stat=`/proc/${pid}/stat`;
      if(existsSync(stat))assert.equal(readFileSync(stat,'utf8').split(') ')[1]?.[0],'Z','descendant is no longer running');
    }
  } finally {
    abort.abort();
    if(pids[0])try{process.kill(-pids[0],'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    rmSync(root,{recursive:true,force:true});
  }
});

test('A forced over-limit review creates no worktree and releases its concurrency ticket', async () => {
  const root=mkdtempSync(join(tmpdir(),'review-cap-admission-'));
  const cfg={...config(root),github:{tokenEnv:'TEST_UNUSED'},models:{embedder:null},limits:{dailyReviews:0,dailyTokens:0},store:{backend:'sqlite'}} as ReviewerConfig;
  const signed=[1,2,3].map(id=>({id,submitted_at:'now',user:{login:'reviewer'},body:'<!-- revuto-signed -->'}));
  const auth={login:'reviewer',token:async()=> 'unused',octokit:{pulls:{get:async()=>({data:{head:{sha:'a'.repeat(40)},state:'open',draft:false,html_url:'https://example.test/pr'}}),listReviews:()=>{}},paginate:async()=>signed}} as unknown as GithubAuth;
  try {
    const result=await reviewOnePr(cfg,'a/repo',7,{force:true,githubAuth:auth});
    assert.equal(result.ranModel,false);assert.equal(result.tokens,0);assert.match(result.result,/3-round review limit/);
    assert.equal(existsSync(join(cfg.review.workspaceDir,'.review-runs')),false);
    assert.equal(readdirSync(join(root,'.locks','reviews')).length,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});
