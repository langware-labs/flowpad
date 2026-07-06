---
id: a0f5322c-42b6-533d-9222-42878a8d1c9a
---

# PTY Line Synchronization — Annotation Gutter (right) & Trace Gutter (left)

## Context

The InteractiveTerminal has two side gutters — a left **TraceGutter** (hook/transcript events, read-only) and a right **AnnotationGutter** (user memos, writable) — both positioned via absolute buffer row calculations. This document covers the PTY synchronization model (PtySyncSession, VirtualTerminal, XtermAdapter) and the annotation gutter. The trace gutter is documented in [trace-gutter.md](./trace-gutter.md).

---

## Part 1 — Data Model

### 1.1 xterm Buffer Coordinate System

xterm maintains a buffer larger than the visible viewport. All gutters operate in the same absolute coordinate space:

| Property | Type | Meaning |
|----------|------|---------|
| `buffer.active.baseY` | number | Absolute index of the top line of the **active** (non-scrollback) viewport. Increments as lines scroll off. |
| `buffer.active.cursorY` | number | Cursor row **relative to** `baseY`. Range: `[0, rows-1]`. |
| `buffer.active.viewportY` | number | Absolute index of the **top-left visible line** — what the user sees at the top edge of the terminal. |

When the user hasn't scrolled: `viewportY === baseY`. When scrolled up: `viewportY < baseY`.

**Derived — absolute cursor line:**
```
absoluteCursorLine = buffer.baseY + buffer.cursorY
```

This is the absolute line where new PTY output is being written right now.

### 1.2 PtySyncSession — Central Coordinator

`PtySyncSession` (`ts_sdk/src/pty-sync/PtySyncSession.ts`) is the single facade that wraps a `LiveXtermAdapter` and a `VirtualTerminal`, maintaining a mapping from chunk sequence numbers to absolute cursor rows.

**Snapshot type** (immutable between version bumps):
```ts
interface PtySyncSnapshot {
  adapter: LiveXtermAdapter | null;
  vt: VirtualTerminal | null;
  version: number;
  refLines: PtyLineRange[];
}
```

- `adapter` — bridge to the live xterm `Terminal` instance (null before `initialize` or after `dispose`)
- `vt` — the `VirtualTerminal` emulator that replays PTY chunks (null before `initialize` or after `dispose`)
- `version` — monotonically increasing counter; incremented on every state change to trigger React re-renders via `useSyncExternalStore`
- `refLines` — flattened segment row ranges used to map timestamps to absolute rows (trace gutter)

**Absolute cursor row formula (VirtualTerminal):**
```
absoluteCursorRow = cursorRow + totalScrolledOff
```
Where `cursorRow` is the live buffer index and `totalScrolledOff` is the number of rows evicted from the top of the VT buffer.

**Configuration:**
```ts
interface PtySyncConfig {
  scrollbackLines?: number;  // default: 10000
  seed?: number;             // default: 0
}
```

### 1.3 FlowData Trace Event Data (left gutter)

The left gutter uses the FlowData trace channel, not the PTY I/O channel.

Source: `useTraceGutter()` consumes `AgenticProcess.flowDataStream` through `useFlowDataTrace()`. That stream contains history loaded through `process.loadHistory()`, live worker stream output, and hook/sniffer events routed to the process.

Every trace event has its `absRow` resolved via `ptySyncSession.bucketTimestamp(ts)`, which uses the current `PtySegment` list to find the best terminal row for the event timestamp. See [trace-gutter.md](./trace-gutter.md) for the full bucketing model.

The PTY channel remains terminal I/O: `Shell` / `PtyConnection` deliver bytes to xterm and accept user input. `PtySyncSession` observes those chunks only to maintain terminal row coordinates for the parallel FlowData trace channel.

### 1.4 Annotation & Memo Entity Data (right gutter)

Source: `useAnnotationGutter` queries `Memo` entities (`memo_type === 'terminal_annotation'`) and `Annotation` entities, both filtered to `session_id === workerSessionId`.

