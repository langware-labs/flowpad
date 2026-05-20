---
type: "workflow"
name: "navigate_to_shell_via_sidebar"
description: "Navigate from the landing page to the Shell view via the sidebar chevron + Shell button, validating route + terminal mount."
asset_id: "0e7cc968-cbe8-4a40-b617-db209a7e54fe"
tags: "[terminal, navigation, smoke]"
---

# Navigate to Shell via Sidebar

## Steps

* Navigate to {APP\_URL}/

* Validate the landing page is visible — an h1/h2/h3 contains "Hey"

* Hover the sidebar's chevron to expand secondary nav items

* Click the "Shell" button (terminal icon) in the sidebar

* Validate the URL pathname matches `/dock/shell/<sessionId>`

* Validate the terminal tab bar is visible with at least one tab

* Validate the terminal content area `[data-testid="terminal-panels"]` is visible

* Validate an active terminal panel `[data-testid="terminal-panel"][data-active="true"]` is rendered with `.xterm` mounted

* Validate the Shell icon in the sidebar shows as active

## Reference (original test text, not part of the executed workflow)

### test 1: Open the shell view from the sidebar

* navigate to {APP\_URL}/

* validate landing page is visible with "Hey" heading

* hover the chevron in the sidebar to expand secondary nav items

* click the "Shell" button (terminal icon >\_) in the sidebar

* validate URL changes to /dock/shell/<sessionId>

* validate the terminal tab bar is visible with at least one tab

* validate the terminal content area (terminal-panels) is visible

* validate an active terminal panel exists with xterm.js rendered

* validate the Shell sidebar icon is shown as active

