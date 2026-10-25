# Providers

Every model role in `models` takes one spec. Pick a reviewer from your plan, then
check it with `revuto doctor` before the first run.

| role | what it does | can run on |
|---|---|---|
| `review`, `reviewMedium`, `reviewSmall` | reviews a PR head | any provider below |
| `curator` | writes and merges skills | HTTP models, Antigravity |
| `distill` | turns PR history into the textbook | HTTP models, Antigravity |
| `guard` | approves every learned fact, skill and textbook before it is stored | HTTP models only; defaults to the HTTP models of `distill`, then `curator` |
| `embedder` | dedup and skill selection | an OpenAI-compatible embeddings endpoint, or `null` |

Each spec can list `fallbacks`, tried in order. An HTTP model falls back when its
call fails or the model refuses. A native CLI runner (Claude Code, Codex,
Antigravity) falls back only on a refusal; any other error, such as a plan's usage
limit, fails the review. Native runners must come before HTTP models in a chain.

## Claude Code

Revuto runs `claude -p` with streamed JSON, schema validation, restricted mode and
all built-in tools disabled. It needs Claude Code 2.1.248 or newer, plus native Git
and ripgrep on PATH. Claude runs the review tiers only (`models.review`,
`reviewMedium`, `reviewSmall`).

### On a Claude plan (Pro or Max)

```json
{
  "name": "claude-plan",
  "api": "claude",
  "baseURL": "claude-cli://local",
  "auth": "subscription",
  "model": "claude-opus-5-5",
  "reasoningEffort": "high"
}
```

Create a long-lived token once with `claude setup-token` and put it in the daemon
environment as `CLAUDE_CODE_OAUTH_TOKEN`. A subscription run gets that token and
nothing else from the provider environment: an `ANTHROPIC_API_KEY` or a
`CLAUDE_CODE_USE_BEDROCK` set for something else cannot redirect it.

