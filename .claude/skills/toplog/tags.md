---
id: 6df89291-5bef-4cd0-8f4e-b34298f6bb33
---
# Tag catalog

The living registry of toplog tags. Each tag names a trace stream that
`toplog.log([...], …)` calls in the code emit under. `run` reads this to pick the
right tags for an issue; `scan` diffs it against the code; `learn` maintains it.

Tags earn their place through `learn`, after a trace proves useful in an RCA (or,
like `pty`, when past RCAs name the points that would have shown the cause). Keep
the registry a record of *what actually helps*, not speculation.

## Registry

The registry is every `### <tag>` heading below. Add entries in this format:

```
### <tag>
- **Traces:** <what events / state transitions this stream logs>
- **Where:** <subsystem + a few representative file paths that emit it>
- **Use for:** <the symptom classes this tag illuminates>
- **Verified:** <date, traffic type, line count in a whole-session trace; confirm tag-off produces zero new lines>
```

<!-- New tags go here, one `### <tag>` heading each. Keep alphabetical so the
     registry stays scannable and catalog diffs stay stable across edits. -->

### agentic_process.load
- **Traces:** the whole "start a session → terminal attached" path, front and back, one line per step with its duration. Backend lines log as `toplog: [agentic_process.load] …`, frontend lines as `toplog.client: […agentic_process.load] …`, in the same instance log.
  - **Frontend (click side):**
    - `openNewChat click` (worker, mode, pty, `visibility`), `openNewChat createProcess took`, `openNewChat openShellProcess took`
    - `InteractiveTerminal fit timer fired after Nms (scheduled 50ms)` and `fit + ptySync.initialize took`: a timer firing far past 50ms is a busy or throttled page, not slow terminal work
    - `startProcessRuntime waitForConnected took|timed out`
    - `AgenticProcess.start POST /open sent`, `… /open took`, `… attachPty took`
    - Plus every `process_load` line (loader `perfLog`/`perfTime` steps, `materializeTab cache-miss`, `TabbedTerminal active flip`, pty-stream fetch / replay / backlog, WS request TIMEOUT), which is co-tagged.
  - **Backend:**
    - `createProcess start` (worker, visible, pty_mode, project), `preflight done` (is_installed + llm_picker_view), `saved`, `done`, `failed`, each with `ms` since the handler started
    - `open request received` (the HTTP `/open` arriving), `open lock acquired wait_ms` (the per-process `_OPEN_LOCKS`)
    - `_perform_open` steps with `ms` since it started: `reattached live worker`, `launch options ready`, `shell bound + STARTING saved`, `PTY spawned`, `done`, `failed`
    - `worker status discovery slow ms= process= driver= status=` (≥ 25ms): the synchronous transcript search `fetch_worker_status` runs on the event loop, once for EVERY process a response serializes (the list, project history, a single GET). A burst of these lines from one request is a multi-second loop stall; `driver=codex` is the `~/.codex/sessions` rglob, `driver=claude` the `~/.claude/projects` directory walk.
- **Where:**
  - Frontend: `ui/src/navigation/open-new-chat.ts`, `ui/src/components/terminal/TabbedTerminal.tsx`, `ts_sdk/src/process/agentic-process.ts`, `ts_sdk/src/utils/perf.ts` (co-tags the `process_load` chokepoint), `ts_sdk/src/websocket.ts`, `ui/src/tabs/tab-content-lifecycle.ts`, `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`.
  - Backend: `flow_sdk/builtin/faas/scan_actions.py` (`_scan_create_process`), `flow_sdk/builtin/agentic_process/agentic_process.py` (`_http_open`, `start_pty`, `_perform_open`).
- **Use for** (symptom → lines to read):
  - **"New session takes forever":** read by timestamp. A slow `createProcess` step on the backend (`preflight`, `saved`, `PTY spawned`) is backend work. `openNewChat createProcess took` much bigger than backend `createProcess done ms` is time the request spent in the browser or network, before or after the handler.
  - **The gap between create and attach:** `openShellProcess took` and the loader lines show the navigation. The frontend `/open sent` timestamp next to the backend `open request received` timestamp splits the gap into "client didn't send yet" and "request didn't arrive yet".
  - **Contention on the open:** a large `open lock acquired wait_ms` means another open (a second tab, the recovery watchdog) holds the process lock.
  - **Every request slow at once (loop stall):** look for a burst of `worker status discovery slow` lines just before the stalled steps. On prod data (235 processes) one `GET /agentic_process` wrote 17 lines (1.9s) and blocked the loop 2.8–3.7s.
  - **Write-lock contention:** `db writer lock waited ms` (> 200ms waiting for `BEGIN IMMEDIATE`) and `db writer lock held ms` (> 500ms holding it) name the request (`METHOD /path`) or asyncio task. A slow `createProcess row saved` next to a long `held` line from another writer attributes the stall.
  - **Not covered:** a main-thread stall or requests queued in the browser appear only as unexplained time between two frontend lines. There is no log point for them.
