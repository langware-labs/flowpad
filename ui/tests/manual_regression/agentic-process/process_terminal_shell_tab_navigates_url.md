test 1: Clicking a shell tab from agentic process view updates the URL
- navigate to /dock/shell/new_terminal
- wait for shell tab to be ready
- note the shell session URL (contains shell-<id>)
- click the Start Claude button (data-testid="start-claude-button")
- wait for URL to change to /dock/shell/agentic_process-<id> (not -new)
- wait for the PTY tab to appear in the tab bar (may take up to 30s for startPty to complete)
- while viewing the agentic process tab, click the original shell tab in the tab bar
- validate the URL changes to /dock/shell/shell-<id> (not stays on agentic_process)

KNOWN BUG (fixed 2026-03-07): ProcessTerminal.handleSessionChange did not call navigation.openShell()
when a non-process shell tab was clicked. URL stayed on agentic_process-<id> while the shell tab
content was shown — URL inconsistency. Fixed by adding navigation.openShell(sessionId) when
sessionId !== ptyPid in ProcessTerminal.
