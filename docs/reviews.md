# How reviews run

## Review tiers: small, medium and large PRs

Revuto routes each pull request to one of three review tiers before any model call,
from the PR's file list and line counts. No LLM call is spent on routing.

| tier | model | takes |
|---|---|---|
| small | `models.reviewSmall` | every changed file is documentation (`review.small.docsOnly`), or at most `review.small.maxChangedLines` changed lines |
| medium | `models.reviewMedium` | at most `review.medium.maxCodeLines` changed code lines (default 500) |
| large | `models.review` | everything else, and any PR whose file list or size is incomplete |

Code lines are additions plus deletions in files that are neither documentation nor
tests (test directories, `*.test.*`, `*.spec.*`, `*_test.*`). A tier with no model
configured falls through to the next one. Each tier takes any model shape, native
CLIs included. The route shows in the daemon log (`model <name> (<tier> tier):
<reason>`); without `models.reviewMedium`, the log still says when the medium tier
would have taken a PR. Nothing posted to GitHub names the model.

```jsonc
"models": {
  "review":       { "name": "claude-opus",   "api": "claude", "baseURL": "claude-cli://local", "auth": "subscription", "model": "claude-opus-5-5", "reasoningEffort": "high" },
  "reviewMedium": { "name": "codex-high",    "api": "codex",  "baseURL": "codex://openai",     "auth": "subscription", "model": "gpt-6.1-sol", "reasoningEffort": "high" },
  "reviewSmall":  { "name": "codex-medium",  "api": "codex",  "baseURL": "codex://openai",     "auth": "subscription", "model": "gpt-6.1-sol", "reasoningEffort": "medium" }
},
"review": {
  "small": { "maxChangedLines": 200, "docsOnly": true, "docsExtensions": [".md", ".mdx", ".txt", ".rst", ".adoc"], "docsPaths": ["docs/", "doc/", "notes/"] },
  "medium": { "maxCodeLines": 500 }
}
```

`maxChangedLines: 0` turns the small size rule off; `docsOnly: false` turns the docs
rule off; `maxCodeLines: 0` turns the medium tier off.

### Risk paths and hotspots

Risk paths and hotspots send a PR to the large tier whatever its size. A changed code
file (not docs, not tests) that matches a `review.risk.paths` glob, or the area of a
learned concern reinforced at least `review.risk.hotspotMinReinforcement` times
(default 3; 0 turns hotspots off), routes the PR to `models.review`. The log says
which file matched what. A replay of 400 recent PRs found a threshold of 2 moved 58%
of medium-tier PRs to the large tier; 3 moves 23%.

```jsonc
"review": { "risk": { "paths": ["**/auth/**", "**/migrations/**", ".github/workflows/**"], "hotspotMinReinforcement": 3 } }
```

### Escalation

A small or medium tier can hand a PR to the large tier once (`review.escalate`,
default `true`). The reviewer answers `escalate` with a reason when it cannot settle
part of the change, and a native runner that hits its step or turn budget escalates
instead of failing. The large tier then reviews the whole PR with the first pass's
reason in its prompt. The outcome counts both passes' tokens and steps, so daily token
limits see the full cost. The log says `<tier model> escalated to <large model>: <reason>`.

### Shadow sampling

`review.shadowSample` (0 to 1, default 0) measures what the cheaper tiers miss. That
share of small and medium reviews also runs on the large tier after the real review,
in the same workspace, posting nothing. Each comparison is appended to
`<vault>/.shadow/<YYYY-MM>.jsonl`: both tiers' decisions, the large tier's comment
locations, both token counts, and whether they agree. The log line ends in `agree` or
`DISAGREE`. Shadow runs need a native large tier; their tokens are recorded in the file,
not added to the review's outcome or the daily token count.

## Re-reviews look at what changed

