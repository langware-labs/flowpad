test 1: Open Terminal button opens a plain shell in the process workdir
- navigate to {APP_URL}/dock/shell/new_terminal then click the Start Claude button (data-testid="start-claude-button")
- wait for the Claude banner
- verify the process has a known workdir via the Info popover (note the Working Dir value)
- click the SquareTerminal icon in the process toolbar (tooltip "Open terminal in <workdir>")
- validate a NEW plain shell tab opens (URL pattern /dock/shell/shell-<uuid>, not agentic_process-<id>)
- in the new tab, validate the xterm is interactive (type `pwd` + Enter)
- validate the printed directory matches the process workdir
- validate the original Claude tab is still open and unchanged

test 2: Open Terminal button is available without a Claude session
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for the plain shell tab; do NOT click Start Claude
- validate the SquareTerminal icon is still visible in the process toolbar (not embedded mode)
- click it; validate a new shell tab opens with a sensible default cwd
