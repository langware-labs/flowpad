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

> **Display sessions use `flow show`, not `flow navigate`.** Everything below
> `flow navigate`s the user's browser tab. If you are in a vibe/creator session
> with a display pane (asked to open/show something "in the display"), use
> `flow show file <path>` / `flow show entity <typeid>` instead — see the
> decision rule at the bottom.

## You already have a TypeId

Run exactly one command, then stop (Display session → `flow show entity <typeid>`
instead):

```bash
flow navigate entity <typeid>
```

Exit `0` = done, stop immediately. (`2` bad TypeId, `3` no tab → tell the user to
open Flowpad, `4` not found, `5` server down.)

## You have a file path you just wrote (no TypeId yet)

This is "open it" after creating a file. **First decide the target** (see the
`flow show` vs `flow navigate` rule below):

**Presenting it into the active process Display** (a vibe/creator session, or
"open it in the display") → use `flow show` — no TypeId, no indexing needed:

```bash
flow show file <absolute-path>   # sets the Display target; stop
```

**Moving the user's own browser tab** to it → the file needs a Flowpad entity,
then its TypeId. Two commands, no research:

```bash
# 1. Index just this file — returns its TypeId in data.typeid.
flow record index <absolute-path> --types markdown

# 2. Navigate the browser tab to the returned TypeId. Stop.
flow navigate entity <data.typeid>
```

`flow record index` is path-scoped and fast; its JSON has `data.typeid`
(e.g. `markdown-<uuid>`) — pass that straight to `flow navigate`. No search, no
guessing. Do not read the file, do not open it with the OS, do not summarize.

## "the current X" (no path, no id)

Resolve via context, then navigate (Display session → `flow show entity` instead
of `flow navigate`):

```bash
flow context list                      # JSON; read e.g. CurrentProjectTypeId
flow navigate entity <that-typeid>     # if the value is null, tell the user and stop
```

## Presenting into a Display vs. moving the browser: `flow show` vs `flow navigate`

Decision rule — key on the **target**, not on who authored the file:

- **The active process Display** (a vibe/creator session with a display pane, or
  the user says "in the display / on screen") → **always `flow show`**, whether
  you created the file/entity or it already existed. `show` never moves the
  user's browser; it sets the display focus for whoever is watching this session.
- **The user's own browser tab** ("jump to", "take me to" an entity, standard
  assistant with no Display) → `flow navigate`. It hijacks the visible tab, so
  never use it to present something on a Display.

Exit 0 = recorded, done — even if nothing is visibly open.

```bash
flow show file <absolute-path>       # a file you just wrote (no TypeId needed)
flow show entity <typeid>            # a known TypeId
flow show webapp --port <port>       # a dev server / web app you started
```

One command, then stop. (`2` bad args, `4` entity not found, `5` server down.)

See `../flowpad-assistance/navigate.md` ONLY if a case above doesn't fit — but the
above covers open/show/navigate. After a successful `flow navigate` or `flow show`
(exit 0), you are done: no verification, no follow-up commands, no report.
