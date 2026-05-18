---
id: 3f96b826-5973-5211-96e9-64b20de8a0ea
---

# Playwright MCP — Usage & Debug

## Config (`.mcp.json`)
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
Uses **Chromium** (not Chrome) — Chrome is always running and blocks a second instance.

## Before Every Use
1. Load tools: `ToolSearch: select:mcp__playwright__browser_navigate` (and others as needed)
2. Navigate: `mcp__playwright__browser_navigate` to `http://localhost:4097`
3. Inspect: `browser_snapshot` for DOM refs, `browser_take_screenshot` for visual checks
4. **Delete screenshots** when done: `rm .playwright-mcp/page-*.png`

## Common Errors

| Error | Fix |
|-------|-----|
| "Browser chromium is not installed" | Call `mcp__playwright__browser_install` once |
| "Opening in existing browser session" | `.mcp.json` is using Chrome instead of chromium — fix config, restart Claude |
| Blank page | Ensure backend is up: `curl http://localhost:9007/health/status` |

## Rules
- Never use `mcp__debugMcp__*` unless explicitly told to
- Never call playwright tools without loading them via ToolSearch first