- **Where (lock lines):** `flow_sdk/db/drivers/sqlite/connection.py` (`_on_begin`, `_on_release`). They fire for any writer, not just the session start.
- **Lock holder label:** `by=` is `METHOD /path` inside a request, else `<task name>:<coroutine qualname>` (e.g. `ap-flush-…:AgenticProcess._flush_transcript_change`), so an unnamed `Task-123` still names its writer.
- **Read it as one timeline:** `python .claude/skills/toplog/scripts/load_timeline.py <instance log> [nth click]` orders front and back lines on one clock (frontend lines by `client_ts`, since they reach the log in 1s batches) as `+ms` from the click.
- **Measure in a visible page.** A hidden tab throttles timers to about 1s, which inflates every frontend gap. The click line's `visibility=hidden` flags such a trace. Drive a headless browser (Playwright), not a background Chrome tab.
- **Needs this checkout's code on the instance.** An installed release (e.g. `prod`) has none of these points and no `/toplog/client-log` route (405), so frontend lines stay in the browser console only.
- **Verified 2026-09-16** on a temp instance (terminal mode, "New Claude chat" clicks): about 45 lines per click, front and back, from click to replay done. Tag off with another create: 0 new lines.

### claude_debug_session_log
- **Traces:** nothing on its own — this tag is a *behavior switch*, not a trace stream. It selects the granularity of the Claude CLI's own `--debug-file`: OFF (default) writes one file per TURN (`<session>-<utc-stamp>.txt`), ON writes one file per SESSION (`<session>.txt`), the shape the CLI itself uses. Files land in `<instance>/logs/claude-cli-debug/` and are pruned after 7 days.
- **Where:** `flow_sdk/builtin/agentic_process/cli_drivers/claude/stream_worker.py` (`SESSION_DEBUG_LOG_TAG`, `_turn_debug_file` — read once per turn, so a flip applies to the next turn with no restart). The pre-turn credential renewal in `.../claude/credential.py` shares the same helper, so ON collapses every renewal onto one `credential-renewal.txt`.
- **Use for:** reading a session's CLI debug stream as one continuous file instead of stitching a directory together. Leave it OFF while chasing auth / token-refresh stalls: per-turn naming exists precisely so the recovery turn ~30s later can't clobber the failing turn's evidence.

### navigation
- **Traces:** every frontend navigation transition — `openDock` entry/dedup-no-op/target, the `window.history.pushState` + synthetic `popstate` pair in `commitBrowserNavigation`, `navigateToBaseUrl`, `goBack`/`goForward` (`navigate(±1)`), the mouse X1/X2 → `history.back/forward` bridge, the global `popstate` listener, the zustand history store (`pushHistory`/`goBack`/`goForward` with `currentIndex`), and `currentDock` changes. Each line carries the current browser URL, the target URL, and (where relevant) the dock pointer and history index.
- **Where:** frontend navigation core — `ui/src/navigation/NavigationActions.ts`, `ui/src/navigation/useDockNavigation.ts`, `ui/src/hooks/use-navigation-state.ts`, `ui/src/main.tsx` (mouse-button bridge + global popstate listener). The Electron main process emits the parallel `[nav]` stream via `electron-log` in `electron/main.js` (back/forward gesture sources + `did-navigate`/`did-navigate-in-page`/`will-navigate`).
- **Use for:** double-navigation / "back jumps twice" bugs, back/forward landing on the wrong view, dock open/close not reflecting in the URL, history desync between the browser history stack and the zustand `navigation-history` store.

