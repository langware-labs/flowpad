---
id: 74d00235-6448-5bd9-b3fe-3fed653b412d
---

test 1: Shell terminal starts and is ready within 15 seconds (FLOWPAD-1614)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm, timeout 15s)
- validate terminal input is visible (aria-label="Terminal input")
- validate the terminal rendered without error within 15 seconds of navigation
