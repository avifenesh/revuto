# reviewer

A local, supplier-agnostic, repo-agnostic autonomous PR reviewer that **learns**.

Point it at any GitHub repo. It clones the repo, reads its PR history to build a
curated "textbook" of that repo's institutional knowledge, then reviews new PRs
and keeps learning from how maintainers respond — graduating repeated feedback
into reusable topic skills.

- **Supplier-agnostic.** Every model call is OpenAI-compatible. Bedrock (via a
  gateway), xAI/Grok, GLM, a local vLLM/Ollama — interchangeable per role
  (`review`, `curator`, `distill`, `embedder`) by editing config.
- **Runs locally.** No webhooks, no cloud infra. A scheduler polls each repo on a
  cron and learns from the delta since the last run.
- **Embedder optional.** Configure a local or cloud embedding model for similarity
  dedup + skill selection, or omit it and fall back to LLM-judged dedup + area-glob
  selection.
- **Knowledge is yours and visible.** Skills are markdown notes in an Obsidian
  vault (or any folder). Nothing is written into the reviewed repo.

## How it works

```
init   clone repo → scan structure → backfill ≤1000 PRs → distill maintainer-
       essence → compose <vault>/skills/<repo>/_textbook.md → register reviewer

review (cron)  poll open PRs since cursor → check out PR head → select textbook +
       relevant active topic skills → LLM review → post_review / skip_review

learn  (cron)  poll replies to the reviewer's comments since cursor → filter noise
       → dedup into the concerns store (bump count) → at 4× reinforcement, graduate
       a draft topic skill into the vault and delete the source concern

decay  (daily) age out concerns that never reach the graduation threshold
```

Graduated skills land as `draft` and are loaded by the reviewer only after
`reviewer approve` (or per-repo `autoActivate`).

## Layout

```
agents/common/src/   engine: model factory, run loop, tools, store, embedder, skills
agents/curator/src/  learning agent (concerns store tools, graduation, prompt)
daemon/src/          scheduler, poller, jobs, CLI, init bootstrap
ops/src/decay.ts     concern decay
webhook/src/heuristics.ts   comment-noise filter (reused by the poller)
agent-knowledge/     skill-writing guidance the curator/init follow
examples/, docs/legacy-aws/   reference samples + original AWS architecture notes
```

Per-repo state lives **outside** this repo, in the vault:

```
<vault>/reviewers/<owner>__<repo>.md     reviewer config note (schedules, allowlist, …)
<vault>/skills/<owner>__<repo>/_textbook.md   curated textbook (init output)
<vault>/skills/<owner>__<repo>/<slug>.md      graduated topic skills (draft|active)
<vault>/memory/<owner>__<repo>.sqlite         concerns + cursors + idempotency
```

## Setup

```bash
npm install
npm run build
cp reviewer.config.example.json reviewer.config.json   # edit vaultPath + models
export GH_TOKEN=ghp_...                                  # or: gh auth login
scripts/surreal-start.sh &                               # default memory backend (or set store.backend=sqlite)
```

Config (`reviewer.config.json`): `vaultPath`, `github.tokenEnv`, per-role `models`
(`{ baseURL, model, apiKeyEnv }`; `embedder` may be `null`), and `schedules`. See
`reviewer.config.example.json`.

## Providers

Any OpenAI-compatible endpoint works; set it per role in `models`. Verify reachability
with `reviewer doctor` before running.

```jsonc
// local llama.cpp (scripts/llama-server.sh) — keyless
{ "baseURL": "http://127.0.0.1:8080/v1", "model": "qwen3-8b" }

// hosted GLM (Z.ai OpenAI-compatible API)
{ "baseURL": "https://api.z.ai/api/paas/v4", "model": "glm-4.6", "apiKeyEnv": "GLM_API_KEY" }

// a self-hosted agent exposing /v1 (e.g. Hermes)
{ "baseURL": "http://127.0.0.1:PORT/v1", "model": "<served-name>", "apiKeyEnv": "HERMES_API_KEY" }
```

Tool calling is required (the reviewer/curator drive tools), so a local server must run
with a tool-capable chat template — `scripts/llama-server.sh` passes `--jinja` for that.

## Storage backend

Skills are always Obsidian markdown. The structured memory (concerns, embeddings,
cursors, idempotency) has two backends, set in `store.backend`:

- `surreal` (**default**) — SurrealDB, with native vector search
  (`vector::similarity::cosine`) for concern dedup. Start it first with
  `scripts/surreal-start.sh` (persistent surrealkv under the vault):

  ```jsonc
  "store": {
    "backend": "surreal",
    "surreal": { "url": "http://127.0.0.1:8000/rpc", "namespace": "reviewer",
                 "username": "root", "password": "root" }
  }
  ```

- `sqlite` — opt-in, zero dependency; a per-repo SQLite file under `<vault>/memory/`
  (no server to run). Set `"store": { "backend": "sqlite" }`.

## Usage

```bash
reviewer doctor                        # verify endpoints + GitHub token first
reviewer init <owner/repo> [maxPRs]    # onboard a repo (clone + backfill + textbook)
reviewer daemon                        # start the scheduler (review/learn/decay)
reviewer review <owner/repo> <pr>      # review one PR now
reviewer learn <owner/repo>            # run one learn pass now
reviewer decay <owner/repo>            # run decay now
reviewer approve <owner/repo> <slug>   # activate a draft skill
reviewer list                          # list registered reviewers
```

Run the daemon as a systemd user service to survive reboots — see
`deploy/reviewer.service`.

## Development

```bash
npm run typecheck
npx tsx scripts/smoke/graduation.ts    # store + 4× graduation + selection
npx tsx scripts/smoke/scheduler.ts     # registry + schedule planning
npx tsx scripts/smoke/scan.ts          # onboarding repo scan
```
