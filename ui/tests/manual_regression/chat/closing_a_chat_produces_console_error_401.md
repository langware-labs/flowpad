test 1: Closing a shell terminal tab does not produce 401 console error (FLOWPAD-1642)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- validate at least one terminal tab is visible in the tab bar
- click the X (close) button on the terminal tab (aria-label="Close tab")
- wait 2 seconds
- check console for any 401 unauthorized errors
- validate no 401 errors appeared in console