**Memo** relevant fields:
- `id: string` — entity ID
- `data.line: number` — absolute buffer row stored at user-click time (used directly for positioning)
- `content: string` — user text

**Annotation** relevant fields (kind determined by `labels`):
- `labels: ['prompt:']` — prompt boundary, positioned by text search in xterm buffer
- `labels: ['comment:']` — user comment, positioned by `data.line`
- `labels: ['plan:']` — plan annotation, positioned by text search
- `content: string` — text (used as search needle for prompt/plan)
- `data.line: number` — absolute row for comment annotations

**Positioning strategy:**
- `memo` / `comment`: `data.line` (exact row stored at creation time)
- `prompt` / `plan`: scan xterm buffer via `adapter.getLineText(absRow)` for `content` — same approach as `buildSegmentsFromAnchors()`

Prompt text for the prompt index is special: the canonical list comes from
`AgenticProcess.getPrompts()` -> `transcript/prompts` -> `AgentTranscriptFile.prompts`.
Prompt annotations are only row anchors for click-to-scroll behavior.

---

## Part 1.5 — PtySyncSession Lifecycle & React Integration

### Lifecycle

```
initialize(term)  -->  processChunk() x N  -->  [resize: rebuild(chunks)]  -->  resetSession()  -->  dispose()
```

| Method | What it does |
|--------|-------------|
| `initialize(term)` | Creates `LiveXtermAdapter` from the xterm `Terminal`, creates `VirtualTerminal` with matching dimensions (cols, rows, cellWidth, cellHeight). Called once after `xterm.open()` + `FitAddon.fit()`. |
| `processChunk(chunk)` | Feeds chunk through VT, syncs `adapter.setEvictionOffset(vt.getTotalScrolledOff())`. Bumps version. |
| `rebuild(chunks)` | Creates fresh VT with current adapter dimensions, replays all chunks into it, syncs eviction offset. Called from ResizeObserver handler. |
| `resetSession()` | Nulls VT. Used for session switching. |
| `dispose()` | Nulls adapter and VT. Called on terminal unmount. |

### useSyncExternalStore Protocol

`PtySyncSession` implements the `useSyncExternalStore` contract:

- `subscribe(listener)` — registers a callback; returns an unsubscribe function. Listeners are notified on every `_bump()`.
- `getSnapshot()` — returns the current immutable `PtySyncSnapshot`. A new snapshot object is created on every `_bump()` so React's referential equality check detects changes.

Every mutation method calls `_bump()`, which increments `_version`, builds a new snapshot, and notifies all listeners.

### React Integration

**`PtySyncContext.tsx`** provides the React bindings:

| Export | Usage |
|--------|-------|
| `PtySyncProvider` | Wraps the terminal component subtree. Accepts a `session: PtySyncSession` prop. Context holds the stable session object, not the snapshot. |
| `usePtySync()` | Reads the snapshot reactively via `useSyncExternalStore`. Must be called inside `<PtySyncProvider>`. Throws if called outside. |
| `usePtySyncSession(session)` | Reads the snapshot reactively from a session passed directly. Used by the component that owns the session ref (and also provides the `PtySyncProvider`). |

Both hooks wrap `session.subscribe` and `session.getSnapshot` in `useCallback` (stable on `[session]`) and pass them to `useSyncExternalStore`.

---

## Part 1.6 — VirtualTerminal Getters

`VirtualTerminal` (`ts_sdk/src/pty-sync/simulator/VirtualTerminal.ts`) provides two lightweight O(1) getters used by `PtySyncSession` on every chunk:

| Method | Returns | Cost |
|--------|---------|------|
| `getCursorRow()` | `cursorRow + totalScrolledOff` (absolute row) | O(1) |
| `getTotalScrolledOff()` | `totalScrolledOff` (rows evicted from buffer top) | O(1) |

Contrast with `getReport()` which serializes the entire buffer (O(buffer)) — unsuitable for the hot path. `getCursorRow()` and `getTotalScrolledOff()` exist specifically because `processChunk` calls them on every chunk.

---

## Part 1.7 — Eviction Offset (XtermAdapter)

