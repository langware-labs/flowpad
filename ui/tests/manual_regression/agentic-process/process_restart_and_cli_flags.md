test 1: Standalone Restart button respawns the PTY
- navigate to {APP_URL}/dock/shell/new_terminal?startClaude=true
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

test 4: Controls are disabled before a session has been launched (hasSession=false)
- navigate to {APP_URL}/dock/shell/new_terminal (no startClaude)
- wait for a plain shell; do NOT click Start Claude
- validate the Restart button in the process toolbar is disabled (aria-disabled or pointer-events-none styling)
- open CLI Options; validate each of Chrome / Full Trust / Debug checkbox items is disabled
- validate the tooltip on the Restart button reads "Launch a session first"

KNOWN BUG (fixed 2026-04-24): AgenticProcess fast-path in ts_sdk/src/process/agentic-process.ts compared
this.status against ProcessStatus.LIVE (renamed to RUNNING). The enum member was undefined, so every
route-loader navigation re-issued POST /open + re-attached the PTY, adding ~500-1000ms per nav and
breaking the tab-switch fast-path this toolbar restart relies on. Fixed in commit b1999ef.
