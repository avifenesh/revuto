---
name: valkey-reviewer-curator
description: "Use when curating reviewer-feedback events for the valkey-review and valkey-glide-review agents. Loads the lessons accumulated from running the curator on real upstream PRs — bump-vs-create heuristics, area_bucket conventions, polarity reading, graduation hygiene. The base prompt covers workflow; this loads the judgment calls that prompt cannot."
---

# valkey-reviewer curator — institutional memory

The base prompt tells you the workflow. This file is the lessons learned
from running the curator on real upstream feedback. Read it once per run
and let it inform Phase 1 decisions; do not narrate it in your output.

## Reading polarity

The single most error-prone judgment is "what is the human actually
saying about the bot's comment?". Common shapes seen in production:

- **Plain reinforcement** — "good catch", "you're right", "agree", `+1`,
  thumbs-up reaction. → bump the matching record.
- **Reinforcement-with-extension** — "yes, and the same thing happens
  in <other-place>" or "right, plus <related-pattern>". → bump, and if
  the extension materially widens the area, update the record's `area`
  glob list rather than create a sibling. Two records that overlap on
  the same diff shape will both fire and produce duplicate findings.
- **Reinforcement-with-context** — "yes, this is intentional because
  <history>". → bump, and if the human supplied genuine off-code
  context, append it to the record's `context` field. Do not
  paraphrase; lift the maintainer's wording.
- **Pushback (substantive)** — "this is not actually a bug because
  <reason>". → this is the bot getting a finding wrong. Often the
  right move is to *create* a new record describing what makes the
  bot's class-of-flag inappropriate in this area, not to bump or
  delete anything.
- **Pushback (stylistic)** — "drop the PR-number reference", "rephrase
  this", "less harsh tone". → these are curator-level rules, not new
  records. Do not create a record from a stylistic comment about the
  bot's prose.
- **Author defense** — PR author replies to the bot or to a maintainer
  defending their own PR. The receiver already drops most of these,
  but if one reaches you, treat it as low signal: drop unless the
  author cites concrete code evidence the bot missed.
- **Off-topic chatter** — maintainers debating an unrelated point in
  the same thread. → drop.

When polarity is genuinely unclear (e.g. a one-word "ok" with no
context), prefer **noop** — wait for the next event in the same area
to clarify rather than guessing.

## area_bucket conventions

The `area_bucket` (PK) is what partitions storage and drives
list_concerns. Pick it so the next reviewer query that should hit this
record actually does. Conventions seen working:

- **Top-level segment** for monorepo roots: `glide-core`, `java`,
  `python`, `node`, `go`, `src`, `deps`, `tests`, `tests/unit/cluster`.
- **One level deeper on shared roots** when the concern is
  subsystem-scoped: `src/replication.c`, `src/reply_blocking.c`,
  `glide-core/src/client`.
- **Avoid going deeper than two levels.** A bucket like
  `src/replication.c/handshake/seed-phase` will never be queried that
  way and the record becomes invisible.

If a concern truly spans many top-level areas, list the broadest
useful bucket and put the file globs in the record's `area` field. The
reviewer's retrieval is by bucket; `area` is what it sees once the
record is loaded.

## Bump vs create vs merge

Defaults that have held up in production:

- **Bump > create.** When in doubt, bump. The reviewer pays more for a
  duplicated record than for a missed reinforcement on an existing
  one. A record that gets bumped from 1 to 2 is on a path to
  graduation; a redundant new record dilutes the bucket.
- **Create only when the existing records' subjects don't cover the
  new shape.** "Subject doesn't cover" means: a reviewer reading the
  existing records before this PR would still have made the bot's
  mistake. If they would have caught it, bump.
- **Merge two records only when you've read both and the overlap is
  real.** Merging loses fidelity; the resulting record has to inherit
  both areas, both subjects, both contexts. Lossy merges produce vague
  records that fire on too much.
- **noop** is a real choice. Use it when the human's signal is
  ambiguous, when the matching record exists at the right strength but
  doesn't deserve a bump (e.g. the human didn't actually engage with
  the substance), or when the right move is to wait for one more
  event.

## Concern wording

A concern is text the next reviewer will read **before** reviewing
this area. Phrase it that way:

- **Affirmative voice.** "When reviewing X, check that Y" is better
  than "Don't forget Y". The reviewer is being briefed, not lectured.
- **Concrete identifiers.** Name the function, struct, file, or
  invariant by its real symbol. `replicationHandlePrimaryDisconnection`
  beats "the disconnect handler". Specific identifiers are also what
  drives semantic match in the registry once this graduates.
