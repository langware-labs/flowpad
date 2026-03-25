test 1: Shell terminal starts and is ready within 15 seconds (FLOWPAD-1614)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible, timeout 15s)
- validate terminal input is visible (aria-label="Terminal Input")
- validate the terminal rendered without error within 15 seconds of navigation
