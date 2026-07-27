---
id: 741f5faa-186c-4455-8e51-8e1dacbac1e2
name: toplog
description: >-
  toplog — tag-tracing assistant for debugging. `run` activates the right
  trace tags for a given issue (in code or tests) so RCA has better
  traceability; `scan` reconciles the tags referenced in code against the
  tag catalog; `learn` consolidates post-RCA findings (enrich a tag, add a
  new one with its trace points, or retire a stale one). Use when debugging a
  hard failure and you want richer logs before or alongside RCA, when adding or
  auditing toplog tags, or after proving a root cause to capture the
  traceability that helped. Also triggers on "turn on tracing for X", "what
  tags cover Y", "add a toplog tag", or "audit toplog tags".
tags: ''
eval: 'false'
version: 1
---

# toplog — tag-tracing assistant

Use the toplog mechanism (tag-based runtime logging) to make hard failures
*observable* before and during root-cause analysis, and to grow a curated set of
trace tags over time. This skill operates toplog; it doesn't reimplement it.

This file routes — load the row that matches the task at hand.

## Modes (from the skill arg)

| Skill arg            | Load              | What it does                                            |
| -------------------- | ----------------- | ------------------------------------------------------ |
| `run <issue>` (default when an issue is given) | `modes/run.md`   | Activate tags to trace an issue; feed RCA |
| `scan`               | `modes/scan.md`   | Reconcile code tags with the catalog                 |
| `learn` (usually after RCA) | `modes/learn.md` | Consolidate findings into the catalog + code       |

## Reference

| When you need to…                                   | Load                       |
| --------------------------------------------------- | -------------------------- |
| the registry of known tags + reconciliation rules | `tags.md`                |
| extract tags in code / diff vs catalog            | `scripts/scan_tags.py`   |
| the toplog mechanism + API (`enable/on/off/disable/is_on`, `/api/v1/toplog/*`) | `docs/toplog.md` (repo) |
