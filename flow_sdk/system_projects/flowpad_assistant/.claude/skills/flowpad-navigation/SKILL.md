---
name: flowpad-navigation
description: Drive the Flowpad UI to a specific entity. Use this whenever the user asks to open, show, navigate to, or jump to an entity identified by a TypeId (e.g. "shell-<uuid>", "markdown-<uuid>", "project-<uuid>", "agentic_process-<uuid>"). The TypeId may be given as a bare string or embedded inside the request.
tags:
  - navigation
  - ui
  - flowpad
allowed-tools:
  - Bash(flow navigate entity:*)
---

# Flowpad navigation

You can steer the user's browser tab by invoking the Flowpad CLI. The CLI
targets the tab the user is currently looking at — you do not need to pick
a destination window.

## How to navigate

Identify the TypeId from the user's request. A TypeId has the shape
`<type>-<id>` (e.g. `shell-550e8400-e29b-41d4-a716-446655440000`,
`markdown-abc123…`). Then run exactly one command:

```bash
flow navigate entity <typeid>
```

That is the entire invocation. Do not wrap it, pipe it, or run it more
than once.

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

After a successful run, stop. Do not read the URL, do not verify with
extra commands, do not summarize at length. The navigation is a single
side-effect and the user will see the result in their browser.