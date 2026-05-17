---
id: 428de95d-0669-5645-a725-fe86867abf30
---

test 1: Creating a new Claude session produces no console errors
- navigate to /dock/shell/new_terminal and wait for shell tab
- open browser console capture
- open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait for URL to change to /dock/shell/agentic_process-<id>
- wait 3 seconds for the session to initialise
- verify no console errors occurred during the flow
- filter out known-acceptable noise (favicon, ResizeObserver)

KNOWN BUGS (fixed 2026-03-07, all found by this scenario type):
  1. bytes is not defined (shellManager.ts) — const bytes inside try {} block, referenced outside scope
  2. Maximum update depth exceeded (useScrollSync.ts) — inline [] dep caused infinite render loop
  3. Error parsing message: compute-node.ts WebSocket handler received string, treated as TypeId object
     causing guard check to always return early, tab never appeared
