# Tag catalog

The living registry of toplog tags. Each tag names a trace stream that
`toplog.log([...], …)` calls in the code emit under. `run` reads this to pick the
right tags for an issue; `scan` diffs it against the code; `learn` maintains it.

The catalog starts empty on purpose — there are no production `toplog.log` calls
yet. Tags earn their place through `learn`, after a trace proves useful in an
RCA. That keeps the registry a record of *what actually helped*, not speculation.

## Registry

The registry is every `### <tag>` heading below. Add entries in this format:

```
### <tag>
- **Traces:** <what events / state transitions this stream logs>
- **Where:** <subsystem + a few representative file paths that emit it>
- **Use for:** <the symptom classes this tag illuminates>
```

<!-- New tags go here, one `### <tag>` heading each. Keep alphabetical so the
     registry stays scannable and catalog diffs stay stable across edits. -->

### navigation
- **Traces:** every frontend navigation transition — `openDock` entry/dedup-no-op/target, the `window.history.pushState` + synthetic `popstate` pair in `commitBrowserNavigation`, `navigateToBaseUrl`, `goBack`/`goForward` (`navigate(±1)`), the mouse X1/X2 → `history.back/forward` bridge, the global `popstate` listener, the zustand history store (`pushHistory`/`goBack`/`goForward` with `currentIndex`), and `currentDock` changes. Each line carries the current browser URL, the target URL, and (where relevant) the dock pointer and history index.
- **Where:** frontend navigation core — `ui/src/navigation/NavigationActions.ts`, `ui/src/navigation/useDockNavigation.ts`, `ui/src/hooks/use-navigation-state.ts`, `ui/src/main.tsx` (mouse-button bridge + global popstate listener). The Electron main process emits the parallel `[nav]` stream via `electron-log` in `electron/main.js` (back/forward gesture sources + `did-navigate`/`did-navigate-in-page`/`will-navigate`).
- **Use for:** double-navigation / "back jumps twice" bugs, back/forward landing on the wrong view, dock open/close not reflecting in the URL, history desync between the browser history stack and the zustand `navigation-history` store.

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