**Concept:** The eviction offset tracks how many rows the VirtualTerminal has scrolled off that xterm has also evicted from its live buffer. It bridges absolute row numbers (VT-space) to xterm's live buffer indices.

**Interface:** `IXtermAdapter.getEvictionOffset(): number` (all adapter implementations).

**LiveXtermAdapter** (`ts_sdk/src/pty-sync/adapter/XtermAdapter.ts`):
- `setEvictionOffset(n: number)` — called by PtySyncSession on every `processChunk` and `rebuild` with `vt.getTotalScrolledOff()`
- `getEvictionOffset(): number` — returns the stored offset

**How adapter methods use it:**
- `getBufferLine(absRow)` — translates to `term.buffer.active.getLine(absRow - evictionOffset)`
- `bufferIndexToPixelY(absRow)` — `(absRow - evictionOffset - firstVisibleRowLive) * cellHeight`
- `pixelYToBufferIndex(pixelY)` — `firstVisibleRowLive + evictionOffset + floor(pixelY / cellHeight)`
- `scrollToRow(absRow)` — `desiredFirstRowLive = max(0, (absRow - evictionOffset) - floor(rows/2))`

**StubXtermAdapter** — test double with a public `evictionOffset` field (default 0). Mirrors the same coordinate math for unit tests.

---

## Part 2 — Calculations

### 2.1 cellHeight — Pixels per Row

```
cellHeight = xtermContainer.offsetHeight / terminal.rows
```

- `xtermContainer` = `xtermContainerRef.current` (the div xterm is mounted into)
- `terminal.rows` = visible row count set by FitAddon after `fit.fit()`
- Recalculated: on initial fit, on ResizeObserver callback, on annotation gutter toggle
- Stored in React state; passed as a prop to both gutters

`LiveXtermAdapter.getDimensions()` also computes cellHeight from xterm's internal render dimensions (or falls back to `element.clientHeight / rows`).

### 2.2 PtySyncSession.processChunk Recording

On every `processChunk(chunk)`:

```ts
vt.processChunk(chunk);                                    // feed raw bytes through VT emulator
adapter.setEvictionOffset(vt.getTotalScrolledOff());      // keep adapter in sync with VT eviction
```

### 2.3 Annotation Positioning

`useAnnotationGutter` uses two positioning strategies depending on annotation kind:

**memo / comment** — `data.line` (exact absolute row stored at creation time):
```
absRow = annotation.data.line
```

**prompt / plan** — text search in xterm buffer (`findTextRow`):
```ts
function findTextRow(adapter, searchText): number | null {
  const needle = searchText.trim().slice(0, 60);
  const eviction = adapter.getEvictionOffset();
  for (let absRow = eviction; absRow < eviction + adapter.getBufferLength(); absRow++) {
    const lineText = adapter.getLineText(absRow);
    if (lineText?.includes(needle)) return absRow;
  }
  return null;
}
```

This is the same scan used by `buildSegmentsFromAnchors()` — it finds the exact row where the prompt text appears in the live xterm buffer, not where the cursor was *after* processing the response. The `seqCursorMap` approach (cursor row after chunk) was incorrect because it placed annotations at the bottom of Claude's response rather than at the user's prompt line.

### 2.4 Translation Scenario Table

| Scenario | Input | Output |
|----------|-------|--------|
| **Place memo/comment** | `absoluteLine` (from click row) | save `{ line: absoluteLine }` |
| **Render memo/comment** | `data.line` | `absRow = data.line`; then `adapter.bufferIndexToPixelY(absRow)` |
| **Render prompt/plan** | `annotation.content` | `absRow = findTextRow(adapter, content)`; same pixel conversion |
| **Scroll** | `absRow`, adapter scroll state | `pixelY = adapter.bufferIndexToPixelY(absRow)` — subtracts eviction offset and firstVisibleRow, multiplies by cellHeight |
| **Terminal resize** | ResizeObserver fires | `rebuild(allChunks)` — fresh VT with new dimensions, eviction offset re-synced |
| **Index click / home nav** | `data.line` | `adapter.scrollToRow(absRow)` — centers the row in the viewport |

