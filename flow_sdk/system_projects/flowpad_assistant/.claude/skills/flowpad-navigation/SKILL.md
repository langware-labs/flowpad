---
id: 0d9157ba-e30c-5da0-a42f-87b215d6a4ab
name: flowpad-navigation
description: Drive the Flowpad UI to an entity or file. Use whenever the user asks
  to open, show, navigate to, or jump to a TypeId or file path, including follow-ups
  such as "open it" or "show it" after creating a file. TypeIds may be bare or
  embedded in the request.
---

# flowpad-navigation

**Act now. Do not research how to navigate — the recipe is right here. Never read
other skill files, never `ls` the skills dir, never write a report.** Navigation
is one side-effect that the user sees in their browser; it is a few commands, not
an investigation.

> **Presenting a deliverable uses `flow show`, not `flow navigate`.** Everything
> below `flow navigate`s the user's browser tab, which interrupts them. `flow show`
> works in EVERY mode — it pins the vibe display pane if there is one, and
> otherwise opens the target as a tab beside your process without navigating. Use
> `flow show file <path>` / `flow show entity <typeid>` whenever you are handing
> over something you made — see the decision rule at the bottom.
>
> **Screens are addressable too.** `flow show view <address>` /
> `flow navigate view <address>` open Events, Assets, Preferences, Files,
> Search, the Inbox, Data Sources, Runs and the rest — see "A screen" below.

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

## A screen (Events, Preferences, Assets, Files, …)

Screens are addressed by **view name**, optionally plus `/pointer` and `?opts`
— not by TypeId. One command, then stop:

```bash
flow show view events                       # presenting it — the default
flow navigate view preferences/appearance   # only if they said "take me there"
```

More examples: `assets/list/skill`, `explorer/src`, `search?q=widget`,
`process-runs`, `data-sources`, `capabilities`, `inbox`, `desktop`,
`lens/claude/transcript/<id>`. Quote anything containing `?`.

Don't guess a view name — `flow schema views` lists every one with whether it
needs a pointer. Exit `2` means the view is unknown or its pointer is missing;
exit `4` means the pointer named an entity that doesn't exist.

## "the current X" (no path, no id)

Resolve via context, then navigate (Display session → `flow show entity` instead
of `flow navigate`):

```bash
flow context list                      # JSON; read e.g. CurrentProjectTypeId
flow navigate entity <that-typeid>     # if the value is null, tell the user and stop
```

## Presenting into a Display vs. moving the browser: `flow show` vs `flow navigate`

Decision rule — key on the **intent**, not on the mode and not on who authored
the file:

- **"Here is the thing I made"** → **always `flow show`**, in every mode. It never
  navigates: in a vibe session it pins the display pane; in any other mode it
  opens the target as a tab right after your process and marks your chip. A
  background agent therefore cannot interrupt anyone.
- **"Take me there"** — the user explicitly asks to jump to / open / go to an
  entity → `flow navigate`. It hijacks the tab the user is looking at, so use it
  only when being moved is what they asked for.

When in doubt, `flow show` — the failure mode of showing is a tab the user
ignores; the failure mode of navigating is yanking them out of their work.

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
