# GitHub App: real-time reviews

## Create the App

Polling works without public infrastructure. For review-on-push, create one
GitHub App and install it on each account you want Revuto to cover. Configure:

- Repository permissions: **Contents: read**, **Pull requests: read/write**,
  **Checks: read/write**, and **Metadata: read**.
- Subscribe to the **Pull request** event. Revuto handles `opened`,
  `synchronize`, `reopened`, and `ready_for_review`.
- Set the webhook URL to a stable HTTPS endpoint that forwards to
  `http://127.0.0.1:8787/github/webhook`.
- Install the App on `agent-sh`, your personal account, or selected repositories.

Add the App settings to `<vault>/revuto.config.json`:

```json
{
  "github": {
    "tokenEnv": "GH_TOKEN",
    "app": {
      "appId": 123456,
      "privateKeyPath": "~/.config/revuto/revuto-review.pem",
      "webhookSecretEnv": "REVUTO_GITHUB_WEBHOOK_SECRET",
      "host": "127.0.0.1",
      "port": 8787,
      "path": "/github/webhook",
      "allowedOwners": ["agent-sh", "avifenesh"],
      "ignoredRepos": ["avifenesh/extensions", "someone/*"],
      "checkName": "revuto-review"
    }
  }
}
```

Put the matching secret in the daemon environment, keep the PEM file mode
`0600`, then restart `revuto daemon`. The daemon serves `GET /healthz` and
validates every delivery with `X-Hub-Signature-256` before returning `202`.
Each exact `repo#PR@headSHA` is claimed once. A clean `skip_review` completes
the App check successfully and submits an approving review from the App,
anchored to that exact head. Posted findings or review errors fail the check
without approving.

## A stable HTTPS endpoint with Tailscale Funnel

A Tailscale Funnel can provide the stable HTTPS endpoint while the receiver
stays bound to loopback:

```bash
tailscale funnel --bg --https=8443 \
  --set-path=/github/webhook \
  http://127.0.0.1:8787/github/webhook
tailscale funnel status
```

Use the resulting public `https://<machine>.<tailnet>.ts.net:8443/github/webhook`
URL in the App settings. Funnel configuration persists in Tailscale; keep the
cron review schedule enabled as recovery for delivery or machine outages. After
the first successful App check appears, require `revuto-review` in each
repository's branch rules.

## Webhook health

The daemon checks the App's recent GitHub webhook delivery results at startup
and every three minutes. `github.app.webhookHealthIntervalMinutes` changes this
interval. Every observed failed delivery logs an `ALERT` once per attempt state.
The alerted attempts are kept in `<vault>/.state/webhook-health.json` for
GitHub's three-day delivery window, so a daemon restart does not repeat them.
Repair runs only when the newest `github.app.webhookFailureThreshold` deliveries
all failed with status 0 or 5xx. Authentication failures, redirects and other
client errors still alert but do not reconfigure ingress. The default threshold
is three: one transient failure does not trigger repair. The threshold accepts
1 through 100, the size of the recent-delivery page.

## Automatic repair

Optionally set `github.app.webhookRepairCommand` to an executable and its
arguments, or an ordered sequence of those arrays. For the Funnel above:

```json
{
  "webhookHealthIntervalMinutes": 3,
  "webhookFailureThreshold": 3,
  "webhookRepairEnvAllowlist": [],
  "webhookRepairCommand": [
    ["tailscale", "funnel", "--https=8443", "off"],
    ["tailscale", "funnel", "--bg", "--https=8443", "--set-path", "/github/webhook", "http://127.0.0.1:8787/github/webhook"]
  ]
}
```

Place these keys inside `github.app`. A single command can be written as
`["/path/to/repair-program", "--argument"]`. Commands run as the daemon user,
without a shell, in order, with a 30-second deadline per command. This bounds
a stuck repair and leaves the next health poll available. The child receives
only `PATH`, `HOME`, and environment variable names explicitly listed in
`github.app.webhookRepairEnvAllowlist`. The allowlist defaults to empty.
A systemd unit's `PATH` often omits `/snap/bin`, where the Tailscale snap
installs its CLI; use an absolute path such as `/snap/bin/tailscale` there.
A command that cannot start is logged by its position in the sequence.
Child output, command
arguments, webhook payloads, and API error bodies are never logged by the
monitor. Omit the command to keep alerting and catch-up without automatic repair.
A successful repair runs once per newest failed delivery; a failed repair is
retried at the next poll.

## Catch-up after an outage

After GitHub reports a successful delivery following a detected outage, the
monitor scans delivery history and requests redelivery of the newest failed `pull_request`
`opened`, `synchronize`, `reopened`, or `ready_for_review` event matching each open PR's current
head. It only covers registered repositories allowed by the App
configuration, respects `ignoredRepos`, skips draft payloads, and skips events
with a successful redelivery. Delivery IDs remain exact decimal strings,
including IDs above JavaScript's safe integer range.
If an accepted asynchronous redelivery subsequently fails, it can
retry using that recovery evidence. Catch-up also runs after restarting a daemon
whose ingress has already recovered. GitHub accepts redelivery asynchronously; the monitor waits
for an actual successful delivery before treating ingress as recovered.

The first scan reads retained delivery history. Later scans stop at the prior
scan boundary; progress stays behind outstanding replays so pending outcomes
remain visible. Failed-delivery routing fields are cached by exact delivery ID,
and repeated attempts of the same GUID reuse those fields. Resolved GUIDs need
no detail fetch. Only repositories with eligible candidates have their open
PRs listed. An installation lookup returning 404 logs once and is skipped,
with scan progress saved. New candidate deliveries can revalidate a prior
installation miss. App metadata and PR lookup 404s remain retryable;
an unavailable delivery detail is retired without blocking
other candidates. Routing caches expire with GitHub's three-day delivery
window. Recovery evidence is kept independently of the incremental scan
window so a pending replay can still retry after older metadata is pruned.

## Stalled check suites

The scheduled review pass also scans open PR heads for this App's queued check
suites with zero runs older than five minutes, even if the PR's `updated_at`
predates its review cursor. Five minutes gives normal webhook admission time
to create a check before cron takes over. These reviews keep the usual draft,
author, exact-head claim, concurrency, and review-budget rules.
If a rescue is deferred by daily budgets or fails, the pass rewinds its cursor
to keep that PR eligible even after the first attempt creates a check run.

## Ignored repositories

`github.app.ignoredRepos` lists repositories revuto never reviews: full names
(`owner/name`) or `owner/*`. A matching pull request is skipped before anything is
enqueued: no claim, no round or daily counter, no check run (revuto only creates its
check once it has claimed a head, so nothing stays pending). The skip is logged once
per PR as `skipped: repo ignored`. `revuto review <repo> <pr> --force` still works.
