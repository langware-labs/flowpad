test 1: Shell session tab persists after page refresh
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- note the current URL (contains /dock/shell/<session-id>)
- navigate to the same URL again (simulating refresh)
- wait 3 seconds for session sync to complete
- validate terminal is visible (data-terminal-id present)
- validate the session tab is shown in the tab bar
