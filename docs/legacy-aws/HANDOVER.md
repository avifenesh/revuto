# valkey-reviewer — handover

**State as of 2026-05-12 (post-rewrite).** Read this first in a new session before touching anything.

## TL;DR

End-to-end rewrite landed: Python agent → TypeScript agent. The reviewer now checks out the PR in-container, runs a restricted tool surface (harness-tools read/write/grep/glob/bash/lsp + custom git/gh/make), and posts the review atomically via `post_review`. Code Interpreter sandbox and the MCP Lambda are retired.

Typechecks clean. Not yet deployed / smoke-tested. That's the open task.

## Stack (current)

- **Language**: TypeScript, Node 20, ESM (`"type": "module"`).
- **Runtime host**: AWS Bedrock AgentCore Runtime container (arm64).
- **HTTP shim**: `bedrock-agentcore@0.2.3` (`BedrockAgentCoreApp` with `invocationHandler.process` async generator).
- **Agent loop**: `@strands-agents/sdk@1.1.0`, Bedrock Opus 4.7.
- **Tool library**: `@agent-sh/harness-tools@0.2.0` (read/write/grep/glob/bash/lsp).
- **Checkout**: in-container. `/workspace/valkey` is pre-cloned in the Dockerfile; per-invocation, `src/workspace.ts` fetches PR head + base, detaches HEAD at the PR tip, then hands the agent a rendered overview.
- **Auth**: GitHub App → `@octokit/auth-app` → installation token → `@octokit/rest`.

## Live resources (un-changed)

| Resource | ARN / URL |
|---|---|
| Runtime | `<arn>` |
| Assets bucket | `valkey-reviewer-assets-<aws-account-id>-us-west-2` |
| Agent base role | `<arn>` |
| KMS key | `<arn>` |
| Memory | `valkey_review_memory-ipfnDl47E4` (active, no strategies attached) |
| GitHub App | id `<github-app-id>`, installation `<installation-id>` (`avifenesh/valkey`) |
| Secrets | `valkey-review/github-token` (App private key + webhook secret + client id, as JSON) |

**Retired this session:**
- Code Interpreter (`valkey_review_ci-UIEXJYiRXU`) — not referenced from CDK anymore. CFN `delete` on next `cdk deploy` will remove it.
- `ValkeyReviewGitHubTools` stack (MCP Lambda + Function URL) — deleted from CDK.

## File layout (current)

```
/home/ubuntu/valkey-reviewer/
  HANDOVER.md                    you are here
  PLAN.md                        older architecture doc (stale in parts)
  README.md                      scope + layout

  infra/                         CDK TypeScript app
    bin/infra.ts                 wires Substrate + ValkeyReviewAgent (no more ToolsStack)
    lib/substrate-stack.ts       KMS, S3, GitHub secret ref, agent base role (incl. Secrets read)
    lib/valkey-review-agent-stack.ts   Runtime + Memory, no Code Interpreter

  agents/valkey-review/
    Dockerfile                   debian-bookworm + node20 + gcc + clangd + gh + git + ripgrep +
                                 pre-cloned valkey (upstream + avifenesh fork remotes)
    package.json                 TS deps (bedrock-agentcore, strands, harness-tools, octokit)
    tsconfig.json                strict, ES2022, NodeNext

    src/
      agent.ts                   entrypoint. boot loads assets → per-invocation prep+tools+Strands
      config.ts                  Env loader + S3 asset fetch
      github-auth.ts             App private key → installation token (octokit)
      workspace.ts               PR checkout + overview render
      tools/
        adapter.ts               harness ToolDefinition → Strands `tool(...)` bridge
        harness.ts               read/write/grep/glob/bash/lsp wired with permission policy
        git.ts                   read-only allowlisted git
        gh.ts                    gh_api_read (GET allowlist) + post_review + post_issue_comment + skip_review
        make.ts                  allowlisted make targets + vars
        index.ts                 assembleTools(ctx, octokit, token)

    config/
      skill.md                   35KB institutional memory (unchanged)
      prompt.md                  REWRITTEN — matches real tool surface
```

## Tool surface (what the agent actually has)