A subscription run is isolated the same way as every Claude run; see
[What Claude can touch](#what-claude-can-touch).

### On an Anthropic API key or a cloud provider

```json
{
  "name": "claude-api",
  "api": "claude",
  "baseURL": "claude-cli://local",
  "auth": "none",
  "model": "claude-opus-5-5",
  "reasoningEffort": "high"
}
```

With `auth: "none"` revuto forwards the provider
settings Claude Code already understands: `ANTHROPIC_API_KEY`, or the Bedrock,
Vertex or Foundry variables (`CLAUDE_CODE_USE_BEDROCK=1` and its AWS credentials,
for example). Use the model ID your provider expects, such as
`global.anthropic.claude-opus-5-5[1m]` on Bedrock. Values come from the daemon
environment or the `env` block of `~/.claude/settings.json`; revuto forwards only
that allowlist. It never forwards GitHub credentials, arbitrary user settings, or
project and local settings.

### What Claude can touch

The reviewer is trusted; the checkout is not. A Claude review gets the shell
(Bash), Read, Grep, Glob, Write and Edit, and runs in auto mode, where a
classifier reviews each action. What the checkout could do without asking is
closed off:

- Nothing from the checkout or `~/.claude` loads: no setting sources, a private
  `CLAUDE_CONFIG_DIR` removed after the run, no MCP servers, no `CLAUDE.md`,
  `AGENTS.md`, project skills, agents, commands, hooks or `.mcp.json`, no
  bundled skills, no auto-memory.
- Every shell command runs in Claude Code's sandbox (`failIfUnavailable`, no
  unsandboxed retry): no network, and an unlisted host is refused rather than
  put to the classifier (`strictAllowlist`); writes only to the checkout and the
  run's scratch directory, never to `.git` or the shared git cache; the whole
  home directory unreadable apart from the checkout, its git directories and
  the run's directories, so logins such as `~/.claude`, `~/.codex`, `~/.grok`
  and revuto's own Codex home stay out; credential variables denied; the
  session bus, container sockets, X11 and agents hidden. Claude Code's
  Unix-socket filter cannot start on some kernels (anthropics/claude-code#81799),
  so sockets are allowed and those paths are denied instead.
- Read, Write and Edit follow permission rules: reads stay in the working
  directories, edits to `.git` and the git cache are denied.
- `PYTHONSAFEPATH` keeps Python from importing a planted module from the
  directory it runs in; `GIT_NO_LAZY_FETCH` keeps git offline.
- The prompt says not to run repository code (builds, tests, installs, scripts).

The checkout comes from a blobless cache, so commits and trees for the whole
history are local: `git log -- <path>`, `--stat` and `git show` work offline.
Each run also gets a copy of the repository's textbook and active skills to
read; drafts and `_history/` stay out, as they do from skill selection.
`scripts/smoke/native-sandbox.ts` runs a real review against a hostile checkout
to check all of this.

A review counts as inspected only once the reviewer ran a command or read or
searched a file. A file listing alone does not count, so a reviewer that lists
files and calls `skip_review` fails the check.

Valid effort values are `low`, `medium`, `high`, `xhigh`, and `max`. Claude
receives `review.maxSteps` as `--max-turns` and the configured review output cap
as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. A turn-limit exit fails the review.
`revuto doctor` probes native CLI models too; its Claude probe has no tools or MCP servers, one turn, low effort and a
32-token output cap, and checks the exact expected response.

## Codex

Revuto runs `codex exec --json` with `--ignore-user-config --ignore-rules`, web
search off and `--ephemeral`. A review's shell runs under a permission profile
(`default_permissions`) that closes the whole filesystem (`:root` deny) and
re-opens system paths (`:minimal`), the checkout (writable, its `.git`
read-only), the run's scratch directory (writable), and the git directories,
the skills copy and the Codex package (read-only). The home directory, so
revuto's ChatGPT login too, is out of reach; `/tmp` is a private empty tmpfs;
there is no network. Commands get only core environment variables plus
`PYTHONSAFEPATH` and `GIT_NO_LAZY_FETCH`. The sandbox re-runs the Codex
executable inside it, so the Codex command must be the npm package's bin or the
native binary; a wrapper script is refused, and `revuto doctor` reports it. The doctor probe runs read-only with no shell. Project docs
(`AGENTS.md`) and skill instructions are off, so neither the checkout's nor the
operator's reach the model, and the operator's `~/.codex` config and sessions are
never read. Codex also gets a scratch `HOME`, so `~/.agents` skills and dotfiles
stay out, and its other built-in tools are switched off: images, code mode,
sub-agents (one thread, no depth), apps, plugins, browsers, hooks, memories and
`request_user_input`.

GPT-6 models ask Codex's model catalog for code mode (a JavaScript `exec` tool
that drives every other tool) and the sub-agent tools, which no feature flag
removes. Before each run revuto reads the catalog with `codex debug models`, in
the same home and on the same provider, sets every model to direct tools with
sub-agents, tool search, `apply_patch` and experimental tools off, and passes it
as `model_catalog_json`. If the catalog cannot be read, the run fails. The model
then sees only the sandboxed shell (`exec_command`, `write_stdin`). Any tool item Codex still reports counts toward
`review.maxSteps`. Codex runs the review tiers only.

### On a ChatGPT plan

```json
{
  "name": "codex-plan",
  "api": "codex",
  "baseURL": "codex://openai",
  "auth": "subscription",
  "model": "gpt-6.1-sol",
  "reasoningEffort": "high"
}
```

Log in once into revuto's own Codex home:

```bash
mkdir -p ~/.config/revuto/codex
CODEX_HOME=~/.config/revuto/codex codex login    # add --device-auth on a headless box
```

`REVUTO_CODEX_HOME` moves that home. It holds only the login, so it stays apart
from your own `~/.codex`. Every login review runs in this one home, so a token
refresh lands where the next review reads it. A review with no login there fails
with the command to run.

The login is the `auth.json` in that home, and it holds live ChatGPT tokens.
OpenAI advises against a ChatGPT login for public repositories in CI, where the
repository's own code runs beside that file. Revuto runs no repository code, and
Codex's sandboxed shell can neither read that file nor reach the network. For
reviews of repositories whose contributors you do not trust, an API key still
limits what a leaked credential can do.

### On an OpenAI API key

```json
{
  "name": "codex-api",
  "api": "codex",
  "baseURL": "codex://openai",
  "auth": "bearer",
  "apiKeyEnv": "OPENAI_API_KEY",
  "model": "gpt-6.1-sol",
  "reasoningEffort": "high"
}
```

The key reaches Codex as `CODEX_API_KEY` and nothing else from the environment
comes along. Each run gets a private `CODEX_HOME` in a temporary directory that is
removed afterwards.

### On Amazon Bedrock

```json
{
  "name": "codex-bedrock",
  "api": "codex",
  "baseURL": "codex://bedrock",
  "auth": "aws",
  "model": "openai.gpt-6.1-sol",
  "awsRegion": "us-east-1",
  "reasoningEffort": "high"
}
```

