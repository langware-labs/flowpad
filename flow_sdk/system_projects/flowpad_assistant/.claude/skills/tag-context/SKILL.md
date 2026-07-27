---
id: 03a5f584-8a1f-5e7a-b7cb-be620066a470
name: tag-context
description: Pull subject-scoped context (design rules, constraints, docs) for
  a dot-taxonomy tag before changing related code. Use this whenever a file
  you are reading or about to modify contains a `flowpad:capsule tag` comment
  block, or a markdown doc lists a `tags:` entry in its frontmatter — the
  marker means curated context exists for that subject. Also use it when the
  user names a tag ("what do we know about flow.runs") or when you need the
  rules governing an area before implementing.
tags:
- tags
- context
- docs
allowed-tools:
- Bash
- Read
- Grep
---

# Tag Context

A **tag** is a dot-separated subject name (`flow.runs`, `--acme--.orders`).
Docs and code point AT tags; `flow tag get` assembles everything bound to
one — that bundle is context you must respect, not background noise.

## The trigger rule

While working, if you encounter EITHER:

- a comment block in source code:

  ```python
  # flowpad:capsule tag
  # version: 1
  # data:
  #   tags:
  #     flow.runs: "Run budgets are enforced here"
  # flowpad:endcapsule tag
  ```

  (in `.ts/.js` files the leader is `//`; in `.md` files it is an HTML-comment
  capsule block)

- or a markdown doc whose frontmatter has `tags: [<name>, ...]`

then curated context exists for those tag names. **Before modifying that
area, pull it.**

## The escalation ladder

Always start cheap; escalate only when needed:

```bash
flow tag get <name>                # line mode — one line per doc/code site
flow tag get <name> --mode block   # ≤60-word summary per doc
flow tag get <name> --mode full    # whole doc bodies — only when load-bearing
```

1. `line` first — orientation: what docs/rules exist, which code sites share
   the subject.
2. `block` for the docs that look relevant to your change.
3. `full` only for a doc that clearly governs what you are about to do.

Asking for a tag includes its descendants (`flow.runs` also returns docs
tagged `flow.runs.budgets`). The command scans the current directory for code
capsules; pass `--root <path>` to scan elsewhere.

## How to treat the result

- Docs returned are **constraints and design rules** for the subject — follow
  them like you would CLAUDE.md instructions scoped to this tag.
- If your change conflicts with a returned rule, STOP and surface the conflict
  instead of silently overriding it.
- Mention the tag(s) you consulted in your final summary (e.g. "per
  `flow.runs` context: kept budgets on the run row").

## Authoring bindings (when asked to tag things)

- Markdown doc → add to its frontmatter:

  ```yaml
  tags: [flow.runs, flow.runs.budgets]
  ```

- Source file → insert the capsule comment block shown above (one `tag`
  capsule per file; list every tag the file relates to in `data.tags`
  with a one-liner saying what THIS file contributes to the subject).

Tag names are lowercase dot-paths (letters, digits, `_`, `-`); user-world
tags start with a `--<namespace>--` first segment.
