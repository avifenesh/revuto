import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeInspectionTools } from '../agents/common/src/claude-review-mcp.js';
import { claudeEnvironment } from '../agents/common/src/claude-env.js';
import { loadConfig } from '../agents/common/src/config.js';

test('Claude inspection tools block outside paths, symlinks, secrets and command access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revuto-boundary-'));
  const outside = mkdtempSync(join(tmpdir(), 'revuto-outside-'));
  try {
    writeFileSync(join(root, 'source.ts'), 'SAFE_SOURCE_SENTINEL\n');
    writeFileSync(join(root, '.env'), 'PRIVATE_SENTINEL\n');
    writeFileSync(join(root, 'secret.pem'), 'PRIVATE_SENTINEL\n');
    writeFileSync(join(outside, 'private.txt'), 'OUTSIDE_SENTINEL\n');
    symlinkSync(join(outside, 'private.txt'), join(root, 'escape.txt'));
    const tools = await claudeInspectionTools(root);
    assert.deepEqual(tools.map(t => t.name).sort(), ['glob', 'grep', 'read']);
    const read = tools.find(t => t.name === 'read')!;
    assert.match(String(await read.callback({path:'source.ts'})), /SAFE_SOURCE_SENTINEL/);
    for (const path of [join(outside, 'private.txt'), 'escape.txt', '.env', 'secret.pem']) {
      const output = String(await read.callback({path}));
      assert.doesNotMatch(output, /PRIVATE_SENTINEL|OUTSIDE_SENTINEL/);
      assert.match(output, /ERROR|denied|permission|outside/i);
    }
    const grep = tools.find(t => t.name === 'grep')!;
    assert.doesNotMatch(String(await grep.callback({pattern:'SENTINEL',path:outside,output_mode:'content'})), /OUTSIDE_SENTINEL/);
    assert.doesNotMatch(String(await grep.callback({pattern:'SENTINEL',output_mode:'content'})), /PRIVATE_SENTINEL|OUTSIDE_SENTINEL/);
    await assert.rejects(claudeInspectionTools(root, '--output=/tmp/escape'), /Invalid immutable/);
  } finally {
    rmSync(root,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true});
  }
});