The model provider is Codex's built-in `amazon-bedrock` with `awsRegion` (default
`us-east-1`, where Bedrock serves the GPT-6 family). Only `HOME`, `PATH`, locale
and TLS variables and the AWS credentials (`AWS_BEARER_TOKEN_BEDROCK`, keys,
profile) reach the process. Revuto passes a 900K context window, since Codex's
bundled catalog has no entry for the Bedrock IDs.

### What Codex can touch

Codex reads the diff and history with git in its sandbox, like the Claude runner,
and the verdict comes back through `--output-schema` with a strict schema.
The prompt goes over stdin. Codex has no turn limit, so revuto stops the run after
`review.maxSteps` tool calls. Codex compacts at 250K tokens, so no request crosses
the 272K-input price step. Codex has no output-token setting, so
`limits.maxOutputTokens.review` does not apply to it. A turn Codex reports as a
policy failure (`cyber_policy`, `bio_policy`, `invalid_prompt` and the like) or a
final message that declines instead of returning the verdict raises a refusal, and
the review moves to the spec's next `fallbacks` entry, as Claude refusals do.
`command` defaults to `$REVUTO_CODEX_COMMAND` or `codex` on PATH.

## Gemini through Antigravity

```json
{
  "name": "gemini",
  "api": "agy",
  "baseURL": "agy://local",
  "auth": "agy-oauth",
  "model": "gemini-4-argon-high",
  "permissionMode": "bypass"
}
```

`api: "agy"` uses the Antigravity CLI and its cached Google OAuth session; no API
key. `agy://local` is a marker and is not contacted. Each run gets a private
`HOME` with revuto's own AGY settings (tools only inside the workspace, nothing
trusted outside it), `--sandbox` terminal restrictions, and an environment with
no daemon credentials: locale, TLS and the session bus for the keyring login.
The operator's AGY settings are never read. For reviews, AGY inspects the
prepared worktree in headless `stream-json` mode and returns a strict review
object; revuto performs the one GitHub `post_review` or `skip_review` action. Set
`permissionMode: "bypass"` only for a fully trusted review environment; it passes
AGY's `--dangerously-skip-permissions` flag for unattended tool execution. AGY
keeps its native CLI limits and the 20-minute runner timeout; revuto's step and
output knobs apply to HTTP and Claude review execution, not AGY.

Curator and distillation models also accept `api: "agy"`. Each completion runs
in an empty temporary workspace in plan mode and returns text or structured
function calls. Revuto executes the function calls and sends their results back
on the next turn. Native tool use fails the completion. These calls do not enable
permission bypass. HTTP models such as GLM can follow AGY in `fallbacks`.

## HTTP models: GLM, Grok, OpenAI-compatible and local

Any OpenAI-compatible endpoint works for every role. Tool calling is required (the
reviewer and curator drive tools). An HTTP reviewer gets workspace-guarded read,
grep, glob, `pr_diff` and `new_changes` plus the posting tools; there is no shell,
Git, LSP or GitHub API tool. `review.allowWrite` adds
write and edit, confined to the worktree.

```jsonc
// GLM on the Z.ai coding plan
{ "baseURL": "https://api.z.ai/api/coding/paas/v4", "model": "glm-5.3", "apiKeyEnv": "ZAI_API_KEY" }

// Grok on the Grok CLI login (~/.grok/auth.json) or GROK_API_KEY
{ "baseURL": "https://cli-chat-proxy.grok.com/v1", "model": "grok-4.7", "api": "responses", "auth": "grok" }

// a self-hosted agent exposing /v1 (e.g. Hermes)
{ "baseURL": "http://127.0.0.1:PORT/v1", "model": "<served-name>", "apiKeyEnv": "HERMES_API_KEY" }

// local llama.cpp chat model (scripts/llama-server.sh), keyless
{ "baseURL": "http://127.0.0.1:8080/v1", "model": "qwen3.6-27b" }

// local llama.cpp embedder (EMBED=1 scripts/llama-server.sh), keyless, separate port
{ "baseURL": "http://127.0.0.1:8181/v1", "model": "bge-small-en-v1.5" }
```

