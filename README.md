# revuto

[![CI](https://github.com/avifenesh/revuto/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/revuto/actions/workflows/ci.yml)
[![CodeQL](https://github.com/avifenesh/revuto/actions/workflows/codeql.yml/badge.svg)](https://github.com/avifenesh/revuto/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/revuto.svg)](https://www.npmjs.com/package/revuto)

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

## Install

```bash
npm i -g revuto          # or run ad-hoc: npx revuto <command>
```

Needs Node ≥ 20. `better-sqlite3` ships prebuilt binaries. For the default SurrealDB
memory backend, install [SurrealDB](https://surrealdb.com) separately and start it
with `revuto`'s `scripts/surreal-start.sh` — or set `store.backend` to `sqlite` for
zero external deps.

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
`revuto approve` (or per-repo `autoActivate`).

## Setup

```bash
revuto init-config                       # writes <vault>/revuto.config.json (default ~/revuto) — edit models
export GH_TOKEN=ghp_...                  # or: gh auth login

# default backend is SurrealDB — install it (https://surrealdb.com) and start it:
surreal start --user root --pass root --bind 127.0.0.1:8000 surrealkv://"$HOME"/revuto/memory/surreal &
#   …or set "store": { "backend": "sqlite" } in the config for zero external deps.

revuto doctor                            # verify models + store backend + GitHub token
```

**Config lives in the vault by default.** `init-config` writes
`<vault>/revuto.config.json`, where `<vault>` is `$REVUTO_VAULT` or `~/revuto`, so
config + skills + reviewer notes all sit in one Obsidian-editable place. `loadConfig`
resolves in order: `$REVUTO_CONFIG` → `./revuto.config.json` (local override) →
`<vault>/revuto.config.json` → `./reviewer.config.json`. Use `init-config --local` to
drop the config in the current dir instead (it still points `vaultPath` at the vault).

Config keys: `vaultPath`, `github.tokenEnv`, per-role `models`, `schedules`,
`limits`, and `store`. Model specs require `baseURL` and `model`; optional keys
are `name`, `apiKeyEnv`, `api`, `auth`, `reasoningEffort`, and `awsRegion`
(`embedder` may be `null`). See `revuto.config.example.json`. No secrets are
stored — API keys are env-referenced via `apiKeyEnv`. `revuto doctor` checks
model endpoints, the store backend, and the token before you run anything.

## Providers

Any OpenAI-compatible endpoint works; set it per role in `models`. Verify reachability
with `revuto doctor` before running.

```jsonc
// local llama.cpp chat model (scripts/llama-server.sh) — keyless
{ "baseURL": "http://127.0.0.1:8080/v1", "model": "qwen3.6-27b" }

// local llama.cpp embedder (EMBED=1 scripts/llama-server.sh) — keyless, separate port
{ "baseURL": "http://127.0.0.1:8181/v1", "model": "bge-small-en-v1.5" }

// hosted GLM (Z.ai coding endpoint)
{ "baseURL": "https://api.z.ai/api/coding/paas/v4", "model": "glm-5.1", "apiKeyEnv": "GLM_API_KEY" }

// Amazon Bedrock OpenAI-compatible Responses API (Mantle)
// Uses AWS_BEARER_TOKEN_BEDROCK when set; otherwise signs HTTP with the default AWS credential chain.
{
  "name": "bedrock-mantle",
  "baseURL": "https://bedrock-mantle.us-east-2.api.aws/v1",
  "model": "openai.gpt-5.5",
  "api": "responses",
  "reasoningEffort": "xhigh",
  "auth": "auto",
  "apiKeyEnv": "AWS_BEARER_TOKEN_BEDROCK",
  "awsRegion": "us-east-2"
}

// a self-hosted agent exposing /v1 (e.g. Hermes)
{ "baseURL": "http://127.0.0.1:PORT/v1", "model": "<served-name>", "apiKeyEnv": "HERMES_API_KEY" }
```

`api` defaults to `chat` (`/v1/chat/completions`). Set `api: "responses"` for
`/v1/responses` providers such as Bedrock Mantle. Responses calls are stateless
by default (`store: false`) and can use `reasoningEffort` for GPT/o-series models.
The current Responses adapter covers Revuto's text + function-tool loop, bearer
auth, and Bedrock SigV4 signing. It intentionally leaves streaming, stored
conversation state, multimodal/file inputs, structured-output helpers, and built-in
Responses tools unsupported for now.

Tool calling is required (the reviewer/curator drive tools), so a local **chat** server
must run with a tool-capable chat template — `scripts/llama-server.sh` passes `--jinja`
for that. For an **embedder**, `EMBED=1 LLAMA_MODEL=... scripts/llama-server.sh` serves it
with `--embedding`, CLS pooling, CPU-only (`-ngl 0`), on port 8181 (clear of the chat
server's 8080). The `embedder` role may be `null` — dedup + skill selection then fall back
to LLM-judge / area-glob.

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

## Limits

Optional caps under `limits` (0 = unlimited; run/comment/token counts are per repo per UTC day, enforced via store counters):

- `maxOutputTokens` — per-run output-token cap for each agent: `{ review, curator, distill }`.
- `dailyReviews` — max review runs per repo per day.
- `learnBatch` — max comments processed per learn pass (per batch, not per comment).
- `dailyLearn` — max comments processed per repo per day.
- `dailyTokens` — **shared** daily token budget across all agents (review + curator + distill), per repo. When the day's running total reaches it, the review and learn loops stop until the next day.

```jsonc
"limits": {
  "maxOutputTokens": { "review": 32768, "curator": 16384, "distill": 8192 },
  "dailyReviews": 20, "learnBatch": 30, "dailyLearn": 100, "dailyTokens": 2000000
}
```

## Usage

```bash
revuto doctor                        # verify endpoints + GitHub token first
revuto init <owner/repo> [maxPRs]    # onboard a repo (clone + backfill + textbook)
revuto daemon                        # start the scheduler (review/learn/decay)

# lifecycle
revuto add <owner/repo>              # register without onboarding
revuto remove <owner/repo> [--purge] # unregister (--purge also deletes skills + sqlite memory)
revuto pause <owner/repo>            # stop scheduling (until resume / restart)
revuto resume <owner/repo>           # re-enable scheduling
revuto cron <owner/repo> <job> <expr>  # per-repo cron for review|learn|decay ("clear" resets to default)
revuto list                          # list registered reviewers (shows PAUSED)

# run a job now
revuto trigger <owner/repo> [job]    # run review|learn|decay now (default: review)
revuto review <owner/repo> <pr>      # review one specific PR now
revuto learn <owner/repo>            # run one learn pass now
revuto decay <owner/repo>            # run decay now
revuto approve <owner/repo> <slug>   # activate a draft skill
```

Run the daemon as a systemd user service to survive reboots — see
`deploy/revuto.service`.

## Development

```bash
git clone https://github.com/avifenesh/revuto && cd revuto
npm install && npm run build
npm run typecheck
npx tsx scripts/smoke/graduation.ts    # store + 4× graduation + selection
npx tsx scripts/smoke/loop.ts          # full learn loop (fake endpoint)
npx tsx scripts/smoke/responses.ts     # /v1/responses + Bedrock Mantle auth
npx tsx scripts/smoke/doctor.ts        # doctor probes + output shape
npx tsx scripts/smoke/config.ts        # config defaults + model API validation
npx tsx scripts/smoke/scheduler.ts     # registry + schedule planning
npx tsx scripts/smoke/scan.ts          # onboarding repo scan
```
