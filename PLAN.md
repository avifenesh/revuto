# Architecture & status

## What this is

A local engine that stands up a learning PR reviewer for any repo. Originally an
AWS Bedrock AgentCore deployment for `valkey-io/valkey`; rebuilt to run locally,
be supplier-agnostic, and work for arbitrary repos. The original AWS design notes
are in `docs/legacy-aws/`.

## Design decisions

- **OpenAI-compatible everywhere.** `agents/common/src/model.ts` builds every
  chat/embedding model from a `ModelSpec { baseURL, model, apiKeyEnv }` via
  `@ai-sdk/openai-compatible`. No provider lock-in; configured per role.
- **Orchestration:** Vercel AI SDK (`generateText` + tool calling + `stopWhen`).
  Tool builders return a neutral `ToolDef` (`agents/common/src/tool-def.ts`) that
  `toAiSdkTools` adapts — the rest of the engine is orchestrator-agnostic.
- **External, viewable knowledge store.** Skills are always Obsidian markdown notes
  (never touch the reviewed repo or this repo). The structured memory backend is
  pluggable: **SurrealDB by default** (native `vector::similarity::cosine` dedup),
  or `sqlite` (zero-dep per-repo file) as opt-in via `store.backend`.
- **Embedder optional.** Configured → vector dedup + vector skill selection.
  Omitted → LLM-judged dedup (curator reads candidates) + area-glob selection.
- **Poll, don't webhook.** A node-cron daemon polls each repo's delta since a
  persisted cursor. Reviewer registry = one vault note per repo (replaces CDK routes).
- **Graduation at 4×, then delete.** A concern reinforced to 4 graduates into a
  `draft` topic skill note; the source concern is removed. Drafts need `approve`
  (or per-repo `autoActivate`) before the reviewer loads them.

## Module map

| Area | Path | Role |
|---|---|---|
| Model factory | `agents/common/src/model.ts` | OpenAI-compatible chat/embedding per role |
| Tool adapter | `agents/common/src/tool-def.ts` | neutral ToolDef → AI SDK tools |
| Review loop | `agents/common/src/run-agent.ts` | `runReview()` — workspace, skill select, generateText |
| Tools | `agents/common/src/tools/*` | harness (read/grep/glob/bash/lsp) + git + gh + post/skip |
| Store | `agents/common/src/store/*` | async KnowledgeStore; markdown skills (shared) + memory backend: SqliteStore or SurrealStore (native vector cosine) |
| Embedder | `agents/common/src/memory/*` | optional Embedder + OpenAI-compatible impl |
| Skill select | `agents/common/src/skills/select.ts` | touched-files → textbook + topic skills |
| Curator | `agents/curator/src/*` | `runCurator()` + concerns tools + vault graduation |
| Decay | `ops/src/decay.ts` | time-based exponential decay |
| Daemon | `daemon/src/*` | reviewers registry, poller, jobs, scheduler, CLI, init |

## Status

Phases 1–5 implemented; `npm run typecheck` and `npm run build` pass.

Verified deterministically (no endpoint/token needed):
- `scripts/smoke/graduation.ts` — store, 4× reinforcement, draft-gate, area-glob selection, cursors.
- `scripts/smoke/scheduler.ts` — reviewer registry round-trip + per-repo schedule merge.
- `scripts/smoke/scan.ts` — onboarding repo scan.
- `scripts/smoke/loop.ts` — full learn loop (fake OpenAI endpoint drives the real curator tool loop).
- `scripts/smoke/surreal.ts` — SurrealDB backend parity (needs a local `surreal start`): concerns + native cosine + cursors + idempotency + graduation.

Needs a configured OpenAI-compatible endpoint + `GH_TOKEN` to exercise end-to-end
(integration, not yet run here):
- `reviewer review <repo> <pr>` posting a real review.
- `reviewer learn` curating a real reply; embedder-on dedup/selection path.
- `reviewer init` producing a non-trivial `_textbook.md` from PR history.
- supplier-swap (run the same review against two different `models.review` endpoints).

## Not done / future

- Topic-skill seeding during `init` (skills currently accrue via the learn loop).
- Reactions / issue-comment feedback in the poller (currently review-comment replies).
- Per-repo build/test tools (make/cargo/pytest) wired into the review tool set.
- `sqlite-vec` for large concern stores (JS cosine over blobs is fine at current scale).
