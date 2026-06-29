---
id: 4ad84cbc-f597-5149-9124-caf0112f51a6
---

- PRECONDITION: switch the app to Advanced view (footer view pill or `window.setView('advanced')` / localStorage `viewMode=advanced`) — the process toolbar (Restart / Open Terminal / Fork / Worktree / Session Info / Transcript) and side-ribbon panels only exist in Advanced view; the default Standard view shows the simple-chat header without them
test 1: PTY Viewer opens from the Columns & Trace dropdown (always available, no dev-mode gate)
- navigate to {APP_URL}/dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait for the Claude banner
- open the Columns & Trace dropdown (BugPlay icon) in the process toolbar
- validate the dropdown contains an item "PTY Viewer" at the bottom of the menu (below the separator)
- click "PTY Viewer"
- validate a modal mounts showing the raw PTY stream for the current shell (non-empty content, matches the banner text)
- close the modal (Esc or close button)
- validate the modal unmounts and the terminal view is unaffected
- this invariant holds regardless of dev-mode: PTY Viewer must be accessible to end users

test 2: Open Transcript button navigates to the claude transcript lens for the current session
- same starting state as test 1 (Claude banner visible, hasSession true)
- click the ScrollText icon in the process toolbar (tooltip "Open transcript")
- validate the URL navigates to /dock/lens/claude/transcript/<project_encoded_name>/<session_id>
- validate the transcript viewer (ClaudeTranscriptViewer) renders; for a freshly-launched session with no turns, the empty-state is acceptable
- navigate back (browser back) and validate the process tab is restored

test 3: Open Transcript is hidden until a session exists
- navigate to {APP_URL}/dock/shell/new_terminal and DO NOT click the Start Claude button
- wait for the plain shell
- validate the ScrollText (Open Transcript) icon is NOT rendered in the process toolbar (gated on hasSession)
- click Start Claude; wait for banner
- validate the ScrollText icon is now rendered
