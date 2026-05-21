---
name: how-to-write-a-skill
description: "Use when graduating a concern record to a skill_md submission for a reviewer's agent-skills registry. Loads the trigger-phrasing rules, body template, mandatory structural elements (Skip unless, Do NOT flag, confidence ladder), length budgets, and failure modes the curator must follow when composing skill_md. Retrieve at the start of Phase 2 — before writing any markdown."
---

# How to compose a reviewer skill from a graduated concern record

This skill is the curator's reference for **Phase 2 only**. Phase 1
decisions (bump / merge / create / drop / noop) do not need this
content — read it after `bump_concern` or `merge_concerns` returns a
reinforcement_count at or above the graduation threshold.

The reviewer searches its agent-skills registry on every PR run via
`SearchRegistryRecords`, which uses **semantic similarity** over
`name + description + skill_md body`. Whatever you write here becomes
the reviewer's textbook entry. A weak description never fires; a vague
body fires too often. Both fail modes degrade review quality.

## Selection mechanics — what the matcher actually sees

The reviewer's registry search keys on three fields, in order of
weight: `name` (slug, low weight), `description` (high weight, this
is the trigger gate), `inlineContent` (the full body, indexed for
identifier match).

The query at search time is the PR overview — title, file list, body.
Your description must use the *vocabulary of that overview*, not the
vocabulary of the implementation:

- Good: `"Use when reviewing PRs that touch glide-core/src/timeout_watchdog.rs or call into ConnectionManager::reconnect"`
- Bad: `"Use when reviewing connection-management code"`

The body is also indexed. Specific identifiers in the body
(`hashtableTwoPhasePopDelete`, `cancelReplicationHandshake`,
`safe_iterators`) act as semantic anchors that fire on PRs containing
those tokens even if the description alone wouldn't match.

## Frontmatter rules

```
---
name: <slug-of-subject>          # 3-8 words, lowercase, hyphens only
description: <imperative trigger> # 1-3 sentences, ≤ 512 characters
---
```

Description is the entire selection gate. Non-negotiable rules:

- **Imperative trigger phrasing.** Start with `Use when reviewing a PR that touches <specific-area>`. Never noun-phrases. Never first-person.
- **Semantic vocabulary, not abstract framing.** Lift the verbatim file paths, function names, struct names, and domain terms from the source concern record's `area` and `concern` fields. The matcher's similarity score depends on these tokens overlapping with the PR overview.
- **Bound the scope.** Add `"Does NOT apply to <adjacent-area>"` if the description could otherwise fire on near-misses.
- **Third person.** "Reviews ..." not "I review ...". POV inconsistency breaks selection.
- **≤ 512 characters.** Above that risks truncation in the listing budget.

## Body template

Write sections in this order. Omit any that don't apply.

```
## Use when
[One paragraph elaborating the description's trigger — what file/function/diff shape activates this skill.]

## Confidence ladder
[How confident the reviewer must be before posting:
 - Post HIGH: source-line evidence + named pattern + invariant break
 - Post MEDIUM: named pattern match + plausible source-line violation
 - Drop LOW: pattern suspicion only, no source confirmation]

## Always-on checks
[Deterministic, cheap gates that run regardless of diff shape — file presence, sign-off, format.
 Express as bash one-liners or exact greps, not pattern-match guidance. Optional.]

## Patterns
[One ### subsection per named pattern. Every pattern follows this template:

### <Pattern name — specific, not generic>
The diff looks OK but is wrong when: <what the model will see that looks fine but is actually wrong>
Reviewer memory: <the invariant the model can't derive from the code; lift verbatim from the concern's `context` field if present>
Skip unless: <exact diff condition: file name, function name, or identifier that must appear>
]

## Do NOT flag
[Named carve-outs that prevent false-positive noise. Use exact identifiers, not concepts:
 - `<symbol>` coexisting with `<other-symbol>` — intentional <reason>
 - `<file-path>` — predates the convention, tracked separately
 Without this section the reviewer fires the pattern on cosmetic and compat-shim cases.]
```

## Mandatory structural rules

Failure to follow any of these produces a skill that misfires:

1. **Every pattern has a `Skip unless:` line.** No exceptions. A pattern without a gate fires on every PR and generates noise. If you cannot articulate what must appear in the diff for the pattern to fire, the pattern is not ready to ship as a skill.
2. **The confidence ladder goes near the top**, not buried. Models attend to early-body content more reliably than late.
3. **Name specific identifiers, not categories.** `cancelReplicationHandshake`, `safe_iterators`, `t_hash.c` — not `replication code`, `iterators`, `the hash module`.
4. **No maintainer names, PR numbers, or review IDs in the body.** The pattern is the signal; identities are not. They rot.
5. **No time-sensitive language.** Don't write "as of 2026" or "before the rebase". The skill outlives its source PR.
6. **No filler.** Cut anything the model already knows. Cut motivational narration ("This skill helps you..."). Cut general-knowledge restatements.

## Length budget

- Target: 50–250 lines. Most graduations land at 80–150.
- Hard ceiling: 500 lines. Above that, instructions get buried mid-body and the model ignores them.
- Production review skills average 80–150 lines. Outliers (35KB) only earn their length through institutional-memory density across many subsystems.

## Voice and citation

- Prose, not corporate. No emojis. No greetings. No sign-offs.
- Cite the originating concern at the bottom: `_(graduated from concern record_id=<id>)_`. Nothing else.

## Common failure modes

**Vague description → never fires.** Description uses abstract terms; real PR queries use domain vocabulary. Fix: lift verbatim identifiers from the concern's `area` and `concern` fields into the description.

**Too-broad description → fires on everything.** Description lacks exclusion signals. Fix: add `"Does NOT apply to X"` clauses.

**Buried instructions mid-body.** Long body dilutes attention; rules at line 400 don't get followed. Fix: confidence ladder + always-on checks first, patterns after.

**Contradictory patterns.** Two patterns overlap on the same diff shape but prescribe different actions. Fix: each pattern's `Skip unless:` should be mutually exclusive; if they're not, merge them.

**Non-deterministic always-on guidance.** "Check for missing DCO" is sometimes followed, sometimes not. Fix: express deterministic checks as bash one-liners (`git log --format='%s' -1 | grep -q 'Signed-off-by'`), not pattern-match guidance.

**Stylistic-rule contamination.** A "do not cite PR numbers" rule ends up as a graduated skill. Fix: stylistic rules are curator-level; never graduate them. They live in the curator's prompt and skill, not in the reviewer's registry.

## What to do at Phase 2 entry

1. Read this skill. Internalize the mandatory rules.
2. Read the bumped/merged source concern record in full — `area`, `subject`, `concern`, `context`.
3. Compose `name` (slug of subject) and the `description` per the rules above. The description gates everything; spend disproportionate effort here.
4. Compose the body following the template. Every pattern needs `Skip unless:`. Add `## Do NOT flag` if the underlying concern has ever attracted a stylistic edit or "this is intentional" clarification.
5. Call `submit_skill` with the composed `subject`, `description`, and `skill_md`. Description in `submit_skill` should match the frontmatter description verbatim — do not paraphrase.
6. Do not call `delete_concern` on the source record. The record stays until registry approval is final.

_(curator-owned skill; source: agents/curator/skills/how-to-write-a-skill.md)_
