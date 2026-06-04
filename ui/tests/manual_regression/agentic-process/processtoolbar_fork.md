---
id: b2a56d34-91ea-5380-9530-c6ded72bd167
---

test 1: Fork button is disabled before the first assistant turn
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for the plain shell tab
- validate NO ProcessToolbar is rendered on a plain shell (data-testid="process-toolbar" absent) — the toolbar (and therefore the Fork button) mounts only for an AgenticProcess in the Claude pane, so there is no Fork button to inspect on a plain shell
- open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude") and wait for the banner
- validate the Fork button (GitFork icon) in the process toolbar is disabled (no transcript yet; workerStatus is INITIALIZING or IDLE)
- hover; validate the tooltip reads "Send a message first — fork requires conversation history"

NOTE: the "Launch a session first" tooltip only renders if a ProcessToolbar exists with hasSession=false. In the current UI a plain shell has no toolbar at all, and a freshly-launched Claude process gets its session_id immediately, so that tooltip is effectively unreachable; the realistic pre-transcript gate is "Send a message first — fork requires conversation history".

test 2: Fork button becomes enabled after the first assistant turn and creates a sibling process
- continue from test 1 state (Claude session running, no messages yet)
- type a short prompt (e.g. "say hi in one word") + Enter
- wait until the assistant has produced a response (workerStatus transitions past IDLE / INITIALIZING)
- validate the Fork button is now enabled
- click the Fork button
- validate the button tooltip briefly reads "Forking…" while the request is in flight
- wait for the URL to change to a new /dock/shell/agentic_process-<id>
- validate a NEW tab was added (sibling process) and the old tab is still present
- in the new tab: the transcript lens shows the prior conversation history (fork copies history)
- validate no console errors during the fork
