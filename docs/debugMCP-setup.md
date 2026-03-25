# debugMCP Setup

## Overview

Two separate browser MCP servers are configured — `debugMcp` for live browser debugging via CDP, and `playwright` for headless automated tests. They use different browsers and never share state.

| | `debugMcp` | `playwright` |
|---|---|---|
| Config file | `~/.claude/mcp.json` | `~/.claude/settings.json` |
| Mode | CDP proxy → live Chrome Canary | Launches own headless Chromium |
| Port | `localhost:9222` | Playwright-managed |
| Use case | Live debugging (`ldb` skill) | Automated E2E tests |
| Chrome Canary required | Yes, must be running first | No |

---

## 1. Chrome Canary — Launch with CDP

Chrome Canary must be running **before** Claude can use `mcp__debugMcp__*` tools.

Launch command:
```sh
/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome\ Canary \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-profile
```

Key flags:
- `--remote-debugging-port=9222` — opens the Chrome DevTools Protocol endpoint at `http://localhost:9222`
- `--user-data-dir=/tmp/chrome-debug-profile` — required on macOS to run a second Chrome instance alongside regular Chrome (separate profile = separate process)

Verify it's running:
```sh
curl http://localhost:9222/json/version
```

### macOS Dock Launcher (optional)

For quick one-click access, create an AppleScript app and add it to the Dock.

Open **Script Editor**, paste this, then save as **Application** (`CanaryLauncher.app`):

```applescript
do shell script "open -na '/Applications/Google Chrome Canary.app' --args --remote-debugging-port=9222 --user-data-dir=\"$HOME/.chrome-canary-live-debugger\" --no-first-run --no-default-browser-check"
```

Key flags used:
- `--remote-debugging-port=9222` — CDP endpoint
- `--user-data-dir="$HOME/.chrome-canary-live-debugger"` — dedicated profile dir so it runs alongside regular Chrome without conflict
- `--no-first-run` / `--no-default-browser-check` — suppress first-launch dialogs

Drag the saved `.app` to the Dock for one-click launch.

---

## 2. debugMcp MCP Server

Configured in `~/.claude/mcp.json` (global — not in repo):

```json
{
  "mcpServers": {
    "debugMcp": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint",
        "http://localhost:9222"
      ]
    }
  }
}
```

This runs `@playwright/mcp` in **CDP proxy mode** — it connects to the already-running Chrome Canary via `localhost:9222` instead of launching its own browser. All `mcp__debugMcp__browser_*` tools control the live Canary tab.

---

## 3. Playwright MCP Server (standard)

Configured in `~/.claude/settings.json` (global):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--browser", "chromium"]
    }
  }
}
```

Launches its own headless Chromium — completely separate from Chrome Canary. Used for automated E2E tests only. Never use `mcp__debugMcp__*` tools for this.

---

## 4. Rules

- Always launch Chrome Canary with `--remote-debugging-port=9222` before using `mcp__debugMcp__*`
- `debugMcp` and `playwright` are separate — do not mix their tools
- Never use `mcp__debugMcp__*` unless explicitly working on live browser debugging
- Load tools via `ToolSearch` before calling any `mcp__debugMcp__*` or `mcp__playwright__*` tool
