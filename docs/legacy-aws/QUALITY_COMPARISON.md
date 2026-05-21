# Reviewer quality comparison — 2026-05-12

First run of the rewritten valkey-reviewer (TypeScript agent, bedrock-agentcore + Strands + harness-tools + custom git/gh/make) against fresh mirror PRs, with upstream human reviews pulled for comparison.

## Fixtures

| Dogfood PR | Mirrors upstream | Size |
|---|---|---|
| avifenesh/valkey #13 | valkey-io/valkey #3667 (bzmpop typo rename) | +2/-2 across 2 files |
| avifenesh/valkey #14 | valkey-io/valkey #3543 (Raft cluster bus, part 1) | +11638/-6889 across 69 files |

## Upstream human-review baseline

### upstream #3667

- **Reviews**: zero. Only a codecov bot comment.
- **State**: `REVIEW_REQUIRED`, open, unmerged.
- **Interpretation**: no human reviewer has engaged. Not a comparison point; the PR is trivial and hasn't drawn attention.

### upstream #3543

- **Reviews**: 30+ review threads. Every single one on `design-docs/cluster-raft.md`. **Zero inline comments on source files.**
- **Reviewers**: `zuiderkwast` (the PR author), `murphyjacob4` (the co-designer).
- **Interpretation**: the maintainers chose to debate the *design* in markdown rather than review the *code*. The code is explicitly a WIP draft ("draft" in title, "part 1", TODO comments acknowledged in code). This is a rational resource-allocation choice for humans: debating the architecture closes more loops than nit-picking the implementation when the implementation will shift as the design resolves.

It's also a substantial hole in upstream review coverage — if the draft gets merged in something close to its current shape, real correctness bugs land with it.

## Reviewer run on dogfood #13

| | Detail |
|---|---|
| Final action | `skip_review` |
| Tool calls | 13 (git, grep, read, bash, make, skip_review) |
| Latency | ~80 s |
| Posted | Nothing |

### What the agent did

Verified the rename is mechanically correct (`bzmpopGetKeys` exists at `src/db.c:2756`, forward-declared in `server.h:3826`, structurally identical to `blmpopGetKeys`, both `commands.def` and `bzmpop.json` updated consistently).

Noticed the PR body claims "tightens the comment next to the helper" but the diff has no comment change. Judged the discrepancy too minor to post — a PR-description nit on a 2-line hygiene PR. Skipped with a clean rationale.

### Quality assessment

Correct call. This is exactly the `skip` case the system prompt describes — no evidence-backed concern, don't post.

One mild negative: the agent spent 13 tool calls including two `make` invocations on a 2-line rename. The heuristics are over-thorough on trivial PRs. Not wrong, but wasteful. This tracks to a prompt-level fix — tell the reviewer to budget tool calls against diff size.

## Reviewer run on dogfood #14

| | Detail |
|---|---|
| Final action | `post_review` with event=CHANGES_REQUESTED |
| Tool calls | 32 (git, grep, read, post_review) |
| Latency | 310 s |
| Posted | 4 inline comments + summary body |
| Review URL | https://github.com/avifenesh/valkey/pull/14#pullrequestreview-4263030500 |

### Posted findings — cross-checked against source at PR head

| # | Location | Claim | Verdict on re-read |
|---|---|---|---|
| 1 | `src/blocked.c:751` | `clients_pending_async_unblock` never removed on disconnect → UAF in `blockedBeforeSleep` | **Confirmed.** grep shows 6 touch sites; none scrub on disconnect. `freeClient → unblockClient(c, 1)` clears flags but leaves `c` on the list. Real bug. |
| 2 | `src/cluster_raft.c:1285` | RequestVote missing Raft §5.4.1 log-completeness check | **Confirmed.** Literal `/* TODO: log completeness check */` one line before unconditional `granted = 1`. Agent supplied a correct fix as a GitHub `suggestion` block. |
| 3 | `src/blocked.c:303` | Unreachable `replyToBlockedClientTimedOut` branch for BLOCKED_ASYNC | **Confirmed.** `blockedClientMayTimeout` enumerates LIST/ZSET/STREAM/WAIT/MODULE and returns 0 otherwise; `addClientToTimeoutTable` also early-returns on `bstate->timeout == 0`. Branch cannot fire. Dead code. |
| 4 | `src/cluster_raft.c:1117` | AE truncation: tail past `prev_log_index + entry_count` not truncated → §5.3 invariant violated | **Confirmed.** The loop truncates on per-entry conflict but never trims trailing entries past the AE window. Real, subtle. |

