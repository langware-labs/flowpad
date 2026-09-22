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
    - `worker status discovery slow ms= process= driver= status=` (≥ 25ms): the synchronous transcript search `fetch_worker_status` runs on the event loop, once for EVERY process a response serializes (the list, project history, a single GET). A burst of these lines from one request is a multi-second loop stall; `driver=codex` is the `~/.codex/sessions` rglob, `driver=claude` the `~/.claude/projects` directory walk. Since `flow_sdk/builtin/agentic_process/transcript_cache.py` remembers the location, a line means a cache MISS: expect one per process on the first serialization after startup or after its session, workdir, launch time or status changes, and none on repeat fetches. Lines on every fetch for the same process = a live process whose transcript can still move (Copilot, OpenCode, a Codex tee), or a cache regression.
- **Where:**
  - Frontend: `ui/src/navigation/open-new-chat.ts`, `ui/src/components/terminal/TabbedTerminal.tsx`, `ts_sdk/src/process/agentic-process.ts`, `ts_sdk/src/utils/perf.ts` (co-tags the `process_load` chokepoint), `ts_sdk/src/websocket.ts`, `ui/src/tabs/tab-content-lifecycle.ts`, `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`.
  - Backend: `flow_sdk/builtin/faas/scan_actions.py` (`_scan_create_process`), `flow_sdk/builtin/agentic_process/agentic_process.py` (`_http_open`, `start_pty`, `_perform_open`).
- **Use for** (symptom → lines to read):
  - **"New session takes forever":** read by timestamp. A slow `createProcess` step on the backend (`preflight`, `saved`, `PTY spawned`) is backend work. `openNewChat createProcess took` much bigger than backend `createProcess done ms` is time the request spent in the browser or network, before or after the handler.
  - **The gap between create and attach:** `openShellProcess took` and the loader lines show the navigation. The frontend `/open sent` timestamp next to the backend `open request received` timestamp splits the gap into "client didn't send yet" and "request didn't arrive yet".
  - **Contention on the open:** a large `open lock acquired wait_ms` means another open (a second tab, the recovery watchdog) holds the process lock.
  - **Every request slow at once (loop stall):** look for a burst of `worker status discovery slow` lines just before the stalled steps. On prod data (235 processes), before the transcript cache, one `GET /agentic_process` wrote 17 lines (1.9s) and blocked the loop 2.8–3.7s; with it, a warm fetch writes 0 lines.
  - **Write-lock contention:** `db writer lock waited ms` (> 200ms waiting for `BEGIN IMMEDIATE`) and `db writer lock held ms` (> 500ms holding it) name the request (`METHOD /path`) or asyncio task. A slow `createProcess row saved` next to a long `held` line from another writer attributes the stall.
  - **Not covered:** a main-thread stall or requests queued in the browser appear only as unexplained time between two frontend lines. There is no log point for them.
- **Where (lock lines):** `flow_sdk/db/drivers/sqlite/connection.py` (`_on_begin`, `_on_release`). They fire for any writer, not just the session start.
- **Lock holder label:** `by=` is `METHOD /path` inside a request, else `<task name>:<coroutine qualname>` (e.g. `ap-flush-…:AgenticProcess._flush_transcript_change`), so an unnamed `Task-123` still names its writer.
- **Read it as one timeline:** `python .claude/skills/toplog/scripts/load_timeline.py <instance log> [nth click]` orders front and back lines on one clock (frontend lines by `client_ts`, since they reach the log in 1s batches) as `+ms` from the click.
- **Measure in a visible page.** A hidden tab throttles timers to about 1s, which inflates every frontend gap. The click line's `visibility=hidden` flags such a trace. Drive a headless browser (Playwright), not a background Chrome tab.
- **Needs this checkout's code on the instance.** An installed release (e.g. `prod`) has none of these points and no `/toplog/client-log` route (405), so frontend lines stay in the browser console only.
- **Verified 2026-09-16** on a temp instance (terminal mode, "New Claude chat" clicks): about 45 lines per click, front and back, from click to replay done. Tag off with another create: 0 new lines.

