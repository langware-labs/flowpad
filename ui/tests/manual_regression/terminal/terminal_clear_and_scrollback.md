---
type: workflow
name: terminal_clear_and_scrollback
description: Type three echo commands, run `clear`, validate visible area is cleared, then check scrollback still has prior output.
asset_id: 3a308a73-fd3b-4dd6-8208-bf4c0301a65b
tags: [terminal, scrollback, smoke]
---

# Terminal Clear + Scrollback

## Steps
- Navigate to {APP_URL}/dock/shell/new_terminal
- Validate an active terminal panel `[data-testid="terminal-panel"][data-active="true"]` is rendered with `.xterm` mounted
- Type "echo line one" then press Enter; validate "line one" appears in the visible terminal output
- Type "echo line two" then press Enter; validate "line two" appears in the visible terminal output
- Type "echo line three" then press Enter; validate "line three" appears in the visible terminal output
- Type "clear" then press Enter
- Validate the visible terminal area no longer shows "line one"/"line two"/"line three"
- Scroll up in the terminal viewport (mouse wheel up or PageUp) to access scrollback
- Validate the scrollback buffer still contains "line one" (or fail the step if the terminal does not preserve scrollback)

## Reference (original test text, not part of the executed workflow)

### test 1: Clear command clears terminal and scrollback is preserved
- navigate to the Shell view via sidebar
- validate terminal is visible and ready
- type "echo line one" and press Enter
- validate "line one" appears in output
- type "echo line two" and press Enter
- validate "line two" appears in output
- type "echo line three" and press Enter
- validate "line three" appears in output
- type "clear" and press Enter
- validate the visible terminal area no longer shows the previous output
- scroll up in the terminal (if scrollback is supported)
- validate scrollback buffer still contains previous output