Filesystem/text (harness-tools):
- `read`, `grep`, `glob`, `bash`, `lsp` (clangd)
- `write`, `edit` — gated by `ALLOW_WRITE=true`, off by default

Git (read-only): allowlisted subcommands only. `log show blame diff status rev-parse rev-list cat-file ls-tree ls-files grep shortlog describe branch tag reflog merge-base name-rev`

GitHub REST:
- `gh_api_read` — GET only, endpoint-pattern allowlist
- `post_review` — atomic review with inline comments; one call per invocation
- `post_issue_comment` — always-on-check failures only
- `skip_review` — silent exit signal

Build:
- `make` — allowlisted targets (all, valkey-server, valkey-cli, valkey-benchmark, valkey-sentinel, test-unit, clean, help) + vars

## What's new in the flow

1. AgentCore Runtime POSTs `/invocations` with `{repo, pr_number, installation_id}`.
2. `src/agent.ts` gets installation token → `prepareWorkspace` does `git fetch pull/N/head` + `git checkout --detach <headSha>` on `/workspace/valkey`.
3. The first user message is a rendered PR overview (title/body/author, head/base/merge-base SHAs, file list, existing reviews, existing inline comments, existing issue comments).
4. Agent works from a checked-out tree. No `checkout_pr` tool needed.
5. When done: single `post_review` call with event/body/comments, or `skip_review`.

## Env contract (set by CDK; declared in `config.ts`)

```
BEDROCK_MODEL_ID=us.anthropic.claude-opus-4-7
AWS_REGION=us-west-2
ASSETS_BUCKET=valkey-reviewer-assets-...
SKILL_S3_KEY=valkey-review/skill.md
PROMPT_S3_KEY=valkey-review/prompt.md
GITHUB_APP_ID=<github-app-id>
GITHUB_SECRET_ARN=<arn>
MAX_ITERATIONS=150
MAX_TOKENS=32768
WORKSPACE_ROOT=/workspace/valkey
ALLOW_MAKE=true
ALLOW_WRITE=false
```

## Next session's first move

1. `cd ~/valkey-reviewer/infra && cdk synth` — confirm CFN drift is expected (Code Interpreter + GitHubTools stack removal; env vars swapped).
2. `cdk deploy --all --require-approval never` — builds arm64 image (~5 min under QEMU), pushes to ECR, updates Runtime.
3. Smoke test on PR #9 (small) and PR #12 (948 LOC):
   ```
   cat > /tmp/inv.json <<EOF
   {"repo":"avifenesh/valkey","pr_number":9,"installation_id":<installation-id>}
   EOF
   aws bedrock-agentcore invoke-agent-runtime \
     --region us-west-2 --cli-read-timeout 1200 \
     --agent-runtime-arn <arn> \
     --payload "$(base64 -w 0 /tmp/inv.json)" /tmp/response.txt
   ```

## Known follow-ups

- LSP: `.lsp.json` is not yet committed; `src/tools/harness.ts` ships an in-process default (clangd for `.c`/`.h`). Works but a file manifest is nicer.
- No tests. The agent is complex enough that unit tests on `workspace.ts` (git mock), `git.ts` (allowlist), `gh.ts` (regex patterns) would catch 90% of future regressions.
- Memory store is provisioned but inert (no extraction strategies, no injection). Same state as before the rewrite.
- Variance investigation from the pre-rewrite session is still open. The rewrite fixes the prompt-tool mismatch that was the top suspect; whether variance persists is a post-smoke-test question.

## Historic context (what was retired)

- Old Python agent (`agents/valkey-review/app/agent.py` + `github_tools.py`) — deleted.
- MCP Lambda (`tools/github-mcp-lambda/`) — deleted.
- `valkey-reviewer/webhook/` — empty scaffolding; left alone.
- Cairn-era pipeline was already torn down on 2026-05-12 (see `project_valkey_reviewer_pipeline` memory).

## Dogfood PR workflow (unchanged)

When mirroring an upstream PR for a dogfood test — squash-merge onto a neutral branch, net-new title/body, no upstream PR number references. See `feedback_dogfood_pr_no_reference_to_origin` memory.