### 2.5 Visibility Test

An annotation is visible only if its absolute row is within the current viewport:
```
visible = absRow >= viewportY  AND  absRow < viewportY + rows
```
Where `viewportY` and `rows` come from the adapter's scroll state and dimensions.

### 2.6 Viewport Row Conversion

Convert absolute row to pixel position via the adapter:
```
pixelY = adapter.bufferIndexToPixelY(absRow)
     = (absRow - evictionOffset - firstVisibleRowLive) * cellHeight
```

Example: `absRow = 75`, `evictionOffset = 0`, `firstVisibleRowLive = 50`, `cellHeight = 22px` -> `pixelY = 550px`.

### 2.7 Collision Avoidance — Trace Gutter Expanded Mode

Multiple trace events can share the same `absRow`. In expanded overlay mode, `computeLayout` spreads them vertically:
```
sort visible entries by (absRow ASC, event.id ASC)
nextFreeRow = 0
for each entry:
  naturalRow  = absRow - viewportY
  displayRow  = max(naturalRow, nextFreeRow)
  nextFreeRow = displayRow + 1
```

`displayRow` is used for the overlay panel only. The dot column always uses `naturalRow`.

### 2.8 Scroll-to-Center (annotation navigation)

When user clicks a memo icon to navigate:
```
adapter.scrollToRow(absRow)
  -> desiredFirstRowLive = max(0, (absRow - evictionOffset) - floor(rows/2))
  -> terminal.scrollLines(delta)
```
Centers the memo row in the viewport.

### 2.9 viewportY Sync (scroll tracking)

Both gutters track scroll identically:
```
on mount:      setViewportY(terminal.buffer.active.viewportY)
onScroll:      setViewportY(terminal.buffer.active.viewportY)
```

Pure event-driven — no polling. Any scroll (user drag, `scrollToLine`, keyboard) fires `onScroll` and both gutters re-render with updated positions.

---

## Part 3 — View Application

### 3.1 Gutter Container Sizing

Both gutters are `position: relative; shrink-0` divs in the terminal's flex row:

```
TraceGutter width:       48px  (constant — never changes)
AnnotationGutter width:  24px  (constant — never changes)
Both heights:            rows * cellHeight
```

**Why constant width is critical:** FitAddon measures the available width to determine `terminal.cols`. If gutter width changes, FitAddon refits -> `cols` changes -> buffer reflows. Constant widths prevent this cascade.

### 3.2 Icon / Dot Positioning (per visible entry)

For each entry whose `absRow` is in the viewport:
```css
position: absolute;
top:    naturalRow * cellHeight + (cellHeight - iconHeight) / 2;
left:   0;
width:  [gutterWidth];
height: iconHeight;   /* 14px trace dot, cellHeight annotation square */
```

The `(cellHeight - iconHeight) / 2` offset centers the icon vertically within its row.

### 3.3 Total Event Count Badge (trace gutter, top of gutter)

The `EventCountBadge` shows total event count:
```css
position: absolute;
top:  0;
left: 50%;
transform: translateX(-50%);
height: 18px;
```

Always visible at the gutter's top edge regardless of scroll.

### 3.4 Expanded Trace Overlay Panel

Clicking the dot column toggles expanded mode. A `position: absolute; left: 48px` panel appears — it does **not** affect the flex layout (`position: absolute` + `pointerEvents: auto`), so xterm never refits.

Entries use `displayRow` (collision-adjusted, see 2.7):
```css
position: absolute;
top:    displayRow * cellHeight;
height: cellHeight;
left: 0; right: 0;
```

### 3.5 Annotation Right Gutter — absRow-based Rendering

The annotation gutter positions elements via `absRow` computed by `useAnnotationGutter`. No xterm markers are involved.

- `memo` / `comment`: `absRow = data.line` — exact row stored at creation
- `prompt` / `plan`: `absRow = findTextRow(adapter, content)` — text scan of xterm buffer