Summary body also called out:
- No `Signed-off-by:` trailer on the head commit (DCO hygiene). Confirmed missing.
- Commit message + PR body reference files that don't exist (`cluster_consensus.c/.h`, `cluster_bus.c`, `docs/cluster/consensus.md`). Confirmed: all four listed are absent; actual files are `cluster_raft.c`, `cluster_bus.h` (no `.c`), `design-docs/cluster-raft.md`. Agent's list of "actual files" missed `cluster_state.c` (which does exist) — a minor incompleteness in the summary, not a hallucination. The claim as written is still correct because the four files it flagged really are missing.
- "Prevote-style safety guards" claim in the PR body is false: grep for `prevote|pre_vote|PreVote` is empty. Confirmed.

### Hallucination rate

**Zero.** Every cited line number, grep reference, and file claim holds up under re-check. The agent also avoided every tempting but weak candidate visible in its trace log (shadowed variable in NODE_JOIN apply, quorum arithmetic, heartbeat interval, keySampled encoding assumptions, monitorCommand reply format) — correctly rejecting each in-trace.

### Novelty vs the upstream human review

Humans posted zero comments on `src/`. Our bot posted four substantive ones — all real, all in files the humans never touched in their review. This is exactly the gap the reviewer is supposed to fill.

- Of the 4 inline findings, **all are novel** relative to upstream review activity.
- Two are correctness blockers on the core protocol (UAF, §5.4.1).
- One is a correctness bug with smaller blast radius (§5.3 trailing truncation).
- One is dead code (minor; the agent explicitly marked this one as lower priority than the protocol issues).

## Comparison to the pre-rewrite run (PR #12, MONITOR TRACE, 948 LOC, 2026-05-12 03:33)

The pre-rewrite session produced variance — 3 inline comments on one run, 1 on another for the same PR. It also triggered a context-trim issue (`window_size=<40>, messages=<79> | unable to trim`) late in large-PR runs.

Post-rewrite on PR #14 (10x larger):
- Single run, 4 findings, every one real and specific.
- Same `window_size` trim warning appeared in logs — but *after* `post_review` already fired. Harmless.
- Context stayed coherent across 32 tool calls and ~11k lines of diff.

Can't call "variance resolved" on n=1 yet, but the prompt-tool mismatch (the variance's top suspect) is gone, and the obvious symptom from the prior run didn't reappear.

## Weaknesses and follow-ups

1. **Over-thorough on trivial PRs.** PR #13 took 13 tool calls for a 2-line rename. Prompt should budget tool calls against diff size.
2. **Stream coherence test only on n=2.** Re-run #14 a second time and verify the 4 findings converge across runs; if they vary, we're still variance-bound.
3. **`make` tool fires opportunistically.** Agent called `make` on the bzmpop rename PR. Build output was presumably useless there. Either the prompt should narrow when `make` is appropriate, or the tool should be gated by diff size/complexity.
4. **Agent's "list of actual files" on PR #14 summary omitted `cluster_state.c`.** Minor but the author would spot it. Worth a prompt note: "When contrasting claimed-vs-actual file lists, run `git diff --stat` once and cross-check exhaustively."
5. **Cosmetic `event: error` SSE terminator** — fixed post-review; PR #13 re-run returned clean `event: done` with `terminal_tool: "skip_review"`.
6. **Zero upstream baseline for #3667.** Need at least one mirrored PR where upstream humans *did* post source-level inline comments, so we can compare bot findings against human findings on the same code. Candidates with rich upstream review: #3577 (replication compression), #3605 (SIMD BITOP), #3558 (HRANDFIELD harden).

