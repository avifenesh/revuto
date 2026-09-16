# Review router: complexity assessment trained on our own review history

Status: PLANNED (owner, 2026-09-16). Not started; queued behind the upstream-loop and cutover work.
Owner ruling: "we first finishing your current scope before we do it".

## Goal

Route every PR revuto sees to a review tier before any model call, from a complexity score
learned on the PRs we already reviewed. Tiers: skip, small model (Sonnet class), full model
(Opus class), full model with extra rounds. The router must be cheap (no LLM call at intake),
explainable (say why a PR went where), and calibrated per repo.

## Why this shape

- Structure beats semantics. On 33,707 agent-authored PRs, creation-time structural features
  (additions, deletions, files, change entropy, file types) predict high-review-effort PRs at
  AUC 0.957; PR title and body text score 0.52 to 0.57 (arXiv 2601.00753, Jan 2026). A size-only
  rule already reaches 0.93. File-type and "touches tests / CI" features add 14 to 23 points of
  precision inside each size quartile.
- The just-in-time defect-prediction literature (Kamei 2013 onward, Prime Video 2026) uses the
  same feature family: size, diffusion (files, directories, subsystems, entropy), history,
  experience, churn x complexity hotspots.
- LLM routing and cascades (RouteLLM, survey arXiv 2603.04445) keep about 95% of the strong
  model's quality while sending 80 to 85% of traffic to the cheap model, provided the cheap
  tier has an escalation signal.
- Gradient boosting matched every stacked or neural alternative in the PR study and trains in a
  second on our corpus size; SHAP explains each routing decision. A distilled text model on
  patch hunks is a v2, only if structure demonstrably fails somewhere.

## Corpus (about 2,400 PRs, all public or ours)

| source | PRs | eras and signals |
|---|---|---|
| revuto, comment era (signed comment under the owner's account) | part of ~1,900 | inline findings, later heads, merge state; no approval state |
| revuto, GitHub App era (`revuto-review[bot]`) | rest of ~1,900 (1,750 merged) | APPROVED / COMMENTED per head, rounds to approval, check runs |
| `valkey-review-bot[bot]` in valkey-io/valkey (281) and valkey-glide (245), since 2025-06-26 | 526 | one COMMENTED round with inline comments, plus HUMAN maintainers: review rounds, CHANGES_REQUESTED, comment volume, days to merge, whether bot comments were acted on |

Counts from GitHub issue search on 2026-09-16 (`"auto review done by" type:pr` = 1,948 incl. a
little noise; `reviewed-by:valkey-review-bot[bot]` = 526). The revuto store keeps concerns and
claims, not per-PR features, so GitHub is the corpus source for everything.

## Labels: one ordinal "review difficulty", tiers 0 to 3

- App-era revuto PRs: rounds until APPROVED (1 = easy, 2 = medium, 3+ = hard).
  Censoring: `review.maxRounds` was 3 and is 2 since 2026-09-16; heads that hit "Daily review
  limit reached" have no review. Record the cap in force as a field; drop capped PRs from the
  hard class or keep them as right-censored.
- Comment-era and never-approved PRs: number of inline findings, whether a new head followed the
  review, whether the PR merged anyway.
- valkey PRs: define difficulty from the human signals first (human rounds, changes requested,
  days to merge, human comment count); the bot's comment count is the secondary label.
- LLM judge over the review TEXT only, blind to diff size and to which bot wrote it: blocking vs
  nit, how much reasoning the review needed, 1 to 5. One cheap model, fixed prompt, sampled
  agreement check against 50 hand-labeled reviews before trusting it.
- Fuse the three into the tier; keep the raw components for later re-fusion.
- Bot era (AWS valkey bot vs revuto GLM / Grok / Opus periods) is a FEATURE of the label, not
  ignored: the same comment count means different things across reviewer models.

## Features: creation-time, structural, nothing from the review

Additions, deletions, total changes, files, directories, top-level areas, change entropy
(Shannon over per-file changes), new-file ratio, path classes (docs, tests, CI, config/pins,
serving/ops, core), hotspot churn of touched files over the last 90 days, repo, author kind
(agent vs human), language mix. No PR title or body features. No CI results (post-creation).
Per-repo z-scoring of size features: the PR study's per-repo AUC fell to 0.71 without local
calibration.

## Model and evaluation

LightGBM (or sklearn HistGradientBoosting to avoid a dependency) as an ordinal classifier via
cumulative binary targets; Platt or isotonic calibration. Evaluate on a temporal split (train
first 80% by date, test the rest) AND a repo-disjoint split. Report AUC per tier boundary,
precision at the "easy" tier (the one that saves money and must not miss hard PRs), and
SHAP importances. Baseline to beat: size-only rule and the current `review.small` gate.

## Rollout

1. Extractor (`tools/router-corpus/`): per PR, files with per-file additions and deletions,
   revuto or valkey-bot reviews and inline comments, human reviews, merge state, timestamps,
   the router features above; about 3 API calls per PR, cached to JSONL, resumable, no
   secrets in the corpus.
2. Judge pass over every review body with the cheap model; store score and rationale.
3. Train, evaluate on both splits, pick tier thresholds from the precision curve.
4. Shadow mode in the daemon for two weeks: the router logs its tier and features next to the
   real outcome (rounds, findings); Opus still reviews everything. Success metric: share of
   "easy" predictions that later needed 2+ rounds or produced a blocking finding.
5. Flip routing per tier when the shadow numbers hold; keep the cascade (small model escalates
   on a blocking finding, on stated uncertainty, or on a hotspot) as the safety net.
6. Retrain monthly from the store plus GitHub; watch drift when the review model changes.

## Traps

Label censoring by maxRounds and the daily limit; reviewer drift across model eras; policy drift;
class imbalance (most PRs are one round); leakage from any post-creation signal; the judge
learning size instead of difficulty; per-repo calibration; the valkey repos have human authors
and reviewers, the fork repos are mostly agent-authored.

## Relation to what exists

`review.small` (#109) is the hand-written v0 of tier 1: docs-only or under 200 changed lines go
to `models.reviewSmall`. The trained router replaces that gate and adds tiers 0 and 3; the
"reviewed by <model>" footer and the daemon route log already give the visibility the shadow
phase needs.