**Rendering:** Each visible memo's `absRow` maps directly to a buffer row. Visibility check:
```
absRow >= viewportY && absRow < viewportY + rows
```

The gutter iterates every visible row:
```
for r in [0, rows):
  absoluteLine = viewportY + r
  entry = entriesMap.get(absoluteLine)
  render cell:
    top:    r * cellHeight
    height: cellHeight
    width:  24px
```

`entriesMap` is `Map<absoluteLine, AnnotationEntry>` built from computed `absRow` values.

Each cell: if `entry` -> `StickyNote` icon. If no entry -> transparent div (faint square border on hover).

**Add popover** (empty row click):
- Pick type: **Memo** (StickyNote/yellow) or **Comment** (MessageSquare/sky)
- Enter text → Save

Save calls `createMemo(absoluteLine, text)` or `createComment(absoluteLine, text)`:
- Saves `data: { line: absoluteLine }` — no seq/seqOffset

**View/delete popover** (memo icon click):
```
[StickyNote] Memo
[content, read-only]
--------------------
[Delete]  -> Are you sure? [Confirm] [Cancel]
```

**Annotation index badge** (top of gutter): Shows total memo count. Click opens a popup listing all session memos with scroll-to navigation.

### 3.6 Scroll-into-View Flow

1. User clicks memo in the annotation index
2. `pendingScrollLine` is set to the memo's `absRow` (once replay is complete and the target memo is found)
3. `adapter.scrollToRow(absRow)` centers the row in the viewport
4. xterm fires `onScroll` -> both gutters re-render with updated positions
5. Clicked memo now appears near the center of the viewport

Scroll state resets on session or `targetTimestamp` change.

---

## Part 3.5 — Restart & Reconnect Recovery

This section is the consolidated reference for what survives — and what is lost —
across the three restart cases. The membership/lifecycle mechanics (attach FSM,
parking, framed-stream replay, seq numbers) are documented in
[pty-websocket.md](./agent-management/pty-websocket.md); this section is the
per-case recovery narrative that ties those pieces together.

### What persists vs what dies

| Artifact | Lives in | Survives FE reload | Survives BE restart |
|----------|----------|:------:|:------:|
| OS PTY process (shell / worker child) | kernel, child of the backend | yes | **no** — dies with the parent (SIGHUP) |
| `PtyState` seq counter + membership (attached/detached connections) | backend `PtyRegistry` (in-memory, no bytes) | yes (parked/resumed) | **no** — rebuilt on respawn, seq re-seeded from `max_seq()` |
| **Framed PTY stream file (`.pty`)** | disk, `shell_pty_stream_path(record_id, pty_pid)` | yes | **yes** — the disk record of scrollback |
| `Shell` entity + `ShellRecord` (status, `pty_pid`, `workdir`, `session_id`) | DB + disk record | yes | **yes** |
| CLI transcript / session id (`claude`/`codex`/`copilot` JSONL) | vendor session store on disk | yes | **yes** — the basis for `--resume` |
| Frontend xterm buffer | browser tab memory | **no** — reset on reload | no |

The framed stream file (`flow_sdk/compute/providers/desktop/pty_stream_file.py`)
is the load-bearing disk artifact for scrollback recovery. It records output
frames **and** resize frames (`["o", b64, seq]` / `["r", [cols, rows]]`) so
replay reconstructs the exact winsize timeline — replaying bytes at the wrong
width garbles cursor-relative TUI repaints (ink / Claude). It is served by
`GET /api/v1/shell/{shell_id}/pty-stream`
(`flow_sdk/server/routes/pty_stream.py:19`).

### The attach handshake (shared by all three cases)

`InteractiveTerminal`'s `onConnected`
(`ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx:1061`)
is the single repaint path, re-run on first mount, on `on_reconnected`, and on
`on_recovered`. A `connectGen` token makes re-entry safe (a newer run supersedes
an in-flight one). Steps:

