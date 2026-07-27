---
id: 39aa5222-f820-522a-9d5c-e623e720fee0
---

# Manual Regression: Terminal Session Persistence on Refresh

## Setup
Start backend (`uv run -m server.run`) and frontend (`cd ui && npm run dev`).

## Test Scenarios

### Scenario 1: Pure terminal (`+` button)
1. Navigate to `http://localhost:4097/dock/shell/`
2. Click `+` (Add terminal tab) — note the URL (`/dock/shell/shell-<uuid>`)
3. Type something in the terminal
4. Hard-refresh the page (Cmd+Shift+R)
5. **Expected:** Terminal tab reappears with session history

### Scenario 2: Claude Code session ("Start Claude" button)
1. Navigate to `http://localhost:4097/dock/shell/`
2. Click "Start Claude" — note the URL (`/dock/shell/agentic_process-<uuid>`)
3. Wait for Claude Code prompt to appear
4. Hard-refresh the page
5. **Expected:** Claude Code session reappears (PTY reconnected)

### Scenario 3: HomeLanding prompt
1. Navigate to `http://localhost:4097/`
2. Type `reply with single word - hello` in the session input, press Enter
3. Note the URL (`/dock/shell/agentic_process-<uuid>`)
4. Hard-refresh the page
5. **Expected:** Session view opens, not "No terminal sessions"

### Scenario 4: Regression — session closing still works
1. Open a terminal, close it via the `×` tab button
2. Refresh
3. **Expected:** Closed session does NOT reappear

## Using debugMCP for Automated Verification
```
1. browser_navigate to http://localhost:4097/dock/shell/
2. browser_click "Add terminal tab"
3. Record URL from browser_tabs
4. browser_navigate to that URL (simulates refresh)
5. browser_wait_for 3s
6. browser_snapshot — verify no "No terminal sessions" text
```
