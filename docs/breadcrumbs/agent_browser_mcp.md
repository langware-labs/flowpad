---
id: b1ded3de-3a71-4d90-898a-5437c22b2160
title: Agent browser MCP server rules
tags:
- breadcrumb.test.agent_browser_mcp.rules
description: The process the worker CLI launches for agent_browser must stay alive
  and answer initialize itself; never hand off with os.execv (on Windows it ends the
  launched process).
version: 2
---
# Agent browser MCP server rules

> Ground truth. Proven by RCA on 2026-11-16 (FLOWPAD-2376). Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.agent_browser_mcp.rules
sites:
  - rel_path: "tests/long_tests/test_agent_browser_mcp.py"
    line: 51
    note: "FAILING? read this tag's rules before editing"
```

## Expected behavior

A session whose browser is `agent` gets one stdio MCP server, `agent_browser`. Its command is
`mcp_spec()` in `flow_sdk/core/agent_browser.py`: `python -m flow_sdk.core.agent_browser mcp`.
The worker CLI (Claude Code, Codex, Copilot) starts that command, writes `initialize` to its stdin, and
treats the process exiting as the connection closing. The process it started must stay alive for the
whole session and answer on its own stdin/stdout.

## Internals

- `process_assets.py` (`resolve_for` → `browser == "agent"`) appends `mcp_spec()` to the session's
  MCP servers at every launch.
- `_serve_mcp()` in `flow_sdk/core/agent_browser.py`:
  1. `ensure_running()` starts or reuses the agent's Chrome/Edge window. Its state lives in
     `<flow_home>/instances/<instance>/browser/state.json`. If it fails, the process exits 2
     (`NO_BROWSER` / `BROWSER_DID_NOT_START`).
  2. `shutil.which("npx")`. If npx is missing, the process exits 8 (`NEEDS_SETUP`).
  3. `sys.exit(subprocess.call([npx, "-y", "@playwright/mcp@latest", "--cdp-endpoint", ...]))`.
     Playwright MCP runs as a child that inherits the wrapper's stdin/stdout, so bytes go straight
     between the CLI and Playwright. The wrapper only waits, then exits with Playwright's code.

## Invariants

- **The launched PID is the server.** Never hand off with `os.execv` or another `os.exec*`. On
  Windows, exec starts a new process and ends the caller, so the CLI sees its server exit (rc=0)
  before `initialize` is answered. Claude Code then shows `agent_browser (CONNECTION_CLOSED)` and
  no `mcp__agent_browser__*` tools.
- **One launch path on every OS.** No `sys.platform == "win32"` branch, so the behavior can't drift
  between OSs. This was decided on 2026-11-16.
- **argv is a list.** The npx path on Windows has spaces (`C:\Program Files\nodejs\npx.CMD`).
  Windows `os.execv` passed it unquoted, so cmd failed with `'C:\Program' is not recognized`. An
  argv list given to `subprocess` needs no quoting.

Proof (on/off switch, Windows). Claude Code's `init` event reports `agent_browser`:

| launch                 | status      | browser tools |
| ---------------------- | ----------- | ------------- |
| `os.execv`             | `failed`    | 0             |
| `subprocess.call`      | `connected` | 25            |
| reverted to `os.execv` | `failed`    | 0             |

On Linux (WSL), both versions pass the test, because exec does replace the process there.

## Failure modes

- **Exits rc=0 with no reply, and stderr has** **`'C:\Program' is not recognized`.** Something
  reintroduced `os.execv`.
- **Exits rc=2.** Chrome/Edge is missing or won't start. For example, Playwright's full Chromium on
  WSL is missing `libcairo`; point `CHROME_BIN` at Playwright's `chrome-headless-shell` instead.
- **Exits rc=8.** `npx` (Node.js) is not on PATH.
- **Known and accepted:** if only the wrapper is killed while the CLI still holds the pipe,
  Playwright keeps running until the CLI closes the pipe. This was observed on Windows and Linux. A
  normal end, where the CLI closes stdin, leaves nothing running.