`api` defaults to `chat` (`/v1/chat/completions`). Set `api: "responses"` for
`/v1/responses` providers. Responses calls are stateless by default
(`store: false`) and can use `reasoningEffort` for GPT and o-series models. The
Responses adapter covers revuto's text and function-tool loop, bearer auth, and
Bedrock SigV4 signing. It leaves streaming, stored conversation state,
multimodal and file inputs, structured-output helpers, and built-in Responses
tools unsupported for now.

A local **chat** server must run with a tool-capable chat template;
`scripts/llama-server.sh` passes `--jinja` for that. For an **embedder**,
`EMBED=1 LLAMA_MODEL=... scripts/llama-server.sh` serves it with `--embedding`,
CLS pooling, CPU-only (`-ngl 0`), on port 8181 (clear of the chat server's 8080).

## Amazon Bedrock over HTTP

Bedrock serves Claude through Converse and GPT through the OpenAI-compatible
Mantle endpoint. Both use `AWS_BEARER_TOKEN_BEDROCK` when set and otherwise sign
with the default AWS credential chain (`auth: "auto"`).

```jsonc
// GPT on Bedrock Mantle (Responses API), falling back to Claude on Bedrock Converse
{
  "name": "bedrock-mantle",
  "baseURL": "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
  "model": "openai.gpt-6.1-sol",
  "api": "responses",
  "reasoningEffort": "high",
  "auth": "auto",
  "apiKeyEnv": "AWS_BEARER_TOKEN_BEDROCK",
  "awsRegion": "us-east-1",
  "fallbacks": [{
    "name": "bedrock-converse",
    "baseURL": "https://bedrock-runtime.us-east-2.amazonaws.com",
    "model": "global.anthropic.claude-opus-5-5",
    "api": "converse",
    "reasoningEffort": "medium",
    "auth": "auto",
    "apiKeyEnv": "AWS_BEARER_TOKEN_BEDROCK",
    "awsRegion": "us-east-2"
  }]
}
```

On Claude IDs the Converse adapter follows the Opus 5.5 / Fable 5.1 request rules:
it calls ConverseStream (a 128K-token turn outlasts a plain HTTP response), never
sends temperature, topP or a forced tool choice (a `required` choice goes out as
`auto` with the tools named, retried once if no call comes back), defaults effort
to `medium`, replays signed reasoning blocks unmodified, and hands a refusal to the
next fallback in the chain. The Claude CLI reviewer does the same for refusals.

### Run-time overrides

Override a role with a primary/fallback chain instead of editing the config file:

```bash
revuto doctor --review-model gpt55,opus
revuto review owner/repo 123 --review-model gpt55,opus
revuto daemon --model review=gpt55@us-east-2,opus --model curator=opus,sonnet --model distill=opus,sonnet
```

The aliases target Bedrock: `sol61`, `sol`, `astra`, `gpt55`, `codex`, `opus`,
`fable`, `sonnet` and `grok`. OpenAI model IDs use Bedrock Mantle
(`https://bedrock-mantle.<region>.api.aws/openai/v1`, default region `us-east-1`)
and Anthropic IDs use Bedrock Runtime Converse
(`https://bedrock-runtime.<region>.amazonaws.com`, default `us-east-2`). `codex` is
GPT-6.1 Sol through the native Codex runner at high effort. `--review-medium-model`
overrides the medium tier; a pinned `--review-model` drops the small and medium tiers
unless they are pinned too. Use `--bedrock-region` (every alias) or append
`@region` to one alias to change the generated endpoint.

## Embeddings

The `embedder` role may be `null`: dedup and skill selection then fall back to an
LLM judge and area globs.

Stored embeddings are tagged with the embedder's `model` ID. Similarity search only
compares vectors from the same model, and the skill-embedding cache is keyed by it, so
switching `embedder` is safe: skills re-embed on the next review. Concerns stored before
the tag existed are still compared when their vector length matches the query; concerns
embedded by a different model drop out of similarity search until they are re-embedded
(a merge re-embeds its target).

`model` in `models.embedder` is the embedding identity. A local server such as
llama-server ignores the requested model name, so revuto cannot tell when the weights
behind the endpoint change. Change `model` whenever the served embedding model changes,
or old and new vectors get compared as if they came from one model.

To tag the untagged concerns (legacy vectors, and records stored while no embedder
was configured or reachable), re-embed them once with the configured embedder:

```bash
npm run reembed-concerns                  # every registered repo
npm run reembed-concerns -- owner/repo    # just these repos
```

It works on both store backends and is safe to re-run: tagged records are skipped, and
a record changed by a concurrent merge is left alone.