- **Avoid PR numbers, maintainer names, review IDs.** They go in the
  `context` field if they go anywhere, never the `concern` text.
- **2–4 sentences.** Longer than that and the next reviewer skims.
- **No second-order rules.** A concern is "what to flag here", not
  "the curator should later do X". Curator behavior belongs in this
  skill file or the prompt, not in concerns records.

## Context field

`context` carries the off-code "why" the reviewer cannot derive from
the diff. Examples that earned their slot:

- "Before PR #N a synchronous waitForClientIO call meant
  freeClient(primary) ran inline; PR #N replaced it with an async-free
  path, which is what makes the new race possible."
- "Maintainer clarified that the asymmetry between immediate module
  notifications and deferred client pub/sub is intentional — modules
  must observe state at the originating call site."
- "Vendored from upstream lz4; project policy is byte-identical
  re-vendoring, do not modernize."

Examples that should NOT be in context:

- The bot's reasoning ("the bot suspected this because…")
- Restated diff content ("this code calls freeClient async…")
- General programming knowledge ("Mutex+Condvar requires holding the
  guard during wait…")
- Speculation about what the maintainer "probably" meant

When the human's reply does not supply genuine off-code context, leave
`context` empty. Empty is correct. Inventing context is worse than
omitting it.

## Graduation hygiene

Graduation is rare. By the time you're composing `skill_md`, the
record has been reinforced 4+ times across distinct PRs. The body of
`skill_md` should reflect that — patterns named at this strength have
multiple call-site examples, and including 1–2 of them in
`## Patterns` makes the skill self-justifying to the next reviewer.

When composing the skill markdown, follow the template in the prompt's
Phase 2. The non-obvious rules:

- **Description vocabulary matches PR title and file vocabulary.** The
  reviewer's matcher is semantic; if the description says "memory
  ordering" but real PRs say "atomic fences" and "Acquire/Release",
  the skill won't fire when it should. Lift the verbatim symbols from
  the source records' `area` and `concern` fields.
- **Every pattern has a `Skip unless:` line.** No exceptions. If you
  cannot articulate what must appear in the diff for the pattern to
  fire, the pattern is not ready to ship as a skill.
- **`## Do NOT flag` is mandatory** when the underlying concern has
  ever attracted a stylistic edit or a "this is intentional" clarification.
  Carve-outs prevent the noise that creates negative training signals.
- **No PR numbers in the body.** They rot. Cite the originating
  concern record_id at the bottom and stop there.

## Things to never do

- Never call `submit_skill` without a preceding `bump_concern` or
  `merge_concerns` whose returned `reinforcement_count >= threshold`.
  Graduation is evidence-gated; manual graduation always misfires.
- Never call `delete_concern` after a successful `submit_skill`. The
  source record stays until the registry record is fully active. If
  approval gating is on (it is), deleting now orphans the registry
  record from its provenance.
- Never paraphrase the maintainer's words into the `context` field.
  Lift verbatim and trim, do not rewrite. Their wording is evidence;
  yours is not.
- Never use `curator_done` with `decision=created` if the matching
  bucket has 5+ records already. That's a signal the bucket needs
  merging, not another sibling. Pick `noop` and let a bump path
  reach those records first.

## Failure modes seen in production

- **Over-curation cascade**: a single noisy thread produces 3 records
  on similar-but-not-identical aspects of the same concern. The
  reviewer then over-fires on every PR touching that area. Symptom:
  bucket has 4+ records all at reinforcement_count=1 with overlapping
  `area` globs. Fix: a future curator run should merge.
- **Under-curation drift**: the same maintainer correction recurs on
  4+ PRs but each time the curator picked `noop` because the wording
  was different. Fix: when reading list_concerns, attend to the
  *substance* of existing concerns, not their phrasing.
- **Stylistic-rule contamination**: a concern record contains "do not
  cite PR numbers in surfaced text". This is a curator-level rule, not
  a record. Fix: drop the record at decay or merge into nothing; do
  not let it graduate.
- **Polarity flip**: the curator interprets "I disagree" as
  reinforcement because the maintainer's reply was long. Fix: when in
  doubt about polarity, read the bot comment and the human reply
  side-by-side; ask "did the human just confirm or challenge what the
  bot said?" before deciding.

## Calibration reminder

The two failure modes have equal weight. Over-curation degrades
retrieval quality (noise records dilute relevant ones); under-curation
loses signal (real patterns never reach the threshold). When in doubt,
prefer under-curation — the next event will pick up a real pattern;
clearing noise out of the store later is expensive.