When revuto reviews a new head of a PR it already reviewed, the review covers what
changed since its last reviewed head (`review.incremental`, default `true`). The last
reviewed head is the commit of revuto's newest signed review on an earlier head. When
that commit is still an ancestor of the new head, the review is routed by the size of
`<last>..<head>` in the PR's own files, so a merge from the base branch does not
count, and the reviewer gets a re-review note with the changed files. Native CLI
runners also get a `new_changes` tool with that diff; `pr_diff` still returns the
whole PR diff, and inline comments still land on lines of the full PR diff. A
force-push that rewrote the reviewed head, a file list cut at one page, or no earlier
revuto review means a full review. The daemon log says `re-review since <sha>`.

## Round cap

`review.maxRounds` defaults to **3 model-run attempts per PR across all commits**.
Signed reviews already posted by the configured reviewer seed the lifetime count.
A reserved attempt counts even if the run errors; a new push, daemon restart, or
`--force` does not reset or bypass it. At the cap, automatic review/fix cycles stop
and the check stays failed with a manual-review explanation. Reaching the cap
never approves or merges a PR. The separate `maxSteps` limit bounds a single run.

## Final review after the cap

An orchestrator that runs a PR through many revisions usually ends past the cap,
so the head that merges was never reviewed. `revuto review <owner/repo> <pr> --final`
asks for one review of the current head after the cap:

- Past the cap it allows exactly one review per head SHA, reserved under
  `final-review:<pr>:<headSha>` before the model runs. A run that reaches a decision
  (a posted review or a clean skip) spends it, even if the job fails afterwards. A
  second `--final` at that head is refused with the reason; a new head gets its own.
- A run that fails before a decision (the model CLI is not logged in, it crashes, or
  it ends without a terminal tool) posted no verdict, so the reservation is refunded
  and the claim released: the next `--final` at that head runs. Normal rounds are
  never refunded.
- Below the cap it is a normal round and spends it.
- The daily review and token limits still apply. A refusal there spends nothing.
- A head the daemon already refused at the cap is marked done; `--final` takes its
  own claim on that head, so the marker does not block it. A head still under the
  cap that was already reviewed stays reviewed.
- The posted review summary, the check title and the App approval say
  "Revuto final review (round cap reached)". Pass and fail work as for any review.

`revuto review` exits with a code an orchestrator can act on:

| code | meaning |
|---|---|
| 0 | the review ran and passed |
| 1 | the review ran and failed (no decision, a failed post, a skip without inspection) or an error |
| 2 | the review ran and posted blocking concerns |
| 3 | refused or not run (round cap, final review already used, daily limit, draft, head already reviewed) |

When the orchestrator has finished its own rounds:

```bash
revuto review owner/repo 123 --final
```

## Concurrency, workspaces and inspection

A PR head whose files add up to more than `review.maxCheckoutBytes` (default 4 GiB) is
not checked out, and its review fails: revuto reads every blob size from one GitHub
tree call first, so a PR of small, compressible files cannot expand to fill the disk.
0 turns the check off.

The reviewer's prompt keeps facts revuto checked (numbers, SHAs, logins) apart from
text the PR author and commenters wrote (title, branch names, body, file names,
comments), which arrives in one fenced block marked as data, never instructions.

Reviews use up to `review.maxConcurrent` slots globally (default 4) and
`review.maxConcurrentPerRepo` per repository (default 2), with one active run per
PR. These limits cover the daemon, webhooks and manual CLI processes. Waiting
reviews are admitted in order when their repository has capacity.
Each run gets a detached worktree from a shared bare Git cache. The checkout and
its Git registration are removed after success, failure or cancellation; daemon
startup reaps worktrees left by crashed processes. The bare cache is retained to
avoid fetching the repository again. Round and daily-review limits remain enforced.
The CLI returns a verdict; Revuto retains GitHub posting authority. Structured
output alone does not count as inspection: a verdict returned without a single
evidence read is discarded and the turn runs once more with the requirement
spelled out, and a second uninspected verdict fails the review before posting.
A failing CLI/model does not silently switch to another provider.
