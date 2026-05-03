test 1: Shell terminal input accepts text and executes on Enter
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
- validate the terminal input textarea (aria-label="Terminal Input") is visible
- click the terminal input textarea
- type "echo shell_input_test_enter"
- press Enter
- wait 2 seconds
- validate terminal is still visible and responsive (no crash, active terminal panel still present)
- validate no console errors appear

test 2: Empty Enter press does not crash terminal
- click the terminal input textarea
- press Enter
- wait 1 second
- validate terminal is still visible and responsive

test 3: Tab opener menu exposes Claude and Terminal rows
- validate the tab-opener "+" button (data-testid="opener-plus-button") is visible in the tab bar
- click the "+" button to open the opener menu
- validate the "Claude Code" menu row (data-testid="opener-menu-row-claude") is visible
- validate the "Terminal" menu row (data-testid="opener-menu-row-terminal") is visible