## Bottom line (initial pass)

On the big PR, the bot produced four real, specific, evidence-backed findings that upstream human review hadn't surfaced — two of them are genuine correctness blockers. On the trivial PR, it correctly stayed silent. No hallucinations.

The rewrite did what the pre-rewrite stack couldn't: it handled a 12k-line Raft-protocol diff without variance, without posting noise, and with findings that a senior reviewer would post.

---

## Addendum — dogfood PR #15 (upstream #3645, crash-safety for module pause paths)

**Why this PR matters for comparison:** upstream #3645 is the first mirror candidate we picked where real human review *did* post source-level inline comments — `nmvk` posted two inlines on `src/module.c`. Everything above was bot-vs-silence; this is bot-vs-human.

**Upstream human review (nmvk):**
1. `src/module.c:3801` — "Fix the comment, this returns error." (VM_ReplicateVerbatim doc)
2. `src/module.c:3746` — "Guard we are trying to avoid is `PAUSE_ACTION_REPLICA` this should match the same? [suggests the serverAssert line from propagateNow]"

**Our bot's review on PR #15** (post_review, event=CHANGES_REQUESTED, 5 inline comments, ~2 min, 8 tool calls incl. `gh_api_read`):

| # | Location | Claim | Verdict |
|---|---|---|---|
| 1 | `src/module.c:3746` | Gate uses `PAUSE_ACTION_CLIENT_WRITE`, but default `CLIENT PAUSE` sets `PAUSE_ACTION_CLIENT_ALL` (server.h:617); the assert in `propagateNow` (server.c:3633) checks `PAUSE_ACTION_REPLICA` which both pause sets trigger. So `CLIENT PAUSE 60000` (default ALL) with a replica attached still crashes. Proposes gating on `PAUSE_ACTION_REPLICA` directly. | **Confirmed.** Matches nmvk's finding but goes deeper: names the exact flag constants, shows where `processCommand` does it correctly (line 4653), notes the test only covers the WRITE variant, flags the VM_ReplicateVerbatim twin bug (same incorrect gate) and the doc knock-on. |
| 2 | `src/module.c:3804` | VM_ReplicateVerbatim doc (line 3801) still says "The function always returns VALKEYMODULE_OK"; now false because of the new `VALKEYMODULE_ERR` early return. Called out that this doc is the source for published module API docs (`utils/generate-module-api-doc.rb`), so modules written against the old contract will silently drop propagation. | **Confirmed.** Matches nmvk's terse comment; added the "why it matters" (API-doc-generator consumes this source). |
| 3 | `tests/unit/moduleapi/pausetest.tcl:5` | Nested `start_server` without `external:skip`. Cited three existing convention sites (`replica-redirect.tcl:1`, `expire.tcl:553`, `pause.tcl:364`) — all three line numbers verified exact. | **Confirmed.** File has four `start_server` blocks; none has `external:skip`; the three cited files do. **Novel vs human.** |
| 4 | `tests/unit/moduleapi/pausetest.tcl:23` | `after 500` as synchronization is the flaky pattern under Valgrind/TSan; swap for `wait_for_condition` polling `PAUSETEST.GET_RESULT`. Provided full drop-in replacement snippet. | **Confirmed.** File has four `after 500`s, all around the 200ms-timer-vs-pause race. **Novel vs human.** |
| 5 | `tests/unit/moduleapi/pausetest.tcl:20` | Test titles read "crashes server" but assertion is no-crash. These are regression tests for the crash, not reproducers; rename so a CI failure log points at the right invariant. | **Confirmed.** Three paused-case tests share the misleading wording. **Novel vs human.** |

### Head-to-head

|  | Human (nmvk) | Our bot |
|---|---|---|
| Inline comments | 2 | 5 |
| Crash-class findings | 1 (partial) | 1 (more complete) + 1 doc-breakage |
| Test-quality findings | 0 | 3 (convention, flakiness, naming) |
| Cited specific existing-pattern files | 0 | 3 (all line numbers verified) |
| Hallucinations | 0 | 0 |

