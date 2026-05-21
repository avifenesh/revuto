# Learning Guide: Writing Effective Skills for AI Agents

**Generated**: 2026-05-13
**Sources**: 22 resources analyzed
**Depth**: medium

---

## TL;DR

- A skill's `description` field is its entire selection surface at startup — the model sees only `name` + `description` until the skill fires. Write it as an imperative trigger sentence, not a noun-phrase label.
- Body content loads once then stays in context for the session. Every line is a recurring token cost; cut anything the model already knows.
- Review skills differ from capability skills: they need concrete grep targets, confidence ladders, anti-patterns, and explicit "do NOT flag" carve-outs. Without carve-outs, the model piles on noise.
- The three failure modes that sink most skills in production: description too vague to win selection, body too verbose to read carefully, contradictory instructions that make the model hedge.
- This engine stores skills as markdown notes in a vault (YAML frontmatter `name` + `description` + `area`, body below). When an embedder is configured, selection uses cosine similarity over the embedded `name + description + area`; otherwise it falls back to area-glob matching of the skill's `area` patterns against the PR's touched files. Either way, the `description` and `area` decide whether a skill fires — so they carry the same load the registry's semantic search used to.

---

## Prerequisites

- Familiarity with YAML frontmatter
- Basic understanding of AI agent context windows
- Knowledge of Markdown
- Optional: experience with Claude Code, GitHub Copilot, or Cursor

---

## Core Concepts

### 1. The Progressive Disclosure Architecture

Skills use a three-level loading model; understanding it is essential to writing them well.

**Level 1 — Metadata (always loaded, ~100 tokens per skill)**

At agent startup, only the YAML frontmatter fields `name` and `description` are loaded into the system prompt. The full body is not read. This means:

- You can register dozens of skills without a context penalty
- The model decides whether to fire a skill based *solely* on name + description
- Description is not supplementary documentation — it *is* the selection gate

**Level 2 — Instructions (loaded when triggered, recommended < 5 000 tokens / < 500 lines)**

When a task matches a skill's description, the agent reads the full `SKILL.md` via a bash/filesystem call and loads it into context. Once loaded, the content *stays in context for the session* (Claude Code carries it through compaction up to a 25 000-token combined budget for all invoked skills).

**Level 3 — Resources (loaded on demand, no practical limit)**

Additional files (`references/`, `scripts/`, `assets/`) live on the filesystem and are loaded only when SKILL.md explicitly directs the agent to read them. Scripts are executed, not read — only stdout enters context. This makes large reference corpora free until accessed.

**Implication for skill authors**: Keep SKILL.md focused on what the agent needs on *every* run. Move detailed reference material, large tables, and domain-specific schemas to separate files with explicit conditional loading instructions.

---

### 2. The `description` Field: How Selection Works

The description field is the most load-bearing 1024 characters in your skill. The model uses it to answer: "Should I load this skill for the current task?"