### chat_delivery
- **Traces:** how one assistant message reaches a chat pane, and what the stream does with each copy. Every turn writes ~5 lines (events only, no payloads), all frontend (`toplog.client: [chat_delivery] …`):
  - `prompt_stream_open process=` / `observe_turn_open process= after_entry=` — WHICH path is feeding this pane. `prompt` = the pane started the turn; `observe_turn` = it is watching one it did not start (a queue-drained prompt, a message enqueued by a page, a reconnect). `after_entry` is the watermark it claims to hold; `none` means "watermark at open".
  - `from_prompt_stream` / `from_observe_turn` / `from_websocket` — one line per chat frame, with its `group` and originating `t`, at the seam it entered.
  - `ingest src= group= t= i= role= len= known_groups=` — what `FlowDataStream.ingest` received. `len=0` is the streaming placeholder (content is appended later), a non-zero `len` is a whole message. Two lines with the same `t` and different `src` = the same answer delivered twice.
  - `replay_dropped t= src=` — the guard below refusing a copy the pane already holds.
- **Where:** `ts_sdk/src/flow_processing/flow-data-stream.ts` (`ingest`, the held-twin guard), `ts_sdk/src/process/agentic-process.ts` (`prompt`, `observeTurn` wiring), `ts_sdk/src/FlowSync/store.ts` (`DataManager.onFlowData`).
- **Use for** (symptom → lines to read):
  - **"The agent's answer appears twice, a reload fixes it":** find two `ingest` lines sharing `t` with different `src`. Whether they duplicate depends on the group state: a copy arriving while the first group is still open consolidates into it; one arriving after it closed starts a new group and renders twice. `raw_decide`-style state is visible as `known_groups` plus the `from_*` line that preceded it.
  - **Which side is late:** compare the `client_ts` of `from_websocket` and `from_observe_turn` for the same `t`. Sub-second apart = live turn; tens of seconds apart = a replay of something already held.
  - **A pane replaying too much:** an `observe_turn_open` whose `after_entry` is older than the last entry the pane holds re-delivers finished messages. `after_entry=none` on a pane with history is the same bug in its strongest form.
  - **Duplicated lines across a run:** each open tab on the same process writes its own set. Two identical `observe_turn_open` lines milliseconds apart = two panes, not one pane opening twice.
  - **Not covered:** the backend side of the broadcast (who emitted the frame, and why the transcript holds it twice) has no log point — these are all client-side seams.
- **Proven with it (2026-09-18):** the duplicate assistant message in the vibe chat. `prompt_stream_open` never fired (0 vs 4 `observe_turn_open`), killing the "the pane that started the turn also gets the broadcast" theory; the decisive state (seen through a throwaway probe, not a shipped line) was `new_group=true open_dup=false closed_twin=true` — the pane already held that message, finished, while `_findDuplicateOpenGroup` only matches a twin whose group is still OPEN. Fix: `_heldTwin` drops a chat whose role and `t` match a `ready` item already in the stream — from BOTH ingest modes, since the replayed copy carries a group-id of its own. Toggled both directions in the live app via a replay with a stale `after_entry_id`: guard on 12→12 chats, guard off 12→13 with the answer repeated.
- **Verified 2026-09-18** on the `oss` instance with two real Explain turns: 20 lines for two turns across two open panes, zero new lines with the tag off.

### claude_debug_session_log
- **Traces:** nothing on its own — this tag is a *behavior switch*, not a trace stream. It selects the granularity of the Claude CLI's own `--debug-file`: OFF (default) writes one file per TURN (`<session>-<utc-stamp>.txt`), ON writes one file per SESSION (`<session>.txt`), the shape the CLI itself uses. Files land in `<instance>/logs/claude-cli-debug/` and are pruned after 7 days.
- **Where:** `flow_sdk/builtin/agentic_process/cli_drivers/claude/stream_worker.py` (`SESSION_DEBUG_LOG_TAG`, `_turn_debug_file` — read once per turn, so a flip applies to the next turn with no restart). The pre-turn credential renewal in `.../claude/credential.py` shares the same helper, so ON collapses every renewal onto one `credential-renewal.txt`.
- **Use for:** reading a session's CLI debug stream as one continuous file instead of stitching a directory together. Leave it OFF while chasing auth / token-refresh stalls: per-turn naming exists precisely so the recovery turn ~30s later can't clobber the failing turn's evidence.

