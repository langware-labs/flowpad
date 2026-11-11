---
id: d20515ad-69aa-41bc-a1b9-40b86309d7ef
title: An absolute path with a spaced folder links as one reference
tags:
- breadcrumb.test.spaced_path_links.rules
description: An agent wrote `~/Flowpad workspace/lesson-4-plan.md` in inline code;
  TOKENS split it at the space, wrapCode found no single whole match, so no link rendered
  — and the bare `lesson-4-plan.md` it fell back to 404s because that folder is not
  a session link root. A whole inline-code absolute file path now links as one reference
  via SPACED_ABSOLUTE_FILE.
version: 2
---
# An absolute path with a spaced folder links as one reference

> Ground truth. Proven by RCA on 2026-11-02. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.spaced_path_links.rules
sites:
  - rel_path: "ui/tests/unit/remark-link-refs.test.ts"
    line: 25
    note: "FAILING? a whole inline-code absolute path with spaces in its folders must stay ONE link (SPACED_ABSOLUTE_FILE in wrapCode). Read this tag's rules before touching link-matches TOKENS or remark-link-refs wrapCode."
```

## Expected behavior

A chat message that names a file by its full path in inline code —
`` `~/Flowpad workspace/lesson-4-plan.md` `` — renders that whole span as ONE
clickable link, and clicking it opens the file. A space inside a folder name
does not break the reference.

## Internals

* `ui/src/lib/link-matches.ts:68` `TOKENS` cuts plain text at whitespace. Only a
  quoted span or `BRACKETED_PATH` (`link-matches.ts:65`, a path inside `( )`)
  keeps a space inside one token.

* `ui/src/lib/remark-link-refs.ts:52` `wrapCode` links an inline-code span only
  when the span's text is ONE whole match. The code span reaches it without its
  backticks, so `QUOTED` never applies and a spaced path splits into
  `["~/Flowpad", "workspace/lesson-4-plan.md"]` → no link.

* Fix: `SPACED_ABSOLUTE_FILE` (`link-matches.ts:67`) — an absolute root (`/`,
  `~/`, a drive), any folders (spaces allowed), and a final file name with NO
  space and an extension. `wrapCode` checks it first (`remark-link-refs.ts:54`).

* Backend side, unchanged: `flow_sdk/core/display_link.py:86` resolves a
  RELATIVE link only under `source.link_roots()`
  (`entity_model.py:3911`, `agentic_process.py:7265`): the shell's live cwd,
  workdir, project root, mounted dirs. A bare name outside them is a correct 404.

## Invariants

* A whole inline-code span that is an absolute path ending in a space-free file
  name is one link, whatever spaces its folders hold.

* A code span that is a command (`` `/usr/bin/env -S python x.py` ``) is not —
  its last segment carries a space, so `SPACED_ABSOLUTE_FILE` rejects it.

* Do not widen `link_roots` to "find the file anywhere" to compensate for a dead
  link: the full path must be linkable instead.

## Failure modes

* Remove the `SPACED_ABSOLUTE_FILE` branch in `wrapCode` → the full path renders
  as dead code text; the only link left in the message is the bare file name,
  which 404s with "File not found in this session or project".

* Proven lever (prod :9007, session 584d9b33): a copy of the file under the
  session root → `resolve-display-target` SUCCESS; remove it → 404; send the
  full path → SUCCESS.

