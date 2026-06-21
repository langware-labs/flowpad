---
id: 0d9157ba-e30c-5da0-a42f-87b215d6a4ab
name: flowpad-navigation
description: Drive the Flowpad UI to a specific entity. Use this whenever the user
  asks to open, show, navigate to, or jump to an entity identified by a TypeId (e.g.
  "shell-<uuid>", "markdown-<uuid>", "project-<uuid>", "agentic_process-<uuid>").
  The TypeId may be given as a bare string or embedded inside the request.
---

# flowpad-navigation

**Act now. Do not research how to navigate — the recipe is right here. Never read
other skill files, never `ls` the skills dir, never write a report.** Navigation
is one side-effect that the user sees in their browser; it is a few commands, not
an investigation.

## You already have a TypeId

Run exactly one command, then stop:

```bash
flow navigate entity <typeid>
```

Exit `0` = done, stop immediately. (`2` bad TypeId, `3` no tab → tell the user to
open Flowpad, `4` not found, `5` server down.)

## You have a file path you just wrote (no TypeId yet)

This is "open it" after creating a file. The file needs a Flowpad entity, then its
TypeId. Two commands, no research:

```bash
# 1. Index just this file — returns its TypeId in data.typeid.
flow record index <absolute-path> --types markdown

# 2. Navigate to the returned TypeId. Stop.
flow navigate entity <data.typeid>
```

`flow record index` is path-scoped and fast; its JSON has `data.typeid`
(e.g. `markdown-<uuid>`) — pass that straight to `flow navigate`. No search, no
guessing. Do not read the file, do not open it with the OS, do not summarize.

## "the current X" (no path, no id)

Resolve via context, then navigate:

```bash
flow context list                      # JSON; read e.g. CurrentProjectTypeId
flow navigate entity <that-typeid>     # if the value is null, tell the user and stop
```

See `../flowpad-assistance/navigate.md` ONLY if a case above doesn't fit — but the
above covers open/show/navigate. After a successful `flow navigate` (exit 0), you
are done: no verification, no follow-up commands, no report.
