# Examples

Reference content from the original `valkey-io/valkey` + `valkey-glide` deployment,
kept as samples of what good per-repo material looks like. **None of this is wired
into the engine** — repos are onboarded as data into the vault, not as code here.

- `valkey/_textbook.md`, `valkey-glide/_textbook.md` — hand-written institutional
  "textbooks". This is the shape `revuto init` aims to produce into
  `<vault>/skills/<owner>__<repo>/_textbook.md`.
- `valkey/reviewer-prompt.md`, `valkey-glide/reviewer-prompt.md` — the old
  repo-specific reviewer system prompts (the engine now uses one generic prompt in
  `agents/common/src/prompts/reviewer-system.ts` plus the per-repo textbook).
- `curator/` — the original curator prompt/skill and the "how to write a skill"
  guidance. The maintained guidance now lives in
  `agent-knowledge/skill-writing-best-practices.md`.

See `docs/legacy-aws/` for the original AWS Bedrock AgentCore architecture notes.
