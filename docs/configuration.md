# Configuration

## Where the config lives

**Config lives in the vault by default.** `init-config` writes
`<vault>/revuto.config.json`, where `<vault>` is `$REVUTO_VAULT` or `~/revuto`, so
config + skills + reviewer notes all sit in one Obsidian-editable place. `loadConfig`
reads `$REVUTO_CONFIG` when it is set, else `<vault>/revuto.config.json`. The working
directory is never searched: a config names endpoints, key variables and CLI
binaries, so a `revuto.config.json` in a cloned repo must not redirect credentials.
`init-config --local` writes the config to the current directory; point
`REVUTO_CONFIG` at it to use it.

Environment comes from `~/.config/revuto/env` and `<vault>/env`, whole. Other
tools' files (`~/.hermes/.env`, `~/.config/gh-shared/token.env`) supply only the
variables the config names: model key variables, the GitHub token and the
webhook secret.

Config keys: `vaultPath`, `github.tokenEnv`, optional `github.app`, per-role
`models`, `schedules`, `limits`, and `store`. Model specs require `baseURL` and
`model`; optional keys are `name`, `apiKeyEnv`, `api`, `auth`,
`reasoningEffort`, `awsRegion`, `command`, `permissionMode`, and `fallbacks`
(`embedder` may be `null`). See
`revuto.config.example.json`, and [providers.md](providers.md) for every `api` and
`auth` value. No secrets are stored: API keys and the webhook secret are
env-referenced. `revuto doctor` checks model endpoints, configured
fallbacks, the store backend, and the token before you run anything.

## Storage backend

Skills are always Obsidian markdown. The structured memory (concerns, embeddings,
cursors, idempotency) has two backends, set in `store.backend`:

- `surreal` (**default**): SurrealDB, with native vector search
  (`vector::similarity::cosine`) for concern dedup. Start it first with
  `scripts/surreal-start.sh` (persistent surrealkv under the vault). The root
  password is `REVUTO_SURREAL_PASSWORD`: `init-config` or the start script
  generates one into `~/.config/revuto/env`, and revuto reads it from there. The
  store refuses browser origins and embedded scripting.

  ```jsonc
  "store": {
    "backend": "surreal",
    "surreal": { "url": "http://127.0.0.1:8000/rpc", "namespace": "reviewer" }
  }
  ```

  A store first started with the old `root`/`root` login keeps it until you
  change it: `DEFINE USER root ON ROOT PASSWORD '<new>' ROLES OWNER`, then put
  the new password in `REVUTO_SURREAL_PASSWORD`.

- `sqlite`: opt-in, zero dependency; a per-repo SQLite file under `<vault>/memory/`
  (no server to run). Set `"store": { "backend": "sqlite" }`.

Both backends keep in-flight claims (`claims` / `claim`) apart from the done markers
(`idempotency` / `seen`). A claim is released when the review completes or fails, and is
stealable after a 90-minute lease, so a worker killed mid-review no longer strands its
head - the next poll retakes it. A done marker never expires. Heads recorded before the
lease existed were written to the done markers, so a review the old code lost that way
still reads as finished; re-run it with `revuto review <owner/repo> <pr> --force`, which
bypasses the claim entirely.

## Limits

Optional caps under `limits` (0 = unlimited; run/comment/token counts are per repo per UTC day, enforced via store counters):

- `maxOutputTokens`: per-run output-token cap for each agent: `{ review, curator, distill }`. Curator and distill default to 16384 and 8192. When `review` is unset, the routed review model decides: 128000 when its whole fallback chain is Claude (thinking counts toward the cap; 128K is the Opus 5.5 and Sonnet 5 ceiling), 32768 otherwise, since a chat endpoint can 400 above its own limit. For the Claude CLI reviewer the cap becomes `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
- `dailyReviews`: max review runs per repo per day.
- `learnBatch`: max comments processed per learn pass (per batch, not per comment).
- `dailyLearn`: max comments processed per repo per day.
- `dailyTokens`: **shared** daily token budget across all agents (review + curator + distill), per repo. When the day's running total reaches it, the review and learn loops stop until the next day.

```jsonc
"limits": {
  "maxOutputTokens": { "review": 128000, "curator": 16384, "distill": 8192 },
  "dailyReviews": 20, "learnBatch": 30, "dailyLearn": 100, "dailyTokens": 2000000
}
```

## Running as a service

Run the daemon as a systemd user service to survive reboots; see
`deploy/revuto.service`. For the full local stack, install the matching
`deploy/revuto-surreal.service`, `deploy/revuto-embedder.service`, and
`deploy/revuto-guard.timer` units too; the guard keeps the daemon, store, and
embedder available for scheduled review/learn/decay runs.
