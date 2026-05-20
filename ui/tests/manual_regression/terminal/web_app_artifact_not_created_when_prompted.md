---
id: f006426d-69a6-5e5b-9df8-42790f240e43
---

test 1: Web app view is accessible after starting a Claude session (FLOWPAD-1616)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
- click the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait up to 45 seconds for the Claude CLI banner to appear in the terminal
- validate the terminal input is visible (aria-label="Terminal Input")
- navigate to {APP_URL}/dock/web-app
- validate the web-app view loads without crashing (no error page or 404)
- validate the page is accessible (some content is rendered)
