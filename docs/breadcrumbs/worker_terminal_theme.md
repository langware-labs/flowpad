---
title: Worker terminal theme is pinned at launch
tags: [breadcrumb.test.worker_terminal_theme.rules]
description: A worker's text colours come from the CLI's own theme setting read at spawn, so the theme must ride the call that SPAWNS the PTY — createProcess — not the later open, and not the host xterm palette.
---
# Worker terminal theme is pinned at launch

> Ground truth. Proven by RCA on 2026-08-24. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.worker_terminal_theme.rules
sites:
  - rel_path: "tests/long_tests/test_create_process_terminal_theme.py"
    line: 60
    note: "FAILING? read this tag's rules before editing \u2014 the theme must ride createProcess, not open"
```

## Expected behavior

A worker spawned into a light Flowpad terminal must render legibly on white. It
does so because Flowpad passes the host palette into the launch as
`--settings '{"theme":"light"}'`, a per-process settings layer that never touches
the user's `~/.claude/settings.json`.

A worker spawned by a caller with **no terminal** — the recovery sweep, a
trigger, a workflow — must stay unpinned and keep the CLI's own default.

## Internals

**The host palette cannot fix this.** `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`
swaps xterm's `ITheme` on every theme change, which remaps the **16 ANSI slots**
only. Measured on a live PTY, Claude emits `38;2;R;G;B` truecolor and **zero**
ANSI-indexed foregrounds — Flowpad enables that itself by setting
`COLORTERM=truecolor` in `flow_sdk/compute/providers/desktop/provider.py:106`.
So the swap recolours the chrome and the default foreground, and not one
character the CLI writes.

**The RGB values are chosen once, at spawn**, from the CLI's own theme setting.
Measured directly, on-disk theme `light`, same binary:

| launch | emitted |
|---|---|
| no `--settings` | `#5769f7` `#666666` `#966c1e` |
| `--settings {"theme":"dark"}` | `#999999` `#b1b9f9` `#ffc107` |

**The launch happens in `createProcess`, not in `open`.**
`flow_sdk/builtin/faas/scan_actions.py:_scan_create_process` creates the process
**and** spawns its PTY in the same request (`:641`). The client's subsequent
`AgenticProcess._http_open` finds a live worker and reattaches, so it cannot
influence the command line. Instrumentation showed both calls per new terminal,
the spawning one arriving first.

**`start_pty` runs on a reloaded copy.** `agentic_process.py:1375` re-fetches the
entity under the open lock and launches from that object, so a value written to
the caller's copy is discarded. `terminal_theme` is stamped onto `fresh` at
`:1388`, next to `session_id_override` — the same problem, the same remedy.

**Where it becomes a flag:** `cli_drivers/claude/driver.py:cli_options` merges it
into `settings_json`, which `claude/cli.py` renders as `--settings <json>`.
`settings_json` is excluded from `to_json()`, so it cannot churn the restart hash.

## Invariants

* The theme rides **every** call that can spawn — `ComputeNode.createProcess`
  (`scan_actions.py:353,641`) and `AgenticProcess._http_open` (`:7198,7211`).
  Wiring only one leaves the button that users actually press unfixed.
* `start_pty` takes it as a **parameter**, like `visible` and `retry`. It must
  never read the request itself: seven callers (`server/pty_recovery.py:243`,
  `graph_workflow_manager/manager.py:990`, `builtin/trigger.py:222`, restart,
  retry, prompt relaunch, the other create paths) have no request in scope, and a
  contextvar read there can return an unrelated request's body.
* Absent or invalid input leaves the worker **unpinned**. Only `"light"` and
  `"dark"` are accepted; anything else is dropped rather than forwarded.
* `terminal_theme` is persisted, so a recovery relaunch — which passes nothing —
  keeps the palette the worker launched with.
* The client resolves the theme in `ts_sdk/src/utils/runtime.ts:hostTerminalTheme`,
  from the class on `<html>`, and returns `undefined` off-DOM.

## Failure modes

* **Wired to `open` only** → the worker is already alive when the theme arrives;
  argv has no `--settings` and the process row stores `null`.
* **Stamped on the caller's copy** → `start_pty arg='light'` yet
  `cli_options terminal_theme=None`, because the launch runs on a different
  object.
* **Judging by eye** → only accents change (paths, muted lines, output values).
  Body text is dark either way, so a broken build looks nearly identical.
  Assert on argv or on the stored `terminal_theme`, never on a screenshot.
* **Testing in dark mode** → an unpinned worker inherits the usual dark default
  and matches a dark terminal by accident. Dark cannot fail, so it cannot pass.
* **Comparing an existing tab** → printed text keeps the colours it was written
  with. Only a newly spawned worker shows the change.

<!-- flowpad:capsule identity
version: 1
data:
  id: 28087103-5de7-4488-a38b-136791cf0ed3
flowpad:endcapsule identity -->
