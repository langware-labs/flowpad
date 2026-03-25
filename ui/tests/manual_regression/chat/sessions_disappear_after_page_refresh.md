test 1: Shell sessions persist and do not disappear after page refresh (FLOWPAD-1646)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- navigate to {APP_URL}/dock/home
- navigate back to {APP_URL}/dock/shell
- wait 3 seconds for session sync to complete
- validate at least one terminal tab is still visible in the tab bar (sessions did not disappear)