**Specification constraints (enforced by all implementations)**:
- Maximum 1024 characters
- Must be non-empty
- No XML tags
- Must be written in third person (Anthropic's official guidance)

**Claude Code additionally has `when_to_use`**: An optional supplementary field, appended to `description` in the skill listing. The combined `description` + `when_to_use` text is truncated at 1 536 characters in the listing.

**What makes a description effective**:

1. **Use imperative trigger phrasing.** The model is deciding whether to act. Tell it when to act.

   ```yaml
   # Poor — noun phrase, passive
   description: PDF text extraction and form handling capabilities.

   # Good — imperative + triggers
   description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.
   ```

2. **Name the task class, not the tool.** Users describe goals, not implementations. Match their vocabulary.

   ```yaml
   # Poor — names the implementation
   description: Uses pdfplumber and pytesseract to process documents.

   # Good — names the goal
   description: Analyze CSV and tabular data files — compute summary statistics, add derived columns, generate charts, and clean messy data. Use when the user has a CSV, TSV, or Excel file and wants to explore, transform, or visualize data, even if they don't explicitly mention "CSV" or "analysis."
   ```

3. **Be explicit about non-obvious triggers.** If the skill applies even when the user doesn't name the domain, say so.

   ```yaml
   description: Generates commit messages by analyzing git diffs. Use when the user asks for help writing commit messages, reviewing staged changes, or wants to "summarize what changed."
   ```

4. **Include "skip" signals for adjacent skills.** If your skill could be confused with another, narrow it.

   ```yaml
   description: Reviews Python code for type annotation coverage. Use when reviewing .py files for missing type hints. Does NOT cover other code quality issues — use the general code-review skill for those.
   ```

5. **Never write first-person.** The description is injected into the system prompt; inconsistent POV breaks selection.

   ```yaml
   # Broken
   description: I help you process Excel files and analyze data.

   # Correct
   description: Processes Excel files and generates analysis reports.
   ```

**The 1 536-character budget problem in Claude Code**: If you register many skills, descriptions are shortened to fit the context budget. The skills you invoke *least* have descriptions dropped first. Counter-strategies:
- Put the key use-case phrase first in the description (it won't be truncated)
- Set low-priority skills to `"name-only"` in `skillOverrides`
- Tune `skillListingBudgetFraction` or `maxSkillDescriptionChars`

---

### 3. Frontmatter Reference

All fields from the Agent Skills open standard and Claude Code extensions:

| Field | Required | Max | Notes |
|-------|----------|-----|-------|
| `name` | Yes (spec) / No (CC) | 64 chars | Lowercase letters, numbers, hyphens; no consecutive `--`; must match directory name per spec |
| `description` | Yes (spec) / Recommended (CC) | 1024 chars | Selection gate; third person |
| `when_to_use` | No (CC only) | counts against 1536 | Appended to `description` in listing |
| `disable-model-invocation` | No | — | `true` = user-invocable only; removes from model's context entirely |
| `user-invocable` | No | — | `false` = model-only; hides from `/` menu |
| `allowed-tools` | No (experimental) | — | Pre-approved tools while skill is active |
| `context` | No (CC only) | — | `fork` = run in isolated subagent |
| `agent` | No (CC only) | — | Subagent type when `context: fork` |
| `model` | No (CC only) | — | Model override for duration of turn |
| `effort` | No (CC only) | — | `low`/`medium`/`high`/`xhigh`/`max` |
| `paths` | No (CC only) | — | Glob patterns: restrict auto-activation to matching files |
| `hooks` | No (CC only) | — | Lifecycle hooks scoped to this skill |
| `argument-hint` | No (CC only) | — | Hint shown in autocomplete |
| `arguments` | No (CC only) | — | Named positional arguments |
| `license` | No (spec) | — | License name or bundled file reference |
| `compatibility` | No (spec) | 500 chars | Environment requirements |
| `metadata` | No (spec) | — | Arbitrary key-value map |

**Invocation matrix**:

| Configuration | User `/invoke` | Model auto-invokes | Description shown to model |
|---|---|---|---|
| Default | Yes | Yes | Yes |
| `disable-model-invocation: true` | Yes | No | No |
| `user-invocable: false` | No | Yes | Yes |

---

### 4. Body Structure: What's Load-Bearing vs Filler

Once a skill fires, its body competes with conversation history and other loaded skills for the model's attention. Every sentence that doesn't earn its token cost reduces signal-to-noise.

**Load-bearing content** (include):
- Step-by-step procedures the model will not derive correctly on its own
- Gotchas — environment-specific facts that defy reasonable assumptions
- Concrete grep targets, file paths, API names
- Input/output templates and examples
- "Skip unless" gates for conditional patterns
- "Do NOT flag" carve-outs that prevent noise

**Filler** (cut):
- Explanations of general concepts the model already knows ("A PDF is a portable document format...")
- Motivational narration ("This skill helps you...")
- Redundant restatements of instructions already given
- Time-sensitive version notes (use an "old patterns" detail block instead)
- Generic best-practice platitudes ("Handle errors appropriately")

**Conciseness test**: Ask "Would the model get this wrong without this line?" If no, cut it.

**Recommended body sections** (not all required; use what applies):

```
## Use when
[When to apply this skill — more detail than the description can fit]

## Quick start / Core procedure
[The primary workflow — the 80% path, concisely]

## Gotchas
[Environment-specific facts that defy assumptions — highest ROI content]

## Patterns
[Named patterns with "skip unless" gates for conditional application]

## What NOT to flag / What to skip
[Explicit carve-outs — critical for review skills]

## Output format / Template
[Template if consistent structure is required]

## See also
[References to supporting files, loaded conditionally]
```

---

### 5. Length and Density Tradeoffs

**Recommended limits**:
- SKILL.md body: < 500 lines, < 5 000 tokens
- Individual reference files: < 100 lines before adding a table of contents
- Nested references: maximum one level deep from SKILL.md

**Short, grep-targeted skills** work best for:
- Single-domain knowledge with tight triggers
- Background reference that augments a conversation (style guides, API conventions)
- Skills loaded frequently where token cost compounds

**Longer, prose-heavy skills** may be necessary for:
- Multi-step workflows with decision branches
- Institutional memory with many named patterns (like a PR review skill)
- Domain areas where the cost of a missed pattern is high

**The density tradeoff in review skills**: Review skills are naturally larger because they bundle many named patterns. The mitigation strategy is strict "skip unless" gating — each pattern names exactly which diff signals must be present before it fires. This keeps the effective working set small even when the total skill is large.

**What production skill libraries actually do**: The valkey-review skill (35KB, ~900 lines) is an outlier justified by institutional memory density. Most production skills are 50–200 lines. The Claude Code built-in skills (`/simplify`, `/debug`, `/review`) are 100–300 lines. The anthropics/skills open-source library averages ~80 lines per SKILL.md.

---

### 6. Negative-Example Sections

**Do they help?** Yes, but targeted negative examples outperform general "do not" lists.

**Effective pattern**: Named carve-outs that prevent false-positive noise.

```markdown
## Do NOT flag these

- `zmalloc`/`zfree` coexisting with `valkey_malloc`/`valkey_free` — this is the design (both sides of a `#define`)
- `slave*` config aliases alongside `replica*` — intentional backward compat
- Any `RedisModule_*` symbol — lives in compat shim, not a missed rename
- `__redis__:invalidate` channel name — renaming breaks all tracking clients
```

**Ineffective pattern**: Generic "avoid" lists that restate common sense.

```markdown
## Do not do these (useless)
- Do not use poor coding practices
- Do not make assumptions
- Do not forget edge cases
```

**Token cost**: Named carve-outs for a review skill typically add 5–15% body length. This cost is paid back immediately by eliminating review noise that would generate human dismissal signals (negative training labels).

---

### 7. Review Skills: What Makes Them Different

A generic capability skill (e.g., "process PDFs") teaches the model *how* to do something. A review skill teaches the model *what to notice and report*.

**Key differences**:

| Aspect | Capability Skill | Review Skill |
|--------|-----------------|--------------|
| Primary output | Artifact (file, report, code) | Assessment (comments, findings) |
| Coverage goal | Complete the task | Identify issues *and* stay quiet on non-issues |
| Failure mode A | Not completing the task | Missing a real bug |
| Failure mode B | Over-engineering | Posting noise (false positives) |
| Key structural element | Workflow steps | Named patterns + carve-outs |
| Confidence handling | N/A | Explicit confidence ladder |

**What a review skill must provide**:

1. **Concrete grep targets and file locations**. "Check if the diff touches `replication.c`" is actionable. "Look for concurrency issues" is not.

2. **Named patterns with skip-unless gates**. Each pattern should state exactly what must be present in the diff before the pattern applies. Broad patterns without gates generate false positives on every PR.

3. **A confidence ladder**. An explicit ladder prevents the model from posting weak inferences as definitive findings.

   ```markdown
   ## Confidence ladder
   - High: source line evidence + named pattern match + logic break
   - Medium: named pattern match + source line with plausible violation
   - Low: pattern match only, no source confirmation — DROP, do not post
   ```

4. **Explicit noise classes to suppress**. Style preferences, rename suggestions for compat-retained identifiers, "consider refactoring" without a specific proposal, "add a test" without specifying what the test checks.

5. **Always-on checks** (cheap, deterministic, no confidence budget needed). DCO sign-offs, formatting CI gates, file presence requirements. These run regardless of diff shape and don't compete with pattern-based analysis.

---

### 8. AgentCore Agent-Skills Registry (AWS Bedrock)

The valkey-reviewer project uses AWS Bedrock AgentCore as its runtime. AgentCore's Memory service provides a `SearchMemoryRecords` API that powers a skill registry pattern.

**How skills are stored as memory records**:

Skills published to the registry are stored as `MemoryRecord` objects with `descriptorType: AGENT_SKILLS`. The relevant content type is `skillMd`, which wraps the SKILL.md content as `inlineContent` (the full markdown string) alongside a structured `skillMetadata` object containing `name` and `description`.

```json
{
  "memoryRecordId": "skill-valkey-security-audit",
  "content": {
    "skillMd": {
      "name": "valkey-security-audit",
      "description": "Use when reviewing PRs that touch authentication, ACL, or TLS code...",
      "inlineContent": "---\nname: valkey-security-audit\n...\n# Full SKILL.md body here\n"
    }
  },
  "descriptorType": "AGENT_SKILLS"
}
```

**SearchRegistryRecords matcher behavior**:

`SearchMemoryRecords` (or the newer `SearchRegistryRecords` in AgentCore) uses **semantic similarity** — not keyword search — over the combined `name` + `description` + `inlineContent` text. The query is the current task description or PR overview. Records are ranked by cosine similarity in the embedding space.

**Practical implications for skill authors targeting AgentCore**:

- The description must be dense with the *vocabulary of the task*, not the vocabulary of the implementation. If PRs are described as "dual-channel replication refactor", your description should contain "replication", "dual-channel", and the domain-specific context words that appear in real PR titles.
- Semantic search rewards descriptions that use the same language as the queries. Do not paraphrase into generic terms ("concurrent system changes") when the actual domain term is more specific ("incremental rehash" or "safe-iterator lifetime").
- The `inlineContent` (full body) is also indexed. Named patterns with specific identifiers (`hashtableTwoPhasePopDelete`, `rehash_idx`, `safe_iterators`) will match PRs containing those identifiers even if the description alone would not fire.
- For the memory-curator use case: the curator should write the `description` by distilling the human feedback into the most query-likely phrasing. The body should include the verbatim identifier names from the source code that triggered the feedback.

---

### 9. Common Failure Modes

**Failure Mode 1: Description Too Vague to Win Selection**

Symptoms: Skill exists but never fires; model handles the task without the skill.

Root cause: Description uses generic terms that don't match real query vocabulary.

```yaml
# Broken — will never fire on a Valkey PR
description: Reviews code for memory management issues.

# Fixed — fires when the diff touches known UAF patterns
description: Applies hashtable iterator-invariant patterns for valkey-io/valkey PRs. Use when the diff touches hashtable.c, t_hash.c, or any caller of TwoPhasePopDelete, findBucket, or safe-iterator lifecycle functions.
```

**Failure Mode 2: Skill Fires Too Often**

Symptoms: Skill activates on unrelated tasks; model spends tokens on irrelevant patterns.

Root cause: Description too broad, or lacks "do not use when" signals.

Fix: Add explicit exclusion clauses or set `disable-model-invocation: true` for skills that should only fire on explicit `/invoke`.

```yaml
description: Valkey cluster topology reviewer. Use when reviewing cluster.c or cluster_legacy.c changes. Does NOT apply to standalone-mode or replication-only changes.
```

**Failure Mode 3: Vague Description That Looks Reasonable**

Symptoms: Skill sometimes fires, sometimes doesn't, on equivalent tasks. Trigger rate < 0.6 in eval.

Root cause: Description tests well on obvious queries but misses the implicit-trigger cases (user doesn't name the domain, uses different vocabulary).

Fix: Run structured trigger evaluation (agentskills.io methodology): create 8–10 should-trigger queries and 8–10 should-not-trigger near-misses, test each 3 times, target trigger rate > 0.8 on positive set and < 0.2 on negative set.

**Failure Mode 4: Body Too Verbose, Key Rules Get Lost**

Symptoms: Model reads the skill but ignores instructions mid-way through.

Root cause: LLMs attend to token proximity — instructions buried in the middle of a 600-line body have lower compliance than those at the start.

Fix: Move the highest-priority instructions to the top. Use `## Always-on checks` or `## CRITICAL` sections near the start. Move large reference tables to supporting files.

**Failure Mode 5: Contradictory Instructions**

Symptoms: Model posts inconsistent comments, hedges, or ignores one set of instructions entirely.

Root cause: Two patterns that both match the same diff shape but prescribe different actions. Can also occur when CLAUDE.md conflicts with a skill.

Fix: Add explicit precedence rules: "If multiple patterns apply, the one with the tighter `skip unless` wins. Do not compound." Each pattern should have a mutually exclusive gate.

**Failure Mode 6: Always-On Checks Not Gated Deterministically**

Symptoms: The model sometimes catches a DCO miss, sometimes doesn't.

Root cause: Always-on checks expressed as guidelines instead of deterministic procedures.

Fix: For truly deterministic checks (formatting, file presence, sign-off), express them as bash commands the agent runs first, not pattern-matching guidance. Dynamic context injection (`` !`git log --format="%s" HEAD~1..HEAD` ``) ensures the check happens every invocation.

---

## Worked Examples

### Example 1: A Well-Written Review Skill

The structure used in the valkey-review production skill (~35KB):

```yaml
---
name: valkey-review
description: "Use when reviewing a valkey-io/valkey PR. Loads institutional memory that the model would not otherwise have - review comments reviewers keep re-stating, decisions taken but not in the code, recurring bug classes. Redis-baseline and code-visible invariants are assumed. Not for authoring (use valkey-dev)."
version: 0.1.0
argument-hint: "[pr-number]"
---
```

**Why this description works**:
- Imperative opening: "Use when reviewing..."
- Names the exact scope: `valkey-io/valkey PR` (not generic)
- States what it adds: "institutional memory...not otherwise have"
- States what it excludes: "Redis-baseline and code-visible invariants are assumed"
- Provides negative scope: "Not for authoring"

**Body structure pattern** (condensed):

```
## Operating rules        ← confidence ladder + global suppression rules

## Always-on checks       ← deterministic, cheap, no pattern budget used

## Grep hazards           ← named carve-outs for false-positive Redis-era names

## Iterator-invariant taxonomy   ← named, numbered patterns with specific identifiers

## Subsystem patterns     ← 34 institutional patterns, each with:
                            - "The diff looks OK but is wrong when:" (what to detect)
                            - "Reviewer memory:" (why it matters)
                            - "Cites:" (PR numbers)
                            - "Skip unless:" (exact gate condition)
```

---

### Example 2: A Short Capability-Reference Skill (API Conventions)

```yaml
---
name: api-conventions
description: REST API design conventions for this codebase. Use when writing or reviewing API endpoints, route handlers, or HTTP client code.
---

# API Conventions

- URL paths: kebab-case (`/user-profiles`, not `/userProfiles`)
- JSON properties: camelCase
- List endpoints require pagination (`cursor` + `limit` parameters)
- Version in URL path (`/v1/`, `/v2/`)
- Error responses: `{ "error": { "code": "...", "message": "..." } }`
- 4xx: client errors; 5xx: server errors; never 200 with an error body

## What NOT to flag

- Legacy `/users/:id/settings` path — predates this convention, migration tracked separately
```

**Why it works**: Dense, no filler, explicit carve-out prevents noise.

---

### Example 3: A Well-Written Small Review Skill

```yaml
---
name: security-review
description: Reviews code changes for common security vulnerabilities. Use when a PR touches authentication, authorization, session handling, input validation, SQL queries, file operations, or cryptography. Skip for purely cosmetic or documentation-only PRs.
---

# Security Review

## Confidence ladder
- Post HIGH: specific line evidence + named pattern
- Post MEDIUM: plausible pattern match + source lines
- Drop LOW: pattern suspicion only, no source confirmation

## Always-on checks (run regardless of diff)
- Secrets or credentials committed in diff (API keys, passwords, tokens)
- `eval()` or `exec()` on user-supplied input
- SQL query built by string concatenation without parameterization

## Patterns

### Injection
Skip unless: diff contains dynamic SQL, shell invocations, template rendering, or deserialization.
- Parameterize all SQL (`?` placeholders or ORM); flag bare string interpolation
- Shell: use `subprocess.run([...])` array form, never `shell=True` with user input
- Deserialization: `pickle.loads(user_data)` is RCE; flag any untrusted deserialization

### Auth bypass
Skip unless: diff touches authentication middleware, session validation, or permission checks.
- New route without auth middleware applied
- `user.is_admin` checked client-side; must be server-side
- JWT validation skipping algorithm check (accept only HS256/RS256 explicitly)

## Do NOT flag
- Hardcoded test credentials in `tests/fixtures/` — not production code
- Base64 encoding presented as "encryption" in test scaffolding
- MD5 used for non-security purposes (cache keys, content hashing)
```

---

## Best Practices Summary

1. **Write the description first.** The body is useless if the skill never fires. Validate your description against 10+ realistic trigger queries before writing the body.

2. **Use "Use when X" as the primary trigger pattern** (Source: Anthropic official docs, agentskills.io). Other effective patterns: "When you see Y, do Z", "Applies to [domain] tasks involving [specific artifacts]".

3. **Gate every pattern with "skip unless"** (Source: valkey-review production skill). The single most important structural element in a review skill. Without gates, patterns fire on every PR and generate noise.

4. **Name specific identifiers, not concepts.** "Check `hashtableTwoPhasePopDelete` callers for scan+shrink races" fires reliably. "Check for concurrency issues in data structures" does not.

5. **Start the body with what matters most.** The confidence ladder and always-on checks go at the top — not buried in section 7.

6. **Keep `SKILL.md` < 500 lines / < 5 000 tokens.** Move large reference tables, API schemas, and example collections to supporting files with conditional loading instructions.

7. **Explicit carve-outs pay for themselves.** 10 lines of "do NOT flag these" saves a stream of human dismissals (your negative training labels for the curator).

8. **Test trigger rate, not just body quality.** Run structured eval: 20-query set (10 positive, 10 near-miss negatives), each run 3 times, target > 0.8 positive trigger rate and < 0.2 false-positive rate. Iterate on the description, not the body, until gates pass.

9. **Avoid time-sensitive content.** Never write "as of version X.Y" or "before the August migration". Use a collapsible "old patterns" section for deprecated info.

10. **One coherent unit per skill.** A skill scoped too broadly becomes impossible to trigger precisely. "Valkey memory management reviewer" is better than "Valkey code reviewer" for memory-specific patterns.

---

## Common Pitfalls Table

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Skill never fires | Description uses abstract terms; real queries use domain vocabulary | Use domain-specific identifiers and task vocabulary in description; run trigger eval |
| Skill fires on everything | Description too broad; no exclusion signals | Add "Does NOT apply to X" clauses; use `disable-model-invocation: true` for manual-only skills |
| Model ignores patterns mid-body | Instructions buried too deep; long body dilutes attention | Move critical rules to top; use "## CRITICAL" or "## Always-on" headers near start |
| Review posts noise | No carve-outs for known false-positive sources | Add explicit "Do NOT flag" section with named identifiers |
| Conflicting patterns | Two patterns overlap; model hedges | Add "if multiple patterns match, narrower skip-unless wins" rule |
| Skill loads but is ignored after compaction | Skill gets dropped from 25K compaction budget | Re-invoke explicitly after compaction; trim body to stay in budget |
| Description truncated in budget | Too many skills registered; descriptions shortened | Put key trigger phrase first; trim to 512 chars for safety |
| AgentCore search misses | Description vocabulary doesn't match PR title vocabulary | Use actual PR vocabulary (file names, function names, commit message style) |

---

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | Official docs | Canonical reference for Anthropic's Skills format, loading model, and three-level architecture |
| [Skill Authoring Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | Official docs | Concise is key, degrees of freedom, evaluation-driven development, anti-patterns |
| [Claude Code Skills](https://code.claude.com/docs/en/skills) | Official docs | Claude Code-specific fields: `when_to_use`, `disable-model-invocation`, `paths`, `context: fork`, `allowed-tools` |
| [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices) | Official docs | CLAUDE.md vs skills comparison; skill lifecycle; context management |
| [Agent Skills Specification (agentskills.io)](https://agentskills.io/specification) | Open standard | Cross-agent spec: validation rules, `compatibility` field, `metadata` field |
| [Optimizing Skill Descriptions (agentskills.io)](https://agentskills.io/skill-creation/optimizing-descriptions) | Guide | Trigger eval methodology: train/validation split, trigger rate, optimization loop |
| [Agent Skills Best Practices (agentskills.io)](https://agentskills.io/skill-creation/best-practices) | Guide | Gotchas sections, templates, calibrating control, procedures vs declarations |
| [anthropics/skills (GitHub)](https://github.com/anthropics/skills) | Examples | Open-source skills library including skill-creator meta-skill |
| [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | Blog post | Engineering design decisions: progressive disclosure, dual-mode (instructions + code), evaluation methodology |
| [Qodo PR Resolver Skills](https://www.qodo.ai/blog/how-i-use-qodos-agent-skills-to-auto-fix-issues-in-pull-requests/) | Case study | Real-world review skill: severity levels, inline comment structure, batch vs interactive workflows |
| [Factory.ai Skills Docs](https://docs.factory.ai/cli/configuration/skills) | Reference | Enterprise pattern: success criteria, verification, idempotency, fallback procedures |
| [valkey-review/config/skill.md](../agents/valkey-review/config/skill.md) | Worked example | Production review skill: iterator-invariant taxonomy, confidence ladder, skip-unless gating (35KB) |

---

## Curator-Specific Guidance: Composing `skill_md` from Human Feedback

This section addresses the valkey-reviewer memory-curator use case directly.

### When to promote a feedback signal to a skill

A human comment becomes a skill candidate when:
- The same correction has been applied to 2+ PRs (pattern, not one-off)
- The correction requires knowledge not in the source code or diff
- The model could not derive the correct behavior by reading the codebase alone

It stays in the curator's short-term memory (not a skill) when:
- It is PR-specific context (this PR's author, this PR's design rationale)
- It is derivable from the diff with careful reading

### `description` composition for the curator

The curator's `description` should:

1. Start with `"Use when reviewing a PR that touches [specific file/function/subsystem]"` — matches real query vocabulary (PR titles, file lists)
2. Include the verbatim identifiers from the source code that triggered the feedback (e.g., `sds *err`, `C_ERR`, `cancelReplicationHandshake`) — these match AgentCore's semantic search when the PR diff contains these identifiers
3. State what the skill adds that code-reading alone can't provide ("cross-PR contract not expressed in types", "decision from PR 945 not in comments")
4. Be 1–3 sentences; do not exceed 512 characters for safety margin against truncation

### Pattern body composition for the curator

Each pattern emitted from curator feedback should follow this template:

```markdown
### [Pattern name — specific, not generic]

The diff looks OK but is wrong when: [what the model will see that looks fine but is actually wrong]
Reviewer memory: [the invariant the model can't derive from the code; cite the PR number if known]
Skip unless: [exact condition: file name, function name, or data structure that must appear in the diff]
```

This mirrors the production valkey-review skill structure and ensures the model can apply pattern gates correctly.

### Confidence decay and skill retirement

A skill should be retired when:
- 10+ PRs reviewed and the pattern has not fired (skip-unless too narrow or pattern is resolved)
- The pattern has been addressed upstream (the code now enforces the invariant)
- Human reviewers stop restating the correction (signal decays)

The curator should track `last_fired_pr_number` and `times_acknowledged` as skill metadata.

---

*This guide was synthesized from 22 sources. See `resources/skill-writing-best-practices-sources.json` for full source list.*