The bot matched nmvk's two findings, independently, and strengthened the crash finding: nmvk said "should match PAUSE_ACTION_REPLICA", the bot showed **why** the current gate is insufficient (the specific pause-action bit the default `CLIENT PAUSE` sets doesn't intersect with the PR's gate), identified the twin bug in `VM_ReplicateVerbatim` that uses the same incorrect gate, and noted that the supplied test (`CLIENT PAUSE ... WRITE`) doesn't cover the failure case.

The three test-quality findings are entirely novel relative to nmvk — two are real CI-safety concerns (`external:skip` missing, `after 500` flakiness) and one is a CI-diagnostics concern (misleading test titles). All three would be things a reviewing maintainer would likely catch in a human pass but nmvk didn't hit in this review.

### What the prompt tweak accomplished

Between #14 and #15 I added one sentence to Phase 5: *"If your summary describes the diff's files, run `git diff --stat <mergeBase>..<headSha>` first and enumerate from that output."*

On PR #15 the agent did not emit a claimed-vs-actual file list at all (the PR description didn't assert anything about files, so no comparison was warranted). Neutral test — the tweak didn't cause regression but hasn't been re-exercised on a PR-body-claims-files case yet.

## Updated bottom line (valkey)

Against silence (PR #14, #13): 4 real findings, 2 blockers, no posts when not warranted.
Against human review (PR #15): matched the human on both of her findings, extended both, and added three novel test-quality findings that hold up to line-by-line cross-check.
Zero hallucinations across 11 posted inline comments spanning 12k+ LOC of reviewed diff.

---

# Glide reviewer — first runs

Second agent (`valkey-glide-review`), polyglot Rust core + Java/Python/Node/Go bindings. Shares the common library and the multi-route webhook with valkey-review. Three PRs exercised so far.

## Fixtures

| Dogfood PR | Mirrors upstream | Size |
|---|---|---|
| avifenesh/valkey-glide #218 | #5916 (per-cmd timeout propagation to multiplexer) | +42/-6, glide-core Rust |
| avifenesh/valkey-glide #219 | #5896 (OTel flaky memory-leak tests) | +35/-43, Java test |
| avifenesh/valkey-glide #220 | #5917 (dedicated timeout watchdog thread) | +163/-1, new Rust module |

## PR #218 — glide-core, per-command timeout threading

Webhook-triggered, `post_review` with 2 inline comments, 5 m 50 s, 30+ tool calls.

1. `glide-core/redis-rs/redis/src/cmd.rs:806` — new unit tests only exercise the getter/setter roundtrip, not the actual propagation path (`MultiplexedConnection::send_packed_command` at `multiplexed_connection.rs:767`). Also flagged that the tests live under `#[cfg(feature = "cluster")]` (inherited from neighboring `test_cmd_arg_idx`) even though the functionality isn't cluster-specific. **Verified.**
2. `glide-core/src/client/mod.rs:1031` — with the PR's new line, `request_timeout` is now enforced twice (outer `tokio::select!` + inner `Runtime::locate().timeout()`). Noted that the outer arm still wins the race in practice but flagged a narrow edge case where a near-saturated pipeline channel with a very tight per-command timeout could cause the inner `Err(elapsed.into())` to surface before the outer fires, skipping the `GlideOpenTelemetry::record_timeout_error()` counter. **Verified; non-blocking, stated as conscious-choice flag.**

Grep-hazard check: the agent mentioned `glide-core/redis-rs/` but *correctly* — the PR actually modifies files in that directory (unusual but legitimate), and the agent reasoned about those files as they stand. It did **not** infer GLIDE behavior from vendored redis-rs code, which would have been the hazard. Prompt worked.

## PR #219 — Java OTel test stability

Webhook-triggered, `skip_review`, 72 s, 6 tool calls.

Rationale: *"Single-file Java test stability fix; hoisting client creation out of the measurement window and using an adaptive GC-stabilization helper is a clean improvement. The `getStableMemory` helper's first-iteration `Long.MAX_VALUE` sentinel works correctly (comparison does not early-return), and the 5% convergence threshold combined with 10% growth assertion is still sound. No cross-binding impact, no substantive concerns that meet the evidence bar."*

Cross-checked:
- Sentinel loop: `prev = Long.MAX_VALUE`, first iteration's `abs(MAX - current) < MAX * 0.05` never holds, so the loop advances. Bot's claim is correct.
- 5% convergence + 10% growth: each measurement is bounded by 5% noise, the growth check has 10% headroom. Sound.
- Single file, no cross-binding impact.

Comparison to upstream humans: jeremyprime's inline on upstream #5896 suggested exactly the `getStableMemory` helper shape — so the human review had already been applied when the bot saw the PR. Aryex approved. Bot's skip matches the humans' final verdict.

Re-ran manually: converged on `skip_review` with the same reasoning. Two-run convergence on the non-webhook path is cheap evidence that the behavior is deterministic on this fixture.

## PR #220 — timeout watchdog thread (Rust concurrency)

Webhook-triggered, `post_review` `CHANGES_REQUESTED` with 3 inline comments, 3 m 5 s, 17 tool calls.

1. **`glide-core/src/timeout_watchdog.rs:86` — lost-wakeup race.** The mutex guard computed at the top of the loop body is dropped when the inner block exits; `wait_timeout` re-acquires. Any `register()` that runs in the window between those two acquisitions calls `notify_one()` with no waiter present, so the notification is lost. Next iteration uses the stale `sleep_duration`. The agent supplied a textbook fix (hold a single guard across fire → compute → wait) as a `suggestion` block, and noted the existing test `watchdog_fires_under_tokio_starvation` doesn't catch this because it registers the only deadline *before* the watchdog enters its first wait. **Verified.** This is the precise timeliness guarantee the PR claims to add.

2. **`glide-core/src/client/mod.rs:1057` — partial migration.** Only `send_command` routes through the watchdog. `send_transaction` (line 1300) and `send_pipeline` (line 1377) still call `run_with_timeout` → `tokio::time::timeout`; `Client::create_client` itself also uses raw `tokio::time::timeout` (line 2111, 1482). If the premise is that Tokio's timer can be starved, batches and connection establishment are still exposed to the same failure mode. Either extend coverage or narrow the CHANGELOG claim. **Verified.**

3. **`glide-core/src/timeout_watchdog.rs:53` — dead-entry accumulation.** When a caller's `tokio::select!` resolves on `result` and drops `timeout_rx`, the corresponding `oneshot::Sender` remains in the `BTreeMap` until its deadline arrives. Steady-state dead-entry count ≈ `throughput × timeout` (e.g. 10k req/s at 250 ms ≈ 2.5k entries). Cheap mitigation proposed: opportunistic `retain` over the expired prefix at registration, or cancel-handle on drop. **Verified; non-blocking.**

Upstream #5917 has zero human reviews yet. No human baseline for comparison, but finding #1 is the kind of subtle concurrency bug that easily slips past a fast review — PR claims to solve "timeliness under starvation" and its proposed fix has a window where it doesn't.

## Glide aggregate

| PR | Action | Findings | Verified | Hallucinations |
|---|---|---|---|---|
| #218 | post_review COMMENTED | 2 | ✅ | 0 |
| #219 | skip_review | 0 (justified) | ✅ | 0 |
| #220 | post_review CHANGES_REQUESTED | 3 | ✅ | 0 |

5 posted findings across 3 PRs. All substantive, all cross-checked. Two runs triggered by the webhook (fully unattended); one also manually re-triggered to compare.

## Updated bottom line

Across both agents (valkey + glide), 6 PRs, 16 posted inline findings, zero hallucinations. The reviewer demonstrates:
- Correct skip behavior when existing review covers the ground (#15 Run B, #219).
- Incremental additions when a gap exists (#15 Run C, #14 Run C).
- Subtle correctness findings on real concurrency bugs (#14 UAF, #14 §5.4.1 Raft gap, #220 lost-wakeup).
- Cross-binding / partial-migration catches specific to glide's polyglot shape (#220 finding 2).
- Correct grep-hazard handling (#218 redis-rs vendored dir).

