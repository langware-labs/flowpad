---
id: c5d519db-dbd2-53e3-9189-88d357da9de8
---

test 1: Ctrl+C in shell tab sends interrupt signal, not clipboard copy (FLOWPAD-1615)
- [browser] navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
- [browser] run javascript: await navigator.clipboard.writeText('ORIGINAL_CLIPBOARD_CONTENT')
- [browser] click the terminal input (aria-label="Terminal Input")
- type "echo hello" into the terminal input
- [browser] press Ctrl+C
- wait 1 second
- [browser] run javascript: const text = await navigator.clipboard.readText(); return text;
- validate clipboard still contains "ORIGINAL_CLIPBOARD_CONTENT" (Ctrl+C did not overwrite clipboard with terminal text)
