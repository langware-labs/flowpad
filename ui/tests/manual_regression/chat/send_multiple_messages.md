test 1: Multiple shell commands can be typed without crashing the terminal
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
- click the terminal input textarea
- type "echo command_one"
- press Enter
- wait 1 second
- validate terminal is still visible (no crash)
- type "echo command_two"
- press Enter
- wait 1 second
- validate terminal is still visible (no crash)
- type "echo command_three"
- press Enter
- wait 1 second
- validate terminal is still visible and responsive

test 2: Terminal tab remains active after multiple commands
- validate the active terminal tab is still visible in the tab bar
- validate no unexpected console errors appeared during command execution
