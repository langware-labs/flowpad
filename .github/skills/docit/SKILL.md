---
id: 991ce9be-3ec0-4bd4-89c1-7e18d9b438e5
name: docit
description: >-
  Doc-consistency lens for the repo docs. Bare `docit` (or `docit <commit-range |
  path | PR#>`) checks the session's code changes against the docs — no
  contradictions, no broken arch requirements — and brings the docs up to date
  with what actually changed. `docit index` audits the `index.md` Merkle chain the
  docs are navigated through: `index fast` reports staleness with zero LLM calls,
  `index full` rebuilds it. Triggers on "are the docs still true", "update the
  docs for this change", "check the docs against my changes", "is the docs index
  stale", or "rebuild the docs index".
tags: ''
version: 2
---

# Docit — keep code and docs in agreement

Two jobs, one corpus. `sync` reconciles what the docs **say** with the code that
just changed. `index` reconciles the docs' **navigation layer** — the per-folder
`index.md` Merkle chain that `sync`'s tier-2 routing and the `docs-browse` skill
both read — with the files actually on disk.

Docit never rewrites code. Code violations are *reported*; only docs are edited.

This file routes — load the row that matches the task at hand.

## Modes (from the skill arg)

| Skill arg | Load | What it does |
| --------- | ---- | ------------ |
| *(no arg)*, or `<commit-range \| path \| PR#>` — **the default** | `modes/sync.md` | Contradiction pass + freshness pass over the docs the diff touches, then one report |
| `index` — same as `index fast` | `modes/index.md` | Read-only audit of the `index.md` chain: missing, stale, would-clobber, protected. No LLM, no writes |
| `index fast [<root>]` | `modes/index.md` | ↑ stated explicitly |
| `index full [<root>]` | `modes/index.md` | Rebuild the chain for real (LLM summaries + renderer). Writes into the docs tree — show the report and the call estimate first |

`index` is the only reserved first token: if the first whitespace-separated token
is exactly `index`, this is index mode; **anything else is a diff selector**. To
diff a path literally named `index`, write `./index`.

## Reference

| When you need to… | Load |
| ----------------- | ---- |
| the no-LLM staleness report `index fast` prints | `scripts/docs_index_report.py` (this skill) |
| the rebuild plan — stale files + post-order stale folders, as JSON | `flow_sdk/system_projects/flowpad_assistant/.claude/skills/markdown_index/plan.py` (repo) |
| the rebuild protocol, prompts and IndexMdJson schema `index full` obeys | `flow_sdk/system_projects/flowpad_assistant/.claude/skills/markdown_index/` (repo) |
| navigate the resulting chain instead of grepping | the `docs-browse` skill (repo) |

(Canonical location of this skill is `.claude/skills/docit/`, including its
`modes/` and `scripts/`. The `.agents/` and `.github/` copies carry only this
`SKILL.md` — read the mode files from the canonical path.)