1. `fetchPtyStream(pty_pid)` → `replayPtyStream(...)`
   (`ui/src/components/terminal/interactive-terminal/pty-replay.ts`) replays the
   framed disk stream through a **headless** xterm at the recorded sizes,
   serializes scrollback+screen+cursor, and records `historyLastSeq`.
2. `term.reset()` then `term.write(historySerialized)` — clean slate + restored
   history.
3. Replay live WS chunks accumulated since attach, **skipping** any with
   `chunk.seq <= historyLastSeq` (dedup against the disk replay).
4. Assert this client's size (`shell.resize`) to force a SIGWINCH repaint at real
   dimensions, then subscribe live output.

Because the disk file is the *only* scrollback record that survives a backend
restart (there is no in-memory replay buffer — attach does no byte replay, see
[pty-websocket.md](./agent-management/pty-websocket.md) "Replay model note"),
this handshake is what restores scrollback after case (b)/(c).

**seq monotonicity across restart is critical.** On respawn,
`start_machine_pty_session` seeds the new session's counter from
`pty_stream_file.max_seq()` (`flow_sdk/builtin/faas/pty_actions.py:414`). Without
this, the fresh process would restart seq at 1, the frontend's
`chunk.seq <= historyLastSeq` dedup would drop all post-restart output, and the
terminal would look dead after a server restart.

### Case (a) — Frontend reload only (backend up)

- PTY, worker, and `PtyState` all survive.
- The reloaded tab opens a fresh WebSocket (new `connection_id`) and re-runs the
  loader → `process.start()` / `Shell.attachPty()`. The reattach fast-path
  (`_perform_open`, agentic_process.py:1009) confirms `has_attachable_pty()` **and**
  `worker_alive()` and returns without respawning.
- `onConnected` replays the disk stream + live tail. **Nothing is lost**; this is
  a pure repaint. No `recovered` event.

### Case (b) — Backend restart, live PTYs (frontend stays open)

- Every OS PTY child dies (SIGHUP). In-memory buffer and `PtyState` are gone. The
  DB still shows `status=running` with a now-dead `worker_pid` (split-brain).
- Startup (`app.py:_on_server_startup`): `reconcile_orphaned_workers` stamps dead
  **headless** (`visible=false`) RUNNING/STARTING processes → `STOPPED` (awaited
  before serving, so the first bootstrap is clean). Visible PTYs are left for the
  recovery watchdog.
- `start_recovery_task` runs `run_pty_recovery` every 5s. Recovery is
  **on-demand**: only a process/shell a live connection is *watching* is respawned
  (an unopened session stays dead until the user loads it). This guards against
  the boot-time mass-respawn that exhausted the OS pty pool
  (`OSError: out of pty devices`).
- Respawn goes through the locked `proc.start_pty()` → `_perform_open`: the
  reattach gate fails (PTY+worker dead), so it **soft-drops** the stale shell
  (`preserve_shell_id=True` — keeps the `.pty` file so scrollback replays and
  the same session id resumes), relaunches the worker with `--resume` when the
  driver reports `has_resumable_session`, and emits the distinct `recovered`
  event.
- The open UI receives `recovered_msg`, matches on `process_id`/`shell_id`, and
  re-runs `onConnected` — disk-stream replay restores pre-restart scrollback and
  the resumed worker continues the conversation.
- **Lost:** in-flight (uncommitted) worker output between the last disk-frame
  flush and the crash; any headless turn in progress; live buffer chunks newer
  than the disk file that weren't yet flushed. **Restored:** scrollback (to the
  disk file's tail), the CLI conversation (via `--resume`), and the tab.

### Case (c) — Full machine restart

- Superset of (b): every backend, PTY, and browser tab is gone. On relaunch the
  backend starts cold; the browser reloads.
- Same recovery path as (b), but recovery only fires **after** a client re-opens
  a terminal (nothing is watched at cold boot — see the watchdog note). Until the
  user navigates to a terminal, its worker stays dead and its `Shell` row stays
  `running` on disk.
- `--resume` still works because the vendor CLI session store is on disk and
  outlives the machine restart.

### Per-CLI resume path