### http
- **Traces:** one line per HTTP request the backend serves: `request method=… path=… status=… ttfb_ms=… ms=… bytes=…`. `ttfb_ms` is the time until the response headers went out (the handler's own work); `ms` also covers writing the body, so `ms` ≫ `ttfb_ms` means transfer, not compute. WebSocket traffic is not HTTP — the WS lane is covered by `pty` `ws_slow_message`.
- **Where:** `flow_sdk/server/middleware/http_timing_middleware.py` (`HttpTimingMiddleware`), registered OUTERMOST in `flow_server.py`, so it also times requests an inner layer answers itself (cookie-gate rejections, CORS preflights). Off, it costs one `toplog.is_on` check.
- **Use for:** timing everything a page load or a tab switch fetches, finding which request held the event loop during a stall (correlate with `pty` `output_delayed` at the same timestamp), and response bloat (`bytes` — e.g. `get-history` shipping an 82MB transcript). Pair with `process_load` lines (`loadShellRoute(…) start`) to bucket requests by the switch that caused them.
- **Verified 2026-09-22** by `tests/unit/test_toplog_http_request_timing.py` (one line per request with the real status and body size; none when off).

### navigation
- **Traces:** every frontend navigation transition — `openDock` entry/dedup-no-op/target, the `window.history.pushState` + synthetic `popstate` pair in `commitBrowserNavigation`, `navigateToBaseUrl`, `goBack`/`goForward` (`navigate(±1)`), the mouse X1/X2 → `history.back/forward` bridge, the global `popstate` listener, the zustand history store (`pushHistory`/`goBack`/`goForward` with `currentIndex`), and `currentDock` changes. Each line carries the current browser URL, the target URL, and (where relevant) the dock pointer and history index.
- **Where:** frontend navigation core — `ui/src/navigation/NavigationActions.ts`, `ui/src/navigation/useDockNavigation.ts`, `ui/src/hooks/use-navigation-state.ts`, `ui/src/main.tsx` (mouse-button bridge + global popstate listener). The Electron main process emits the parallel `[nav]` stream via `electron-log` in `electron/main.js` (back/forward gesture sources + `did-navigate`/`did-navigate-in-page`/`will-navigate`).
- **Use for:** (per-switch timing and errors are `tab_switch`) double-navigation / "back jumps twice" bugs, back/forward landing on the wrong view, dock open/close not reflecting in the URL, history desync between the browser history stack and the zustand `navigation-history` store.

### pty
- **Traces:** one line per PTY lifecycle event on both sides, never per chunk or keystroke. Backend lines log as `toplog: [pty] …`, frontend lines as `toplog.client: [pty] …`, both in `~/.flow/instances/<name>/logs/*.log`.
  - **Backend:**
    - `spawn` (pid, `backend_pid`, argv0, size, `spawn_ms`) and `reader_exit` (exit_code)
    - `session_start` (`persisted_max_seq`, `start_seq`) and `cap_evict`
    - `attach` (`latest_seq`, `repaint_ms`, `backend_pid`) and `attach_not_found`
    - `resize`, `input_dropped` (session_not_found / write_failed)
    - `output_delayed` (reader thread → loop lag > 200ms, ≤1/s per session)
    - `ws_slow_message` (a WS message > 100ms blocks that connection's lane; ≤1/s, `slow_in_window`, with `action`/`sub_path`/`shell` so a stalled lane names its terminal — never the body, which carries keystrokes)
    - `stream_read` (GET pty-stream: bytes, events, ms), `stream_truncate` (10MB rewrite holding the lock)
    - `turn_end_transcript_parse` (whole-transcript parse on the loop at turn end: `bytes`, `entries`, `watermark`, and `parse_ms`/`scan_ms` split out of `ms` — the parse and the file-op scan have opposite fixes) and `turn_end_reindex` (the batch that parse schedules: `paths`, `counts`, `ms`), `recovery` (after restart)
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
  - **Laggy typing / slow output:** `ws_slow_message`, `output_delayed`, `turn_end_transcript_parse` / `turn_end_reindex` / `stream_read` / `stream_truncate` with big `ms` (event-loop stalls; a mouse-wheel flood shows as a high `slow_in_window`).
  - **Terminals stalling with no obvious trigger:** `output_delayed` says the loop blocked, never what blocked it — pair each one with the nearest preceding line that owns a `ms`. A spike whose `ms` matches the lag 1:1 is the cause; a rolling ~300ms floor BETWEEN turn ends is `turn_end_reindex` draining its batch (one uninterrupted run of awaits, so it stalls every live terminal while it runs). All live shells delayed at the same instant = one loop block, not one per shell. `watermark=0` on every `turn_end_transcript_parse` is the known transient-watermark defect (`agentic_process.py`): the whole history is rescanned each turn, so the stall grows with the transcript all session.
  - **Blank or frozen pane:** `attach_not_found`, `attach ok=false`, a missing `recovery` after a restart, `input_dropped`, WS request TIMEOUT, `output_delayed`.
  - **Terminal "dead after restart":** `session_start persisted_max_seq` vs `start_seq`, then frontend `dedup_drop` with `seq` far below `last_seq` (lost epoch).
  - **Slow tab switch / reload:** `on_connected` (count `start` lines per `source`; repeated starts = duplicate stream fetches), replay `took Nms serializedKB`, `xterm_mount`/`xterm_dispose` pairs (a "warm" terminal remounted).
  - **Garbled after resize:** `resize` sizes/sources, `vt_rebuild_slow`.
  - **Split-brain (two backends on one port):** `spawn backend_pid` ≠ `attach backend_pid`.
  - **Not covered:** GPU compositing / render bleed (not observable from logs).
- **Verified 2026-09-16** on a temp instance: 3 API sessions, a browser terminal, `seq 1 200000`, resize and reload → 51 lines total; tag off → 0 new lines.
- **Verified 2026-09-20** (`turn_end_transcript_parse` fields + `turn_end_reindex`) on instance `tlog-4`: 3 headless file-writing turns → 11 lines total, two-way toggle (on → lines, off → 0 new while a real turn ran and wrote files, on again → lines). The new line earned itself immediately: `turn_end_reindex paths=3 … ms=1535` on a 3-path batch is ~500ms/path, which is what the unattributed ~300ms prod floor is made of, and the repeat batches per turn end are `watermark=0` re-collecting the same set.

### process_load
- **Traces:** the whole Claude-process load pipeline, cold and warm — `initSdk` (cold bootstrap vs memoised warm), every `/dock/shell` loader step (`perfLog`/`perfTime` in the loaders emit under this tag: loadAgentApp → loadShellRoute → waitForConnected → loadProcess phases → dataContext writes), tab materialization (`Tab.listAll` duration + cache-miss `new_tab` round trips), the SDK runtime attach (`AgenticProcess.start` POST `/open` and `attachPty` durations), WS request timeouts (method/action/target + elapsed + pending-queue depth), terminal mount (`TabbedTerminal` active flip, warm vs cold-mount), and attach-time history replay (`pty-stream` fetch, headless replay + serialized size, backlog `processChunk` loop with chunk counts).
- **Where:** `ui/src/routes/loaders/_perf.ts` (chokepoint — every loader `perfLog`/`perfTime` label across `main-loader.ts`, `load-shell.ts`, `load-process.ts` emits here), plus direct `toplog.log` lines in `ui/src/tabs/tab-lifecycle.ts`, `ui/src/components/terminal/TabbedTerminal.tsx`, `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`, `ts_sdk/src/process/agentic-process.ts`, `ts_sdk/src/websocket.ts`.
- **Use for:** (start from `tab_switch` for the switch as a whole — its `--switch n` window interleaves these lines) slow or hung tab switches to Claude/shell tabs (warm switch not instant, cold switch over budget), blank terminal panes after a WS "Request timeout for message_id", attributing which pipeline stage (loader await, backend `/open`, PTY attach, replay, backlog processing) ate the time, and distinguishing frontend main-thread stalls from backend round-trip latency.

### tab_switch
- **Traces:** the spine of every tab switch, for EVERY tab kind — 4–7 frontend lines per switch (`toplog.client: [tab_switch] …`), each stamped `sw=<n> +<ms>ms` (ms since that switch started, on the page clock):
  - `start sw= via=openDock|view_mode|replace|commit|detached|popstate from=<kind:ptr> to=<kind:ptr> visibility=` — a navigation that will actually move the app. `commit` is a URL write that is not a click (`setOption`, a journey closing, the dock closing); `detached` is `flow navigate` / a backend command. `popstate` is every real history step (the nav bar's Back/Forward, the browser, the Electron gesture); it doesn't know the target yet (`to=-`) — the `committed` line names it, with `action=POP`.
  - `noop sw=<previous> reason=same_dock|url_current|url_pending to=` — a click that moved nothing (the "tab didn't switch" report).
  - `loader sw= kind= ms= path=` / `loader_redirect … status= to=` / `loader_error … err=` — the dock loader's outcome and its OWN duration (`ms`), next to the switch's `+ms`. A `loader` line with no `start` before it is a revalidation (a search-param write), not a switch.
  - `committed sw= action=PUSH|POP|REPLACE path= error=yes|no` — the router settled (loading → idle); the new URL is what renders.
  - `painted sw= kind= path=` — first frame of the new URL, in the dock and the `/win` focus window alike. Every kind has it; for sync views (project, assets, preferences, graph, hub…) it IS the end of the switch.
  - `ready sw= kind=terminal|chat|conversation|vibe mode=warm|cold …` — async content actually usable, once per switch: terminal warm = activation refresh of an already-replayed xterm, cold = `on_connected done` (`attach_ms`, `history_kb`); chat = process history in the pane (`history_ms`) or a warm flip back to a mounted pane; conversation = message window arrived (`messages=`); vibe = workspace chat history loaded. `terminal_flip mode=warm|cold` and `terminal_runtime_ready` (the "Starting session…" gate lifting) sit between.
  - `error sw= sink=… err=` at every error sink: `dock_load_error` (with `action=` render_error/redirect/notify/banner/noop), `tab_open_failed` / `tab_close_failed` ("Tab failed to open"; single and batch close too), `error_screen` (the route errorElement replaced the page), `router_on_error`, `terminal_runtime` (start/attach failed → banner), `process_runtime_soft` (loader kept the URL, banner), `process_missing` / `shell_missing` (→ redirected to a fallback), `no_realtime` (WS not connected in 5s), `pty_replay`, `conversation_messages`, and `process_history` (the transcript failed to load and the pane shows as an empty session — `loadHistory` resolves anyway, so a chat/vibe `ready` is only written when history actually loaded).
  - `uncaught sw= kind=error|rejection err=` — window `error` / `unhandledrejection`, attributed to the switch in flight. Chrome's `ResizeObserver loop …` notification (no Error attached, fired by xterm's fit on resizes) is skipped — it is not a failure and would flood the trail.
- **Where:** state in `ui/src/navigation/tab-switch-state.ts` (`tabSwitch`, `beginTabSwitch`, `sinceTabSwitch`, `claimTabSwitchReady`, `dockLabel` — state and formatting only, no logging). Lines: `ui/src/navigation/NavigationActions.ts` (`logTabSwitchStart`, openDock no-ops, commitDetached), `ui/src/main.tsx` (popstate, uncaught, router onError), `ui/src/router.tsx` (committed), `ui/src/routes/loaders/main-loader.ts` (loader outcome), `load-shell.ts`, `dock-load-error.ts`, `ui/src/tabs/tab-content-lifecycle.ts`, `ui/src/router.tsx` `RootLayout` (painted), `ui/src/pages/flow-page/vibe-chat-pane.tsx`, `ui/src/components/terminal/TabbedTerminal.tsx`, `interactive-terminal/InteractiveTerminal.tsx`, `SimpleChatPane.tsx`, `ui/src/components/conversation/ConversationView.tsx`, `error-screen.tsx`, `ui/src/hooks/use-history-load-alert.ts` (`process_history`). Errors ride as toplog's last argument (`… err:`, error) so `formatArg` prints `Name: message`.
- **Read it:** `python .claude/skills/toplog/scripts/load_timeline.py <instance log> --switch all` → one row per switch (via, target, loader / committed / painted / ready ms, ready kind/mode, error sinks). `--switch <n>|last` → that switch's window with the `pty`, `process_load`, `agentic_process.load`, `http`, `navigation` lines interleaved on one clock — turn those on too to see inside a slow step.
- **Use for** (symptom → lines to read):
  - **"Switching tabs is slow":** `--switch all`, sort by `ready`/`painted`. `loader ms` ≈ the gap = the loader (open `--switch n` with `process_load` for the step); `committed` early but `ready` late = the view's own work after commit (terminal attach+replay, history fetch); `painted` late after `committed` = render / main thread.
  - **Terminals redraw on every return:** `ready kind=terminal mode=cold` on a tab already visited. Leaving the shell body for a conversation/vibe/file unmounts `TabbedTerminal`, so the return trip is cold by design; `mode=cold` between two SHELL switches is the regression.
  - **"The tab didn't switch":** a `noop` line (which reason), or a `start` with no `committed` (navigation superseded or hung), or `loader_redirect` to somewhere else.
  - **Blank / broken tab:** the `error sink=` line names the path — and `process_history` with no `sw=` next to an empty chat pane is a history load failure, not an empty session.
  - **Hidden tab:** `visibility=hidden` on `start` inflates every frontend gap (timers throttled to ~1s). Measure in a visible page.
- **Needs this checkout's code on the instance** — a release older than the change emits nothing, and frontend lines only reach the log while the backend has the tag on too (`/toplog/client-log` re-filters).
- **Traps:** a page (re)load is `sw=0` with `+ms` from page start and no `start` line (the summary shows it as `pageload`, and numbers each load's run `<run>.<sw>` — told apart by each line's origin, its time minus `+ms`). On `popstate` the router's own listener starts the loader BEFORE ours writes `start`, so its `loader ms` can exceed `committed +ms`. `terminal_flip`/`ready` warm-cold are keyed on "was shown before" (the last traced key + `mounted`; for the chat, having been hidden), never on "effect ran before" — StrictMode runs mount effects twice, and the `mounted` Set is seeded with the first key; both used to call a first mount warm (the `process_load` `TabbedTerminal active flip` line had that bug, two `(warm)` lines per cold mount, fixed with it).
- **Verified 2026-09-22** on disposable instance `tsw-7` (headless Chromium, visible page): 18 switches — page loads, plain shells A⇄B (`terminal/warm` 124–147ms), new Claude chat via the top-nav button (`openDock`, `terminal/cold` ready +1428ms), preferences, assets, browser back/forward (`popstate`), home (twice → 1 `noop same_dock`), the process in vibe (`vibe/cold`) and in a headless chat (`chat/cold`), and two dead URLs (`tab_open_failed` "Tab could not be materialized", page left on the dead URL) → 100 `tab_switch` lines (~6/switch). Tag off (other tags still on, 77 other client lines in the same drive): 0 `tab_switch` lines. Unit: `ui/tests/unit/toplog-tab-switch.test.ts` (start / noop / off).
  Re-verified after the cleanup (same drive, same instance name): 18 switches, 100 lines, `painted` on home too, page-load `loader` lines present; tag off → 0 `tab_switch` lines while `pty` kept writing (25 client lines).

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
