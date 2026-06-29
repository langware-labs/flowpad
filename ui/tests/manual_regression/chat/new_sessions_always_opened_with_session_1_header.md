---
id: 93149c34-80cc-599f-bb82-604548d1a52e
---

test 1: Adding a second terminal tab shows correct incremented tab name (FLOWPAD-1645)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
- note the name of the first tab visible in the tab bar (should be "Terminal 1" or similar)
- click the tab-opener "+" (data-testid="opener-plus-button") and pick the "Terminal" row (data-testid="opener-menu-row-terminal")
- wait 2 seconds for the new tab to be created
- validate a second tab is visible in the tab bar
- validate the second tab name is NOT the same as the first tab name (i.e., it incremented, not "Terminal 1" again)