### pty
- **Traces:** one line per PTY lifecycle event on both sides, never per chunk or keystroke. Backend lines log as `toplog: [pty] …`, frontend lines as `toplog.client: [pty] …`, both in `~/.flow/instances/<name>/logs/*.log`.
  - **Backend:**
    - `spawn` (pid, `backend_pid`, argv0, size, `spawn_ms`) and `reader_exit` (exit_code)
    - `session_start` (`persisted_max_seq`, `start_seq`) and `cap_evict`
    - `attach` (`latest_seq`, `repaint_ms`, `backend_pid`) and `attach_not_found`
    - `resize`, `input_dropped` (session_not_found / write_failed)
    - `output_delayed` (reader thread → loop lag > 200ms, ≤1/s per session)
    - `ws_slow_message` (a WS message > 100ms blocks that connection's lane; ≤1/s, `slow_in_window`)
    - `stream_read` (GET pty-stream: bytes, events, ms), `stream_truncate` (10MB rewrite holding the lock)
    - `turn_end_transcript_parse` (whole-transcript parse on the loop at turn end), `recovery` (after restart)
  - **Frontend:**
    - `attach` (ok, force, ms), `reset` (chunks, last_seq)
    - `dedup_drop` (first of a run), `input_dropped` (not_live / session_not_found / shell_not_connected, first of a run)
    - `resize` / `resize_failed`, `xterm_mount` / `xterm_dispose`
    - `on_connected start|superseded|replay_failed|done` with `source=mount|status|recovered|reconnected`
    - `vt_rebuild_slow` (> 50ms)
    - Plus the `process_load` lines also tagged `pty`: pty-stream fetch, replay, backlog loop, TabbedTerminal warm/cold flip, WS request TIMEOUT, attachPty.
- **Where:**
  - Backend: `compute/providers/desktop/provider.py`, `compute/providers/desktop/pty_stream_file.py`, `builtin/faas/pty_actions.py`, `server/routes/websocket.py`, `server/routes/pty_stream.py`, `server/pty_recovery.py`, `builtin/agentic_process/agentic_process.py`.
  - Frontend: `ts_sdk/src/services/shell/ptyConnection.ts`, `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` (+ the `process_load` sites).
- **Use for** (symptom → lines to read):
  - **Laggy typing / slow output:** `ws_slow_message`, `output_delayed`, `turn_end_transcript_parse` / `stream_read` / `stream_truncate` with big `ms` (event-loop stalls; a mouse-wheel flood shows as a high `slow_in_window`).
  - **Blank or frozen pane:** `attach_not_found`, `attach ok=false`, a missing `recovery` after a restart, `input_dropped`, WS request TIMEOUT, `output_delayed`.
  - **Terminal "dead after restart":** `session_start persisted_max_seq` vs `start_seq`, then frontend `dedup_drop` with `seq` far below `last_seq` (lost epoch).
  - **Slow tab switch / reload:** `on_connected` (count `start` lines per `source`; repeated starts = duplicate stream fetches), replay `took Nms serializedKB`, `xterm_mount`/`xterm_dispose` pairs (a "warm" terminal remounted).
  - **Garbled after resize:** `resize` sizes/sources, `vt_rebuild_slow`.
  - **Split-brain (two backends on one port):** `spawn backend_pid` ≠ `attach backend_pid`.
  - **Not covered:** GPU compositing / render bleed (not observable from logs).
- **Verified 2026-09-16** on a temp instance: 3 API sessions, a browser terminal, `seq 1 200000`, resize and reload → 51 lines total; tag off → 0 new lines.

### process_load
- **Traces:** the whole Claude-process load pipeline, cold and warm — `initSdk` (cold bootstrap vs memoised warm), every `/dock/shell` loader step (`perfLog`/`perfTime` in the loaders emit under this tag: loadAgentApp → loadShellRoute → waitForConnected → loadProcess phases → dataContext writes), tab materialization (`Tab.listAll` duration + cache-miss `new_tab` round trips), the SDK runtime attach (`AgenticProcess.start` POST `/open` and `attachPty` durations), WS request timeouts (method/action/target + elapsed + pending-queue depth), terminal mount (`TabbedTerminal` active flip, warm vs cold-mount), and attach-time history replay (`pty-stream` fetch, headless replay + serialized size, backlog `processChunk` loop with chunk counts).
- **Where:** `ui/src/routes/loaders/_perf.ts` (chokepoint — every loader `perfLog`/`perfTime` label across `main-loader.ts`, `load-shell.ts`, `load-process.ts` emits here), plus direct `toplog.log` lines in `ui/src/tabs/tab-lifecycle.ts`, `ui/src/components/terminal/TabbedTerminal.tsx`, `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`, `ts_sdk/src/process/agentic-process.ts`, `ts_sdk/src/websocket.ts`.
- **Use for:** slow or hung tab switches to Claude/shell tabs (warm switch not instant, cold switch over budget), blank terminal panes after a WS "Request timeout for message_id", attributing which pipeline stage (loader await, backend `/open`, PTY attach, replay, backlog processing) ate the time, and distinguishing frontend main-thread stalls from backend round-trip latency.

## Reconciliation rules (for `scan` and `learn`)

- **Source of truth is the pairing of code and catalog.** A tag is healthy when
  it is both referenced by at least one `toplog.log(...)` call *and* has a `###`
  entry here. `scripts/scan_tags.py` reports the two ways that breaks.
- **Undocumented** (in code, not catalogued): a `toplog.log` call uses a tag
  with no entry. Either add the entry (if the trace is worth keeping) or fold the
  call into an existing tag — decide in `learn`, never silently.
- **Stale** (catalogued, not in code): an entry whose trace lines are all gone.
  Confirm the code is really gone (not just renamed) before retiring the entry;
  retire entry and any leftover lines together so the pair stays consistent.
- **Enrich in place.** When a tag proves useful in a new area, extend its
  existing entry (more **Where**, sharper **Use for**) rather than appending a
  second entry for the same tag — one heading per tag keeps `scan` accurate.