Restart recovery relaunches with `--resume <session_id>` only when the driver's
`has_resumable_session(process)` confirms a transcript exists in that vendor's
own store:

| CLI | Resume probe |
|-----|--------------|
| Claude | `get_claude_session(session_id) is not None` (claude/driver.py:312) — a session imported from another machine/CWD is *not* locally resumable. |
| Codex | `find_codex_session_jsonl(session_id) is not None` (codex/driver.py:284). |
| Copilot | `self._has_session(process)` — checks the copilot session file (copilot/driver.py:249). |

If the probe is false, the worker relaunches **fresh** (no `--resume`) rather
than colliding with a dead session lock.

### Bare (non-agentic) terminal recovery

A plain shell tab (`worker_pid=None`) is recovered by `_recover_bare_shells`
(pty_recovery.py:258): watched + `status=running` + not attachable + within a
1-hour recency window → `Shell.start_pty()` (a **fresh** shell — there is no
conversation to resume). The recency window is a secondary guard against reviving
an abandoned tab whose disk row was never closed.

---

## Part 4 — File Map

| File | Purpose |
|------|---------|
| `ts_sdk/src/pty-sync/PtySyncSession.ts` | Session facade — wraps adapter + VT, builds segments, useSyncExternalStore protocol |
| `ts_sdk/src/pty-sync/adapter/XtermAdapter.ts` | IXtermAdapter interface, LiveXtermAdapter (xterm bridge with eviction offset), StubXtermAdapter (testing) |
| `ts_sdk/src/pty-sync/simulator/VirtualTerminal.ts` | Core terminal emulator — processChunk, getCursorRow/getTotalScrolledOff getters |
| `ts_sdk/src/pty-sync/types.ts` | Shared types: OutputChunk, TerminalDimensions, ScrollState, EnvSetup |
| `ui/src/components/terminal/interactive-terminal/PtySyncContext.tsx` | React context provider + usePtySync / usePtySyncSession hooks |
| `ui/src/components/terminal/interactive-terminal/use-trace-gutter.ts` | TraceGutter hook — buckets per-process `AgenticProcess.flowDataStream` events to rows |
| `ui/src/components/terminal/interactive-terminal/TraceGutter.tsx` | Left gutter component — dot column + expanded overlay panel |
| `ui/src/components/terminal/interactive-terminal/use-annotation-gutter.ts` | Annotation hook — text-search + data.line positioning, memo/comment CRUD |
| `ui/src/components/terminal/interactive-terminal/AnnotationGutter.tsx` | Right gutter — per-row cells, add/view/delete popovers |
| `ui/src/types/trace-event.ts` | Vendor-neutral `TraceEvent` type and FlowData mapper |
| `ui/src/hooks/use-flow-data-trace.ts` | Loads process history and maps `AgenticProcess.flowDataStream` to trace events |
| `ui/src/hooks/use-agentic-process-stream.ts` | Stable `useSyncExternalStore` subscription to the per-process stream |
| `ts_sdk/src/process/agentic-process.ts` | `getPrompts()` calls `transcript/prompts` for canonical prompt text |
| `ts_sdk/src/entities/memo.ts` | Memo entity (memo_type, session_id, data.line, content) |
| `ui/src/components/terminal/interactive-terminal/pty-replay.ts` | `fetchPtyStream` / `replayPtyStream` — disk framed-stream fetch + headless-xterm replay (Part 3.5 recovery) |
| `flow_sdk/compute/providers/desktop/pty_stream_file.py` | Framed rolling `.pty` disk buffer (output + resize frames, seq, truncation) — the restart-surviving scrollback record |
| `flow_sdk/server/routes/pty_stream.py` | `GET /shell/{id}/pty-stream` — serves framed stream for attach replay |
| `flow_sdk/server/pty_recovery.py` | On-demand PTY-recovery watchdog + `reconcile_orphaned_workers` + `recovered` event emission |
| `flow_sdk/builtin/faas/pty_actions.py` | `start_machine_pty_session` — wires `PtyStreamFile`, seeds seq from `max_seq()` for restart monotonicity |
