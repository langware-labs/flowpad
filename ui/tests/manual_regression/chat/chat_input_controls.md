---
type: "workflow"
name: "chat_input_controls_opener_menu"
description: 'Verify the shell tab opener "+" menu exposes Claude Code and Terminal rows'
asset_id: "aefe262f-b53a-4707-9158-f7e120125561"
tags: "[chat, terminal, smoke]"
---

# Tab Opener Menu Exposes Claude and Terminal Rows

## Steps

* Navigate to {APP\_URL}/dock/shell/new\_terminal

* Wait for the active terminal panel `[data-testid="terminal-panel"][data-active="true"]` to render

* Validate the tab-opener "+" button (`data-testid="opener-plus-button"`) is visible in the tab bar

* Click the "+" button to open the opener menu

* Validate the "Claude Code" menu row (`data-testid="opener-menu-row-claude"`) is visible

* Validate the "Terminal" menu row (`data-testid="opener-menu-row-terminal"`) is visible

## Reference (other related tests, not part of the executed workflow)

### test 1: Shell terminal input accepts text and executes on Enter

* navigate to {APP\_URL}/dock/shell/new\_terminal

* wait for terminal to be ready (active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)

* validate the terminal input textarea (aria-label="Terminal Input") is visible

* click the terminal input textarea

* type "echo shell\_input\_test\_enter"

* press Enter

* wait 2 seconds

* validate terminal is still visible and responsive (no crash, active terminal panel still present)

* validate no console errors appear

### test 2: Empty Enter press does not crash terminal

* click the terminal input textarea

* press Enter

* wait 1 second

* validate terminal is still visible and responsive

