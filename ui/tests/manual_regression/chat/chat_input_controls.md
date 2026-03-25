test 1: Shell terminal input accepts text and executes on Enter
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- validate the terminal input textarea (aria-label="Terminal Input") is visible
- click the terminal input textarea
- type "echo shell_input_test_enter"
- press Enter
- wait 2 seconds
- validate terminal is still visible and responsive (no crash, data-terminal-id still present)
- validate no console errors appear

test 2: Empty Enter press does not crash terminal
- click the terminal input textarea
- press Enter
- wait 1 second
- validate terminal is still visible and responsive

test 3: Claude start button is visible in terminal tab bar
- validate the Start Claude button (data-testid="start-claude-button") is visible in the tab bar
- validate the Add terminal tab button (data-testid="add-terminal-tab-button") is visible
