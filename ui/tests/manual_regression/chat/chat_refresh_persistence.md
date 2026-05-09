test 1: Shell session tab persists after page refresh
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
- note the current URL (contains /dock/shell/<session-id>)
- navigate to the same URL again (simulating refresh)
- wait 3 seconds for session sync to complete
- validate terminal is visible (active terminal panel renders xterm)
- validate the session tab is shown in the tab bar
