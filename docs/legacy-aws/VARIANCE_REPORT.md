# Variance report — 2026-05-12

Goal: answer the motivating question from the pre-rewrite session, where the same 948-LOC PR produced 3 inline comments on one run and 1 on another.

Test: run the reviewer three times on each of PR #14 (big, +11k/-7k Raft) and PR #15 (medium, +273/-1 module pause), comparing finding sets.

## PR #14 (big: +11638/-6889, 69 files, Raft cluster consensus)

| Run | Terminal | Inline count | Issue comments | Notes |
|---|---|---|---|---|
| A | `post_review` CHANGES_REQUESTED | 4 | 0 | Clean start; found UAF, §5.4.1, dead branch, §5.3 truncate |
| B | `skip_review` | 0 | 0 | Reviewed A's thread; confirmed its own investigation converged on the same 4 findings, no gap → stood down. (Took ~9 min; finished outside the initial 6-min observation window.) |
| C | `post_review` CHANGES_REQUESTED | 2 | 0 | Added 2 novel findings not in A or B |

**Run A inlines:**
1. `src/blocked.c:751` — UAF in `clients_pending_async_unblock`
2. `src/cluster_raft.c:1285` — RequestVote missing §5.4.1 log-completeness check
3. `src/blocked.c:303` — unreachable BLOCKED_ASYNC timeout branch
4. `src/cluster_raft.c:1117` — AE truncate window too narrow (§5.3)

**Run C inlines (on top of Run A already being visible):**
1. `src/cluster_raft.c:1205` — `match_index` set to follower's *entire* log length, not `prev_log_index + entry_count`. Combined with the §5.4.1 gap, allows committed-entry loss.
2. `src/cluster_raft.c:903` — `NODE_FORGET` apply frees the node but only scrubs `server.cluster->slots[]`; leaves dangling pointers in `migrating_slots_to[]` / `importing_slots_from[]`. (cluster_state.c:600-601 shows `clusterDelNode` handles all three; this path is strictly missing that.)

Both Run C findings cross-checked against source — real, no hallucinations. **Run C's summary body explicitly states** it read Run A's review and is adding two issues it saw Run A didn't cover. This is the correct contract.

**Between-run novelty:** across 3 runs on PR #14, the bot posted 6 distinct findings. Runs A and C are complementary, not redundant. Run A found the tree of concerns around `blocked.c` + two `cluster_raft.c` issues; Run C found two more `cluster_raft.c` issues that are arguably the most severe (match_index error is a committed-entry-loss path).

## PR #15 (medium: +273/-1, module pause)

| Run | Terminal | Inline count | Issue comments | Notes |
|---|---|---|---|---|
| A | `post_review` CHANGES_REQUESTED | 5 | 0 | Full review; matched both nmvk findings + 3 novel test-quality |
| B | `skip_review` | 0 | 0 | Correctly judged A covered everything, no gap |
| C | `post_review` COMMENTED | 1 | 1 | Found a real miss in A (VM_Replicate doc twin) + DCO gate A missed |

**Run A inlines:** CLIENT PAUSE ALL gate gap, VM_ReplicateVerbatim doc, external:skip missing, after-500 flakiness, misleading test titles.

**Run B:** no-op. Reviewed the existing review thread, confirmed every finding it had was already covered.

**Run C inline + issue:**
1. `src/module.c:3745` — `VM_Replicate` doc block has the same "out-of-date return contract" problem Run A flagged on `VM_ReplicateVerbatim`. Run A missed this twin.
2. Issue comment — DCO sign-off missing on the head commit.

Both Run C catches are real and were genuine gaps in Run A.

## Interpretation

The pre-rewrite variance was symptom of:
1. The prompt claiming tools the agent didn't have (so the agent "self-critiqued" against a richer-than-real surface).
2. No deterministic dedup when the agent re-encountered the same diff.

Post-rewrite, the observed variance has a different character:

- **When the agent finds no gap in existing review**, it correctly skips (Run B on #15).
- **When the agent finds a real gap in existing review**, it posts only that gap (Run C on #15, Run C on #14).
- **When the agent runs cold with no existing review**, it produces a comprehensive first-pass review (Run A on both).

Across 6 runs, 6 distinct real findings on PR #14, 7 distinct real findings on PR #15, zero hallucinations, zero duplicate posts. The "run twice and compare" experiment surfaces *more* findings without *dropping* any — the opposite of the pre-rewrite variance problem.

## Implications

1. **The pre-rewrite variance problem is resolved in its symptomatic form.** We no longer see same-PR-same-inputs-different-findings as random jitter. We see it as monotonic accumulation — each run either skips or adds novel findings.
2. **Running the reviewer multiple times is a valid strategy.** Not because a single run is unreliable, but because incremental passes catch what a first pass misses. Two-pass review gets you +2 findings on a big PR for ~2x cost.
3. **`skip_review` works.** Run B's decision to stand down after reading the existing thread is the contract we want.

## Cosmetic

All three PR #15 runs and Run C on PR #14 completed with clean `event: done`. The earlier `event: error` terminator is gone post-fix.

## Latency observation

Runs on the big PR span ~5–9 minutes depending on whether the agent lands in Phase 1 quickly or wanders through `glob`/`grep` exploration before converging. The ~9-min upper bound is comfortable below the 20-minute CLI read timeout but should inform webhook timeout design — Lambda's 15-minute ceiling is adequate but not generous.