test('Fixed PR diff excludes sensitive files and cannot execute a configured diff driver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revuto-diff-'));
  const git = (...args:string[]) => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try {
    git('init','-q'); git('config','user.email','test@example.test'); git('config','user.name','Test');
    writeFileSync(join(root,'source.ts'),'before\n'); git('add','.'); git('commit','-qm','base');
    const base=git('rev-parse','HEAD');
    writeFileSync(join(root,'source.ts'),'AFTER_SENTINEL\n');
    writeFileSync(join(root,'.env'),'PRIVATE_SENTINEL\n');
    writeFileSync(join(root,'secret.key'),'PRIVATE_SENTINEL\n');
    writeFileSync(join(root,'.gitattributes'),'source.ts diff=hostile\n');
    git('config','diff.hostile.command','false'); git('config','diff.hostile.textconv','false');
    git('add','.'); git('commit','-qm','head');
    const tools=await claudeInspectionTools(root,`${base}..${git('rev-parse','HEAD')}`);
    const diff=tools.find(t=>t.name==='pr_diff')!;
    assert.throws(()=>diff.inputSchema.parse({args:['--output=/tmp/escape']}));
    const output=String(await diff.callback({}));
    assert.match(output,/AFTER_SENTINEL/); assert.doesNotMatch(output,/PRIVATE_SENTINEL/);
    await assert.rejects(async()=>diff.callback({path:'../outside'}),/Invalid PR diff path/);
    await assert.rejects(async()=>diff.callback({path:'.env'}),/Invalid PR diff path/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('PR diff pages beyond 2 MiB without losing content or overflowing a tool result', async () => {
  const root=mkdtempSync(join(tmpdir(),'revuto-diff-pages-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try {
    git('init','-q');git('config','user.email','test@example.test');git('config','user.name','Test');
    git('commit','--allow-empty','-qm','base');const base=git('rev-parse','HEAD');
    writeFileSync(join(root,'large.txt'),'x'.repeat(2*1024*1024)+'\nTAIL_SENTINEL\n');
    writeFileSync(join(root,'other.txt'),'OTHER_SENTINEL\n');
    git('add','.');git('commit','-qm','head');
    const tools=await claudeInspectionTools(root,`${base}..${git('rev-parse','HEAD')}`);
    const diff=tools.find(t=>t.name==='pr_diff')!;
    const first=JSON.parse(String(await diff.callback({path:'large.txt',limit:12000})));
    assert.equal(first.text.length,12000);assert.equal(first.next_offset,12000);
    assert.ok(first.total_characters>2*1024*1024);
    const last=JSON.parse(String(await diff.callback({path:'large.txt',offset:first.total_characters-1000})));
    assert.equal(last.next_offset,null);assert.match(last.text,/TAIL_SENTINEL/);
    assert.doesNotMatch(last.text,/OTHER_SENTINEL/);
    const stat=JSON.parse(String(await diff.callback({mode:'stat'})));
    assert.match(stat.text,/large.txt/);assert.match(stat.text,/other.txt/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Claude environment forwards provider auth without GitHub or executable settings', () => {
  const root=mkdtempSync(join(tmpdir(),'revuto-env-'));
  try {
    const settings=join(root,'settings.json');
    writeFileSync(settings,JSON.stringify({env:{CLAUDE_CODE_USE_BEDROCK:'1',AWS_BEARER_TOKEN_BEDROCK:'fake-provider',GH_TOKEN:'fake-github',NODE_OPTIONS:'--import=evil'},permissions:{allow:['Bash(*)']}}));
    const env=claudeEnvironment({HOME:root,PATH:'/usr/bin',GH_TOKEN:'fake-github',NODE_OPTIONS:'--import=evil'},settings);
    assert.equal(env.AWS_BEARER_TOKEN_BEDROCK,'fake-provider');
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK,'1');
    assert.equal(env.GH_TOKEN,undefined); assert.equal(env.NODE_OPTIONS,undefined);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('Search pages are bounded, explicitly complete, and sorted across nested glob matches', async () => {
  const root=mkdtempSync(join(tmpdir(),'revuto-search-pages-'));
  try {
    mkdirSync(join(root,'nested'));
    writeFileSync(join(root,'a.ts'),'MATCH '+ 'x'.repeat(100)+'\n');
    writeFileSync(join(root,'nested','z.ts'),('MATCH '+ 'x'.repeat(100)+'\n').repeat(6000)+'MATCH TAIL_SENTINEL\n');
    const tools=await claudeInspectionTools(root);
    const grep=tools.find(t=>t.name==='grep')!;
    const first=JSON.parse(String(await grep.callback({pattern:'MATCH',output_mode:'content',limit:10000})));
    assert.equal(first.text.length,10000);assert.equal(first.next_offset,10000);
    assert.ok(first.total_characters>512000);
    const last=JSON.parse(String(await grep.callback({pattern:'MATCH',output_mode:'content',offset:first.total_characters-1000})));
    assert.equal(last.next_offset,null);assert.match(last.text,/TAIL_SENTINEL/);
    const empty=JSON.parse(String(await grep.callback({pattern:'NO_MATCH_VALUE'})));
    assert.equal(empty.total_characters,0);assert.equal(empty.next_offset,null);
    const glob=tools.find(t=>t.name==='glob')!;
    let offset=0, all='';
    do {
      const page=JSON.parse(String(await glob.callback({pattern:'*.ts',offset,limit:17})));
      all+=page.text;
      if(page.next_offset===null)break;
      assert.ok(page.next_offset>offset);offset=page.next_offset;
    } while(true);
    assert.deepEqual(all.trim().split('\n'),[join(root,'a.ts'),join(root,'nested','z.ts')]);
    assert.throws(()=>glob.inputSchema.parse({pattern:'*.ts',head_limit:1}));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('Claude rejects unsupported effort at config load', () => {
  const root=mkdtempSync(join(tmpdir(),'revuto-config-'));
  try {
    const path=join(root,'revuto.config.json');
    const model={baseURL:'claude-cli://local',model:'claude-opus-5',api:'claude',auth:'none'};
    for (const reasoningEffort of ['none','minimal']) {
      writeFileSync(path,JSON.stringify({models:{review:{...model,reasoningEffort},curator:{baseURL:'http://localhost',model:'test'},distill:{baseURL:'http://localhost',model:'test'}}}));
      assert.throws(()=>loadConfig(path),/native Claude CLI reasoningEffort/);
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
