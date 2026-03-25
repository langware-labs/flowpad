test 1: Adding a second terminal tab shows correct incremented tab name (FLOWPAD-1645)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- note the name of the first tab visible in the tab bar (should be "Terminal 1" or similar)
- click the Add terminal tab button (data-testid="add-terminal-tab-button")
- wait 2 seconds for the new tab to be created
- validate a second tab is visible in the tab bar
- validate the second tab name is NOT the same as the first tab name (i.e., it incremented, not "Terminal 1" again)
