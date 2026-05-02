test 1: Top-left Restart button respawns the PTY
- navigate to {APP_URL}/dock/shell/new_terminal then click the Start Claude button (data-testid="start-claude-button")
- wait for Claude CLI banner (up to 45s) and note pty_pid (via Session Info popover -> PTY ID row, or websocket trace)
- click the Restart icon (RotateCcw, data-testid="process-toolbar-restart") in the top-left of the process toolbar
- wait for the banner to re-render
- validate the pty_pid is different from the previous value (new PTY spawned)
- validate the xterm accepts keyboard input (e.g. type `echo hi` + Enter prints `hi`)
- validate no console errors during the restart

test 2: CLI Options dropdown — toggling a flag persists immediately and lights up the Restart glow
- same starting state as test 1 (banner visible)
- note current pty_pid; verify Restart button has data-restart-required="false" and is NOT glowing
- open the Slider icon dropdown (CLI Options) and toggle "Chrome browser" ON
- validate the dropdown checkbox stays checked after closing/reopening (the change persisted to the entity, no separate Apply step)
- validate the Restart button now has data-restart-required="true" and is visibly glowing (amber + animate-pulse + ring)
- pty_pid is UNCHANGED at this point — toggling does not auto-restart
- click the glowing Restart button
- wait for the PTY to respawn and banner to reappear
- validate the Restart button stops glowing (data-restart-required="false") within ~5s
- open the Info popover; validate the "Command" row includes `--chrome` and the Chrome row reads "enabled"
- (parameterize: repeat with "Full Trust" -> command contains `--dangerously-skip-permissions` and Permission row is `bypassPermissions`)
- (parameterize: repeat with "Debug logging" -> command contains `--debug` and Debug row is "enabled")

test 3: Glow reflects out-of-band changes (e.g. another surface mutates the entity)
- same starting state as test 1, Restart button NOT glowing
- in DevTools console, run:
    `const dm = window.dataManager; let p; for (const [id, ref] of dm.entities) if (id.type === 'agentic_process' && ref.entity?.status === 'running') { p = ref.entity; break; } p.cli_config = { ...(p.cli_config ?? {}), debug: true }; await p.save();`
- within ~1s the Restart button starts glowing
- toggle "Debug logging" OFF in the dropdown — validate the Restart button STILL glows (snapshot drifted from last_started_hash; only a real restart clears it)
- click Restart; validate the glow clears once the new banner appears

test 4: ProcessToolbar gating (started, hasTranscript)
- navigate to {APP_URL}/dock/shell/new_terminal and DO NOT click the Start Claude button
- validate the InteractiveTerminal renders WITHOUT a ProcessToolbar (data-testid="process-toolbar" is absent — plain shells have no AgenticProcess prop)
- click the Start Claude button (data-testid="start-claude-button")
- wait for the agentic_process tab and the Claude banner
- validate the ProcessToolbar is now visible and the Restart button is ENABLED
- validate the Fork button is DISABLED — tooltip "Send a message first — fork requires conversation history" (no assistant turn yet ⇒ hasTranscript=false)
- validate the Open Transcript button is DISABLED — tooltip "Send a message first — no transcript yet"
- open CLI Options; validate Chrome / Full Trust / Debug checkboxes are ENABLED (started=true unlocks the toggles)
- (manual setup): if the process can be put into status=STOPPED (e.g. terminate via Session Info), validate that the Restart button is now DISABLED with opacity-40 and tooltip "Session is not running" — even if restart_required is true, the not-running gate wins

KNOWN BUG (fixed 2026-04-24): AgenticProcess fast-path in ts_sdk/src/process/agentic-process.ts compared
this.status against ProcessStatus.LIVE (renamed to RUNNING). The enum member was undefined, so every
route-loader navigation re-issued POST /open + re-attached the PTY, adding ~500-1000ms per nav and
breaking the tab-switch fast-path this toolbar restart relies on. Fixed in commit b1999ef.

KNOWN BUG (fixed 2026-04-24): Restart / Fork / Open Transcript / CLI flag toggles were all gated on
`hasSession` (just `session_id` exists). A session forked from a stale source could have a session_id
but status=STOPPED, allowing Restart clicks that were no-ops; freshly-launched sessions had no
transcript yet but Open Transcript was clickable and 404'd. Fix: split into two predicates —
`started = process.status === RUNNING` (gates Restart, CLI toggles) and `hasTranscript` (gates
Fork, Open Transcript). See ProcessToolbar.tsx.

DESIGN CHANGE (2026-05-02): The legacy "RestartRequiredOverlay + pending checkboxes + Apply/Cancel"
flow was retired. CLI flag changes now persist directly to the entity on toggle; the backend's save
hook flips `process.restart_required` whenever the worker-relevant snapshot drifts from the captured
`last_started_hash`, and the top-left Restart button glows. Restart is the only path back to a
clean snapshot — there is no Cancel because there is no transient pending state on the client.
