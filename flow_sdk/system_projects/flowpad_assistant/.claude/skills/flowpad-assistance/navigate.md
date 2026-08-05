# Action: navigate

Drive the user's Flowpad browser tab to a specific entity. The CLI targets the tab the user is currently looking at — you do not need to pick a destination window.

> **Not for presenting a deliverable.** `flow navigate` moves the user's browser
> tab and interrupts them. When you are handing over something you made, use
> `flow show file <path>` / `flow show entity <typeid>` — it works in every mode
> (pinning the vibe display pane where there is one, otherwise opening a tab
> beside your process) and never navigates. Reserve `flow navigate` for an
> explicit "take me there".
>
> **Entities and file paths only.** There is no way to open a screen — Events,
> Assets, Files, Preferences, Settings, Search, Inbox, Data Sources, Runs and the
> other rail destinations are not addressable by either verb. Tell the user which
> rail item to click instead.

## How to navigate

Identify the TypeId from the user's request. A TypeId has the shape `<type>-<id>` (e.g. `shell-550e8400-e29b-41d4-a716-446655440000`, `markdown-abc123…`, `task-<uuid>`). Then run exactly one command:

```bash
flow navigate entity <typeid>
```

That is the entire invocation. Do not wrap it, pipe it, or run it more than once.

## Composing with `context`

For requests like *"navigate to the current project"*, do this in two steps:

1. Run `flow context list`, parse its JSON.
2. Pick the value for the matching key (e.g. `CurrentProjectTypeId`). If it is `null`, stop and tell the user.
3. Pass that TypeId verbatim to `flow navigate entity <typeid>`.

Do not invent a TypeId, do not query the DB another way, do not ask the user — that is the whole point of `context`.

## Composing with `records`

For requests like *"create a task and open it"*: complete the `records` action first (it returns a freshly-indexed TypeId), then pass that TypeId to `flow navigate entity`. One navigation per request — no follow-up "did it open?" verification.

## Opening a file you just wrote (no TypeId yet)

**Presenting it into a vibe/creator Display pane** ("open it in the display") →
use `flow show file <absolute-path>` directly — no TypeId, no indexing — and
stop. Do **not** use `flow navigate` for a Display; it moves the user's browser
tab instead of setting the display target.

**Moving the user's browser tab to it** (standard mode, *"open it / open it in
flowpad"*): the file has no TypeId until it is indexed. `flow record index` is
path-scoped (fast) and returns the minted TypeId in `data.typeid`. Do not
research, do not open it with the OS — run two commands and stop:

```bash
flow record index <absolute-path> --types <record-type>   # e.g. --types markdown; returns data.typeid
flow navigate entity <data.typeid>                        # navigate the browser tab straight to it
```

No search needed — `data.typeid` is the entity to open.

## Expected output

On success the CLI prints a single JSON line to stdout and exits 0:

```json
{"ok": true, "connection_id": "...", "type": "...", "id": "..."}
```

On failure the CLI prints an error line to stderr and exits non-zero:

| Exit | Meaning |
| ---- | ------- |
| `0`  | Navigated. You are done — stop. |
| `2`  | Invalid TypeId. Re-read the user's request and fix the argument. |
| `3`  | No active browser tab. Tell the user to open Flowpad. |
| `4`  | Entity not found. The TypeId is well-formed but the entity does not exist. Tell the user. |
| `5`  | Cannot reach the Flowpad server. Tell the user the server is down. |

## When you are finished

After a successful run, stop. Do not read the URL, do not verify with extra commands, do not summarize at length. The navigation is a single side-effect and the user will see the result in their browser.