# Agent Knowledge Base — Master Index

This directory contains research guides synthesized from online sources for use by the revuto agent family.

## Usage

When a question or task matches a trigger phrase below, load the corresponding guide as additional context.

## Knowledge Base Index

| Topic | Guide File | Sources | Generated |
|-------|-----------|---------|-----------|
| Skill writing best practices (review/code-review focus) | [skill-writing-best-practices.md](skill-writing-best-practices.md) | 22 | 2026-05-13 |

## Trigger Phrases

| If you see... | Load... |
|---------------|---------|
| "how to write a skill" | skill-writing-best-practices.md |
| "skill description" | skill-writing-best-practices.md |
| "SKILL.md format" | skill-writing-best-practices.md |
| "skill trigger" | skill-writing-best-practices.md |
| "skill selection" | skill-writing-best-practices.md |
| "curator compose skill" | skill-writing-best-practices.md |
| "skill_md" | skill-writing-best-practices.md |
| "review skill" | skill-writing-best-practices.md |
| "skill vault" | skill-writing-best-practices.md |
| "skill selection by touched files" | skill-writing-best-practices.md |
| "skill frontmatter / area globs" | skill-writing-best-practices.md |
| "skip unless" | skill-writing-best-practices.md |
| "confidence ladder" | skill-writing-best-practices.md |
| "skill fires too often" | skill-writing-best-practices.md |
| "skill never triggers" | skill-writing-best-practices.md |

## Source Metadata

Full source metadata with quality scores is in `resources/`.

| Guide | Sources File |
|-------|-------------|
| skill-writing-best-practices.md | [resources/skill-writing-best-practices-sources.json](resources/skill-writing-best-practices-sources.json) |

## Worktree and tmp hygiene (owner, 2026-08-17)

- When work in a git worktree is finished — merged, banked, or abandoned — clean it up
  as part of finishing: `git worktree remove <path>` AND delete its branch
  (`git branch -d`; `-D` only once the owner's merge/abandon decision is recorded).
  A closed lane leaves no `wt-*` directory and no stale branch behind.
- Every use of /tmp (or any scratch space) is cleaned by the task that created it:
  delete scratch files and dirs when the task closes, not when disk pressure finds
  them. Motivating incident 2026-08-17: 7 GB of dead lane dirs in /tmp plus an
  unthrottled upload storm flooded 25 GB of swap and stalled the rig.
