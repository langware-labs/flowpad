test 1: Standalone Restart button respawns the PTY
- navigate to {APP_URL}/dock/shell/new_terminal then click the Start Claude button (data-testid="start-claude-button")
- wait for Claude CLI banner (up to 45s) and note pty_pid (via Session Info popover -> PTY ID row, or websocket trace)
- click the Restart icon (RotateCcw) in the process toolbar (data-testid="process-toolbar")
- wait for the banner to re-render
- validate the pty_pid is different from the previous value (new PTY spawned)
- validate the xterm accepts keyboard input (e.g. type `echo hi` + Enter prints `hi`)
- validate no console errors during the restart

test 2: CLI Options dropdown — toggling a flag shows RestartRequiredOverlay; Apply persists flag and restarts
- same starting state as test 1 (banner visible)
- open the Slider icon dropdown (CLI Options)
- toggle "Chrome browser" ON
- validate the RestartRequiredOverlay appears over the terminal content
- click Apply (the overlay's primary button)
- wait for the PTY to respawn and banner to reappear
- open the Info popover; validate the "Command" row includes `--chrome` and the Chrome row reads "enabled"
- (parameterize: repeat with "Full Trust" -> command contains `--dangerously-skip-permissions` and Permission row is `bypassPermissions`)
- (parameterize: repeat with "Debug logging" -> command contains `--debug` and Debug row is "enabled")

test 3: RestartRequiredOverlay — Cancel reverts pending changes without restart
- same starting state as test 1
- note current pty_pid
- open CLI Options; toggle "Debug logging"
- overlay appears
- click Cancel
- validate the overlay disappears AND reopening CLI Options shows the Debug toggle back to its original value
- validate pty_pid is unchanged (no restart happened)

test 4: ProcessToolbar gating (started, hasTranscript)
- navigate to {APP_URL}/dock/shell/new_terminal and DO NOT click the Start Claude button
- validate the InteractiveTerminal renders WITHOUT a ProcessToolbar (data-testid="process-toolbar" is absent — plain shells have no AgenticProcess prop)
- click the Start Claude button (data-testid="start-claude-button")
- wait for the agentic_process tab and the Claude banner
- validate the ProcessToolbar is now visible
- validate the Restart button is ENABLED (process.status === RUNNING ⇒ started=true)
- validate the Fork button is DISABLED — tooltip "Send a message first — fork requires conversation history" (no assistant turn yet ⇒ hasTranscript=false)
- validate the Open Transcript button is DISABLED — tooltip "Send a message first — no transcript yet"
- open CLI Options; validate Chrome / Full Trust / Debug checkboxes are ENABLED (started=true unlocks the toggles)
- (manual setup): if the process can be put into status=STOPPED (e.g. terminate via Session Info), validate that Restart is now DISABLED with tooltip "Session is not running"

KNOWN BUG (fixed 2026-04-24): AgenticProcess fast-path in ts_sdk/src/process/agentic-process.ts compared
this.status against ProcessStatus.LIVE (renamed to RUNNING). The enum member was undefined, so every
route-loader navigation re-issued POST /open + re-attached the PTY, adding ~500-1000ms per nav and
breaking the tab-switch fast-path this toolbar restart relies on. Fixed in commit b1999ef.

KNOWN BUG (fixed 2026-04-24): Restart / Fork / Open Transcript / CLI flag toggles were all gated on
`hasSession` (just `session_id` exists). A session forked from a stale source could have a session_id
but status=STOPPED, allowing Restart clicks that were no-ops; freshly-launched sessions had no
transcript yet but Open Transcript was clickable and 404'd. Fix: split into two predicates —
`started = process.status === RUNNING` (gates Restart, CLI toggles, Apply) and `hasTranscript` (gates
Fork, Open Transcript). See ProcessToolbar.tsx.
