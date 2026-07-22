---
id: 03a5f584-8a1f-5e7a-b7cb-be620066a470
name: topic-context
description: Pull subject-scoped context (design rules, constraints, docs) for
  a dot-taxonomy topic before changing related code. Use this whenever a file
  you are reading or about to modify contains a `flowpad:capsule topic` comment
  block, or a markdown doc lists a `topics:` entry in its frontmatter — the
  marker means curated context exists for that subject. Also use it when the
  user names a topic ("what do we know about flow.runs") or when you need the
  rules governing an area before implementing.
tags:
- topics
- context
- docs
allowed-tools:
- Bash
- Read
- Grep
---

# Topic Context

A **topic** is a dot-separated subject name (`flow.runs`, `--acme--.orders`).
Docs and code point AT topics; `flow topic get` assembles everything bound to
one — that bundle is context you must respect, not background noise.

## The trigger rule

While working, if you encounter EITHER:

- a comment block in source code:

  ```python
  # flowpad:capsule topic
  # version: 1
  # data:
  #   topics:
  #     flow.runs: "Run budgets are enforced here"
  # flowpad:endcapsule topic
  ```

  (in `.ts/.js` files the leader is `//`; in `.md` files it is an HTML-comment
  capsule block)

- or a markdown doc whose frontmatter has `topics: [<name>, ...]`

then curated context exists for those topic names. **Before modifying that
area, pull it.**

## The escalation ladder

Always start cheap; escalate only when needed:

```bash
flow topic get <name>                # line mode — one line per doc/code site
flow topic get <name> --mode block   # ≤60-word summary per doc
flow topic get <name> --mode full    # whole doc bodies — only when load-bearing
```

1. `line` first — orientation: what docs/rules exist, which code sites share
   the subject.
2. `block` for the docs that look relevant to your change.
3. `full` only for a doc that clearly governs what you are about to do.

Asking for a topic includes its descendants (`flow.runs` also returns docs
tagged `flow.runs.budgets`). The command scans the current directory for code
capsules; pass `--root <path>` to scan elsewhere.

## How to treat the result

- Docs returned are **constraints and design rules** for the subject — follow
  them like you would CLAUDE.md instructions scoped to this topic.
- If your change conflicts with a returned rule, STOP and surface the conflict
  instead of silently overriding it.
- Mention the topic(s) you consulted in your final summary (e.g. "per
  `flow.runs` context: kept budgets on the run row").

## Authoring bindings (when asked to tag things)

- Markdown doc → add to its frontmatter:

  ```yaml
  topics: [flow.runs, flow.runs.budgets]
  ```

- Source file → insert the capsule comment block shown above (one `topic`
  capsule per file; list every topic the file relates to in `data.topics`
  with a one-liner saying what THIS file contributes to the subject).

Topic names are lowercase dot-paths (letters, digits, `_`, `-`); user-world
topics start with a `--<namespace>--` first segment.
