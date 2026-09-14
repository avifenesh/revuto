import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveReviewRound, historicalReviewRounds } from '../daemon/src/review-rounds.js';
import { unreviewedOutcome } from '../agents/common/src/run-agent.js';
import { checkResultForOutcome } from '../daemon/src/review-check.js';
import type { GithubAuth } from '../agents/common/src/github-auth.js';

function counters() {
  const values = new Map<string, number>();
  return { values, getCounter: async (key: string) => values.get(key) ?? 0,
    incrCounter: async (key: string, by = 1) => { const n=(values.get(key)??0)+by; values.set(key,n); return n; } };
}

test('A PR receives three lifetime attempts, independent of commits and restarts', async () => {
  const store=counters();let historyCalls=0;
  const history=async()=>{historyCalls++;return 0;};
  for (let n=1;n<=3;n++) assert.deepEqual(await reserveReviewRound(store,107,3,history),{allowed:true,round:n,reason:`Review round ${n}/3`});
  const fourth=await reserveReviewRound(store,107,3,history);
  assert.equal(fourth.allowed,false);assert.match(fourth.reason,/manual review/);assert.equal(historyCalls,1);
  assert.equal((await reserveReviewRound({...store},107,3,history)).allowed,false);
  assert.equal((await reserveReviewRound(store,108,3,async()=>0)).allowed,true);
  assert.equal(checkResultForOutcome(unreviewedOutcome(fourth.reason,'a'.repeat(40))).conclusion,'failure');
});

test('Historical signed reviews seed the cap and failed attempts remain spent', async () => {
  const store=counters();
  const existing=await reserveReviewRound(store,728,3,async()=>8);
  assert.equal(existing.allowed,false);assert.equal(existing.round,8);
  assert.equal((await reserveReviewRound(store,729,3,async()=>2)).allowed,true);
  // Simulate a model error after reservation: there is deliberately no refund.
  assert.equal((await reserveReviewRound(store,729,3,async()=>0)).allowed,false);
});

test('Concurrent reservations cannot start more than three runs', async () => {
  const store=counters();
  const results=await Promise.all(Array.from({length:8},()=>reserveReviewRound(store,7,3,async()=>0)));
  assert.equal(results.filter(r=>r.allowed).length,3);
  await assert.rejects(reserveReviewRound(store,7,0,async()=>0),/positive integer/);
});

test('History counts only submitted signed reviews from configured identities', async () => {
  const reviews=[
    {id:1,submitted_at:'now',user:{login:'revuto-review[bot]'},body:'<!-- revuto-signed --> reviewed'},
    {id:1,submitted_at:'now',user:{login:'revuto-review[bot]'},body:'<!-- revuto-signed --> duplicate id'},
    {id:2,submitted_at:'now',user:{login:'owner'},body:'<!-- revuto-signed --> legacy review'},
    {id:3,submitted_at:'now',user:{login:'stranger'},body:'<!-- revuto-signed --> quoted footer'},
    {id:4,submitted_at:null,user:{login:'revuto-review[bot]'},body:'<!-- revuto-signed --> pending'},
    {id:5,submitted_at:'now',user:{login:'owner'},body:'manual review'},
  ];
  const auth={login:'revuto-review',octokit:{pulls:{listReviews:()=>{}},paginate:async()=>reviews}} as unknown as GithubAuth;
  assert.equal(await historicalReviewRounds(auth,'owner/repo',7,'owner'),2);
});
