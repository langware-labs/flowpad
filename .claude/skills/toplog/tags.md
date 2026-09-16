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
