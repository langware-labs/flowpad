---
id: f167e843-4f52-5252-8a2c-fae98ce44479
---

# PTY / xterm Terminal System Specification

## Overview

The terminal system provides interactive PTY (pseudo-terminal) sessions in the browser via xterm.js. It spans four layers: **PTY process** (OS-level), **backend session management** (Python/FastAPI), **WebSocket transport**, and **frontend rendering** (React/xterm.js). Sessions survive page refreshes via **attach-time history replay**: the backend records a framed stream (output + resize events) per session; on reattach the client replays it through a headless xterm at the recorded sizes, restores the serialized result, and the attach repaint refreshes the live frame (see §13).

---

## 1. End-to-End Data Flow

### 1.1 Output Path (Backend → Frontend)

```
OS PTY fd (raw bytes)
  → daemon read_thread (1024-byte reads)
  → on_output callback
  → PtyState.next_seq() assigns monotonic seq number
  → PtyStreamFile.write(data, seq) appends a framed output line to disk (§10)
  → PtyOutputMessage.from_bytes() base64-encodes data
  → WebSocket send to all attached attached_connections
  → ConnectionManager dispatches 'pty_output_msg'
  → ShellManager.handlePtyOutputMsg()
      - atob() → Uint8Array → TextDecoder({ stream: true }) → string
      - routes to ShellSession.appendPtyOutput(data, seq)
  → InteractiveTerminal output listener
      - term.write(decoded string)
  → xterm.js renders ANSI → DOM
```

### 1.2 Input Path (Frontend → Backend)

```
User keystroke in xterm.js
  → term.onData(data) handler
  → Filter out Device Attributes auto-replies (CSI ?c)
  → shellManager.sendPtyInput(sessionId, data)
  → REST-over-WS: POST /terminal-command subpath=input
      body: { session_id, data }
  → ComputeNode._send_pty_input()
  → compute_provider.send_pty_input(session_id, data_bytes)
  → PtyProcess.write(data_bytes)
  → OS PTY fd (stdin)
```

### 1.3 Data Encoding

| Segment | Format |
|---------|--------|
| PTY fd → read_thread | Raw bytes |
| read_thread → stream file | Framed JSONL line: base64 + seq (§10) |
| read_thread → WebSocket | Base64 string in JSON (`PtyOutputMessage.data`) |
| WebSocket → ShellManager | `atob()` → `Uint8Array` → `TextDecoder('utf-8', { stream: true })` → string |
| ShellManager → xterm.js | UTF-8 string via `term.write()` |
| xterm.js → ShellManager (input) | UTF-8 string via `term.onData()` |
| ShellManager → WebSocket | UTF-8 string in JSON body `{ data: "..." }` |
| WebSocket → PTY stdin | `data.encode('utf-8')` → `PtyProcess.write(bytes)` |

**Why base64 for output?** PTY output can contain arbitrary binary data (ANSI escape sequences, box-drawing chars). Base64 ensures safe transport over JSON/WebSocket text frames (~33% overhead).

**Why streaming TextDecoder?** Multi-byte UTF-8 characters (e.g., box-drawing `─` = 3 bytes) can be split across WebSocket messages. `{ stream: true }` preserves incomplete sequences across calls, preventing `U+FFFD` replacement characters.

### 1.4 Channels & Multiplexing

All PTY sessions for a ComputeNode share a **single WebSocket connection**. Sessions are demultiplexed by `session_id` in each message:

```
WebSocket /api/v1/connect/ws/{connection_id}
  ├── session_id: "shell-1709..." → Terminal Tab 1
  ├── session_id: "shell-1709..." → Terminal Tab 2
  └── session_id: "shell-1709..." → Terminal Tab 3
```

Multiple browser tabs/windows can attach to the same PTY session simultaneously — each gets its own `connection_id` in the session's `attached_connections` set.

#### Connection-membership FSM (backend-owned)

Which connections receive a PTY's output is a **backend** state machine on `PtyState`, driven entirely by the WebSocket lifecycle — the frontend never re-attaches on reconnect. A connection is in exactly one state per `PtyState`:

| State | Where | Receives output? |
|-------|-------|------------------|
| `ATTACHED` | `attached_connections: set[str]` | yes |
| `DETACHED` | `detached_connections: dict[str, float]` (id → detached_at) | no — parked, kept for reconnect |
| `NONE` | in neither | — |

Transitions (all backend; `connection_id` is stable across an in-page reconnect):

| Event | Transition | Hook |
|-------|-----------|------|
| client opens terminal | `NONE → ATTACHED` | `generate_session` / `attach` |
| **WS disconnect** | `ATTACHED → DETACHED` (park) | `PtyRegistry.on_ws_disconnect` (websocket.py finally) |
| **WS connect/reconnect** | `DETACHED → ATTACHED` (resume) | `PtyRegistry.on_ws_connect` (websocket.py accept) |
| client closes tab | `* → NONE` (+ destroy if last) | `close_for_connection` |
| orphan TTL / parked grace | close / drop | `cleanup_expired_sessions` |

So a transient drop+reconnect of the same `connection_id` auto-restores output with **no client action**. (A *dead PTY* — an agentic worker that exits mid-session, or any shell whose process is gone after a full backend restart — is a separate concern, respawned by the periodic backend watchdog in `flow_sdk/server/pty_recovery.py`: `run_pty_recovery` re-`start_pty`s dead agentic workers (`--resume`), and `_recover_bare_shells` respawns recently-active bare terminals — liveness keyed on `has_attachable_pty`, not `worker_alive`, since a bare shell has no worker. The client then re-`attach`es to the rebuilt PTY.)

---

## 2. API Endpoints

### 2.1 WebSocket Endpoint

| URL | Purpose |
|-----|---------|
| `ws://localhost:9007/api/v1/connect/ws/{connection_id}` | Bidirectional communication channel |

- `connection_id`: Client-generated UUID
- On connect: server stores in `_active_connections`, sends confirmation
- On disconnect: cleanup connection and all watched sessions
- Supports both text (JSON) and binary (msgpack) frames

### 2.2 Terminal Command Actions (REST-over-WS)

All terminal operations route through the ComputeNode `terminal-command` action:

**URL pattern**: `POST /api/v1/graph/compute_node/{compute_node_id}/terminal-command/{operation}`

These are sent as `rest_api_msg` over WebSocket (not plain HTTP):

```json
{
  "message_type": "rest_api_msg",
  "method": "POST",
  "scope": [{ "type": "ComputeNode", "id": "{compute_node_id}" }],
  "action": "terminal-command",
  "sub_path": "{operation}",
  "body": { ... }
}
```

#### Operations

| Operation | Body Fields | Response | Purpose |
|-----------|-------------|----------|---------|
| `start` | `session_id`, `name?`, `cols` (default 80), `rows` (default 24), `working_dir?`, `initial_command?` | `{ status: "connected" }` | Spawn new PTY process |
| `attach` | `pty_id`/`shell_id`, `cols?`, `rows?` | `{ status: "reattached", latest_seq }` | Reattach after refresh — NO byte replay; asserts the client size (or jiggles the winsize) so the running TUI repaints its live frame. History comes from the framed-stream replay (§13). `since_seq` from older clients is ignored. |
| `input` | `session_id`, `data` | `{ status: "ok" }` | Send keystrokes to PTY stdin |
| `resize` | `session_id`, `cols`, `rows` | `{ status: "ok" }` | Update terminal dimensions |
| `close` | `session_id` | `{ status: "ok" }` | Kill PTY process and cleanup |
| `list` | (none) | `{ sessions: [{ session_id, name }] }` | List active sessions |
| `rename` | `session_id`, `name` | `{ status: "ok" }` | Change session display name |

### 2.3 AgenticProcess PTY Actions

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/graph/agentic_process/{id}/start` | POST | Start PTY linked to process; builds `claude --session-id` command; returns `{shell_id, worker_session_id, shell: <entity>}` |
| `/api/v1/graph/agentic_process/{id}/resume` | POST | New PTY with `claude --resume {worker_session_id}` |
| `/api/v1/graph/agentic_process/{id}/stop` | POST | SIGINT + close PTY, preserves `worker_session_id` for resume |

### 2.4 Response Wrapper

All responses are wrapped in `ResponseMessage`:

```json
{
  "message_type": "response_msg",
  "message_id": "...",
  "response_message_id": "{original_request_message_id}",
  "session_id": "shell-...",
  "content": { "status": "connected", "latest_seq": 42 },
  "error": null
}
```

---

## 3. Message Formats

### 3.1 PTY Output Message (Server → Client)

```json
{
  "message_type": "pty_output_msg",
  "message_id": "uuid",
  "provider_node_id": "local-machine",
  "session_id": "shell-1709...",
  "data": "G1szMm0kIGxzIC1sYQ==",
  "seq": 42
}
```

- `data`: Base64-encoded raw PTY bytes
- `seq`: Monotonic integer, starts at 1, increments per output chunk. Used for deduplication and replay.

### 3.2 PTY Session Status Message (Server → Client)

```json
{
  "message_type": "pty_session_status_msg",
  "message_id": "uuid",
  "session_id": "shell-1709...",
  "status": "connected",
  "latest_seq": 42
}
```

`status` values: `"connected"`, `"reattached"`, `"not_found"`, `"expired"`

### 3.3 Data Operation Message (Entity Updates)

Sent when session metadata changes (PTY started, closed, etc.):

```json
{
  "message_type": "data_op_msg",
  "message_id": "uuid",
  "to_entity": "compute_node-{id}",
  "op": "update",
  "data": { "active_pty_sessions": ["shell-1", "shell-2"] }
}
```

---

## 4. State Management

### 4.1 Backend State

#### Session Key

```python
pty_key = (compute_node_id, provider_node_id, session_id)
# Example: ("compute-node-abc", "local-machine", "shell-1709...")
```

#### PtyState (in-memory, `pty_session_manager.py`)

```python
class PtyState:
    pty_key: PtyKey                   # (compute_node_id, provider_node_id, session_id)
    attached_connections: set[str]          # ATTACHED — receive live output
    detached_connections: dict[str, float]  # DETACHED — parked (WS dropped), id -> detached_at
    cols: int                         # Current terminal width
    rows: int                         # Current terminal height
    name: str | None                  # Display name
    terminal_id: str | None           # Terminal identifier
    last_seq_received: int            # Latest output sequence number
    created_at: float                 # Unix timestamp
    last_attached_at: float | None    # Last time a connection attached
    last_detached_at: float | None    # Last time last connection detached
    provider_session_data: dict       # Provider metadata (e.g., PID)
```

#### History persistence (on-disk, `pty_stream_file.py`)

The in-memory `PtyReplayBuffer` was **removed** (commit `4466d9bc`): replaying raw recorded bytes into a terminal at a different width garbles cursor-relative repaints (ink/Claude TUIs erase-and-repaint N lines calibrated to the width at emission time). It was replaced by the framed on-disk stream (§10) plus client-side replay at the recorded sizes (§13). The per-session `seq` counter now lives on `PtyState`.

#### Database-Persisted State

| Entity | Field | Purpose |
|--------|-------|---------|
| `ComputeNode` | `active_pty_sessions: list[str]` | List of active session IDs |
| `AgenticProcess` | `pty_pid: str | null` | Current PTY session (null when no PTY) |
| `AgenticProcess` | `worker_session_id: str | null` | Claude CLI session ID (survives PTY restarts) |
| `AgenticProcess` | `compute_node_id: str | null` | Which ComputeNode hosts this PTY |

### 4.2 Frontend State

#### ShellSession (TypeScript SDK, `shellSession.ts`)

```typescript
class ShellSession {
    sessionId: string;
    name: string;
    isPty: boolean;
    ptyStarted: boolean;              // PTY process running on backend
    computeNodeId?: string;
    lastSeqReceived: number;          // For deduplication + reattach
    workingDir?: string;
    initialCommand?: string;          // Command to inject on PTY start
    processId?: string;               // Owner AgenticProcess ID
    createdAt: number;
    isRunning: boolean;
}
```

**PTY data listeners**: `session.onPtyData((data, seq) => ...)` — xterm.js subscribes here.

#### ShellManager (Singleton, `shellManager.ts`)

- Owns all sessions via active ComputeNode
- Routes `pty_output_msg` from WebSocket to correct session
- Manages orphan buffer for output arriving before session loads
- Emits events: `SESSION_CREATED`, `PTY_STARTED`, `PTY_OUTPUT`, `SESSION_REMOVED`

#### Zustand Store (`use-terminal-state-store.ts`)

Minimal store tracking `activeSessionId`. Rarely used — TabbedTerminal uses local React state.

#### React Hooks

| Hook | Purpose |
|------|---------|
| `useShell()` | Access all sessions, CRUD operations, PTY commands |
| `useShellSession(sessionId)` | Reactive single-session data (stream, items, isRunning) |
| `useShellSessions()` | Sorted array of all sessions, re-renders on changes |
| `useOpenTerminal()` | Open builtin xterm or external terminal |
| `useResumeInTerminal()` | Resume Claude session in a ProcessTerminal |

### 4.3 Session Persistence (API-backed records)

Shell session persistence is backed by `ShellSessionRecord` on the server, not localStorage. The frontend `ShellSessionRecord` class (`ts_sdk/src/services/shell/shellSessionRecord.ts`) provides `list()`, `get()`, and `update()` methods that call ComputeNode actions over WebSocket.

During `syncSessionsWithBackend()`, the `ShellManager` fetches all records via `ShellSessionRecord.list()` and creates/reattaches local `ShellSession` instances for records with `status === "running"`. Each `ShellSession` holds an optional `record` reference for access to backend-persisted metadata.

The previous `localStorage`-based `PtySessionPersistence` interface has been removed.

### 4.4 Session Lifecycle

```
Created (frontend only)
    │
    ├─ startPty() ──→ PTY Running (backend spawned)
    │                      │
    │                      ├─ Page refresh ──→ Detached (backend keeps running)
    │                      │                      │
    │                      │                      └─ reattachFromServer() ──→ PTY Running (restored)
    │                      │
    │                      ├─ closePty() ──→ Closed (backend killed)
    │                      │
    │                      └─ Process exits ──→ Closed (exit callback fires)
    │
    └─ removeSession() ──→ Removed
```

### 4.5 TTL Cleanup (Backend) — two bounded reapers, no leaks

Background task runs every **120 seconds** (`cleanup_expired_sessions`):

```python
pty_registry.start_cleanup_task(interval_seconds=120, ttl_seconds=900)
```

1. **Orphan TTL** — a `PtyState` with an empty `attached_connections` set for > **900 s** (15 min) is closed (PTY killed). `last_detached_at` is stamped when the last connection parks or detaches, arming the timer; a reconnect clears it.
2. **Parked grace** — a `DETACHED` connection that does not reconnect within `detach_grace_seconds` is dropped from `detached_connections`, so a long-lived `PtyState` can't accumulate stale parked ids.

A `PtyState` is "orphaned" when **no connection is ATTACHED** (all parked or gone) — parked subscriptions still alive count as detached, so they don't keep the PTY alive on their own.

---

## 5. Refresh / Reconnect / State Restore

### 5.1 WebSocket Reconnection

Exponential backoff with jitter:

| Attempt | Delay |
|---------|-------|
| 1 | 500ms + random(0-1000ms) |
| 2 | 1000ms + random(0-1000ms) |
| 3 | 2000ms + random(0-1000ms) |
| ... | ... |
| 10 | 10000ms + random(0-1000ms) |
| 11+ | Give up, emit `on_reconnect_failed` |

### 5.2 Reattach Flow (Page Refresh)

```
1. Page loads → InteractiveTerminal mounts with empty xterm
2. Shell attaches over WS (terminal-command/attach) → live chunks start
   buffering in PtyConnection.chunks; backend asserts client size or jiggles
   the winsize so the running TUI repaints its live frame
3. onConnected (InteractiveTerminal):
   a. GET /api/v1/shell/{pty_id}/pty-stream  → framed history (§10)
   b. replayPtyStream(): headless xterm fed the frames AT THE RECORDED SIZES
      (resize frames honored, streaming TextDecoder), then SerializeAddon
      → serialized VT string + lastSeq (highest replayed output seq)
   c. term.reset() → write(serialized)  ← full scrollback restored
   d. write buffered live chunks with seq > lastSeq (dedup — stream frames
      and WS chunks share the per-session seq)
   e. shell.resize(term.cols, term.rows) → SIGWINCH → TUI repaints at the
      client's real dimensions
   f. subscribe live output
4. Any failure in (a)/(b) → silent fallback to live-only (step c..f without
   history) — identical to pre-replay behavior
```

**Race prevention**: an in-flight replay is cancelled by a connect-generation
token when the shell reconnects/disconnects mid-fetch; seq dedup prevents
double-applying output that is both in the fetched stream and in the live
chunk buffer.

### 5.3 Sequence Number Deduplication

Both backend and frontend track sequence numbers:

- **Backend**: `last_seq_received` on `PtyState`
- **Frontend**: `lastSeqReceived` on `ShellSession`
- **ShellManager**: 200-entry recent chunk key cache for dedup

When `msg.seq <= session.lastSeqReceived`, the message is discarded.

---

## 6. Frontend Components & Entities

### 6.1 Component Hierarchy

```
ContentPanel (routing)
  └─ ProcessTerminal (processId prop)
       └─ TabbedTerminal (multi-tab manager)
            ├─ Tab Bar (tabs, rename, context menu)
            ├─ InteractiveTerminal (sessionId="shell-1")  ← active, display: block
            ├─ InteractiveTerminal (sessionId="shell-2")  ← hidden, display: none
            └─ InteractiveTerminal (sessionId="shell-3")  ← hidden, display: none
```

**All terminals stay mounted** — inactive tabs use `display: none` instead of unmounting. This prevents PTY data loss during tab switches.

**Lazy PTY connection** — on page reload, all N terminal tabs are mounted but PTY connections are deferred until a tab is first activated. This prevents the "thundering herd" of N simultaneous `attach`+`start` requests on load. See §6.5 for details.

### 6.2 InteractiveTerminal

**File**: `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`

**xterm.js Configuration**:
```typescript
{
  scrollback: 10000,
  convertEol: true,
  cursorBlink: true,
  scrollOnUserInput: true,
  disableStdin: false,
  cursorStyle: 'block',
  fontFamily: 'Cascadia Code, Fira Code, JetBrains Mono, Menlo, Monaco',
  fontSize: 14,
  allowTransparency: true,
}
```

**Addons**: `FitAddon` (auto-size), `WebLinksAddon` (clickable URLs)

**Parser Interception** (prevents xterm auto-reply loops):
```typescript
term.parser.registerCsiHandler({ final: 'c', prefix: '?' }, () => true);  // Device Attributes
term.parser.registerCsiHandler({ final: 'I' }, () => true);                // Focus In
term.parser.registerCsiHandler({ final: 'O' }, () => true);                // Focus Out
```

**Ctrl+C**: Redirected to clipboard copy (not SIGINT). Backend shell handles Ctrl+C natively.

### 6.3 TabbedTerminal

**File**: `ui/src/components/terminal/TabbedTerminal.tsx`

- Controlled component: `activeSessionId` + `onActiveSessionChange` from parent
- Tab creation generates session ID: `shell-{Date.now()}`
- Tab auto-numbering: "Terminal 1", "Terminal 2", etc.
- Double-click tab to rename
- Context menu: Close, Close All, Close All But This, Close to the Right
- Claude CLI injection: sets `session.initialCommand` (e.g., `claude --session-id {id}`)
- "Full Trust Mode" banner when `skipPermissions=true`

### 6.4 ProcessTerminal

**File**: `ui/src/components/process-terminal/ProcessTerminal.tsx`

- Loads `AgenticProcess` entity with `watch: true` (live updates)
- Extracts `pty_pid` from process entity
- Syncs local `activeSession` with `process.pty_pid` when it changes
- Renders `TabbedTerminal` with `process` prop

### 6.5 ProcessToolbar

**File**: `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx`

- Toggles for `--chrome` and `--dangerously-skip-permissions` flags
- Session info popover (status, workdir, session ID, command)
- Saves flags to `context_data` on AgenticProcess entity
- Shows `RestartRequiredOverlay` when flags change

### 6.5 Lazy PTY Loading — Thundering Herd Prevention

**Problem**: On page reload, `TabbedTerminal` mounts all N terminal tabs with `visibility: hidden`. Without lazy loading, each `InteractiveTerminal` would call `attach`+`start` immediately — N simultaneous PTY connections.

**Solution**: PTY connection is deferred until a tab is first activated. All control logic lives in `Shell.connectLazy()` in the SDK; `InteractiveTerminal` makes a single SDK call.

#### Shell SDK fields (transient, not persisted)

```typescript
_hasEverBeenActive = false;   // true once this tab has been active at least once
pty: PtyConnection | null;    // existing field, still null until connectLazy() is called
```

#### `Shell.connectLazy(isActive, cols, rows, workdir)`

```
isActive=false, _hasEverBeenActive=false  →  return null   (still deferred)
isActive=true   →  set _hasEverBeenActive=true, proceed
pty?.started    →  return []             (already connected, no replay needed)
```

When connection is needed:
1. Create `PtyConnection`, subscribe `liveBuffer` listener
2. Call `reattach(0)` — replay chunks arrive as `pty_output_msg`, fire into `liveBuffer`
3. Unsubscribe `liveBuffer`
4. Call `ensurePty()` — starts fresh PTY if no existing session (not_found)
5. Return `replayChunks`

#### `InteractiveTerminal` connect effect

```typescript
useEffect(() => {
  // Re-runs when active changes — deferred until first activation
  const replayChunks = await shell.connectLazy(active, cols, rows, workdir);
  if (replayChunks === null) return;   // still deferred
  // write replayChunks to xterm, then setReplayComplete(true)
}, [terminalReady, sessionId, active]);
```

#### Output handler subscription timing

The output handler effect has `replayComplete` in its deps. After `connectLazy()` writes replay chunks and calls `setReplayComplete(true)`, React re-renders and the output handler re-runs, subscribing to `shell.onOutput()`. By this time `shell.pty` is the finalized `PtyConnection` (from `ensurePty()`).

#### Behavior comparison

| Scenario | Before | After |
|----------|--------|-------|
| Reload with 10 tabs | 10 PTY connections simultaneously | 1 PTY connection (active tab only) |
| Switch to inactive tab | Instant (PTY already running) | One `attach`+`start` on first switch, instant thereafter |
| Switch back | Instant | Instant (`pty.started` guard) |
| All control logic | Scattered across TSX refs | `Shell._hasEverBeenActive` + `Shell.connectLazy()` |

#### TSX refs removed

The following refs were in `InteractiveTerminal.tsx` and moved into the SDK:
- `sinceSeqRef` → internal to `connectLazy()` (always resets to 0 for full replay)
- `ptyOwnedByUsRef` → replaced by `shell.pty?.started` guard in `connectLazy()`
- `reattachBufferRef` → replaced by `liveBuffer` inside `connectLazy()`

### 6.6 Entity Relationships

```
AgenticProcess
  ├── pty_pid ────→ ShellSession (frontend)
  │                         └── maps to PtyState (backend)
  ├── worker_session_id ──→ Claude CLI session (survives PTY restarts)
  └── compute_node_id ───→ ComputeNode
                             └── active_pty_sessions: [session_id, ...]
```

---

## 7. Terminal Resize — Three-Layer Alignment

Three layers must agree on terminal dimensions for correct rendering:

### 7.1 Layer 1: CSS Layout (pixel size)

```
TabbedTerminal (flex-col, h-full)
  └─ tab bar (fixed height)
  └─ terminal-panels (flex-1 overflow-hidden)
       └─ InteractiveTerminal (h-full, flex-col)
            └─ ProcessToolbar (if present, fixed height)
            └─ xterm container div (flex-1 min-h-0)  ← MEASURED ELEMENT
```

The xterm container gets whatever pixel space remains after the tab bar and toolbar. `flex-1 min-h-0` makes it fill remaining space without overflowing.

### 7.2 Layer 2: FitAddon (pixels → cols/rows)

xterm.js's `FitAddon` measures the container's pixel dimensions, divides by the character cell size (based on font size/family), and calls `term.resize(cols, rows)` to set the grid dimensions.

**Trigger points** (with line references in InteractiveTerminal.tsx):

| Trigger | When | Why |
|---------|------|-----|
| Init (~line 253) | `fit.fit()` after 50ms delay once xterm mounted | Initial sizing |
| ResizeObserver (~line 554) | Container div changes pixel size | Window/panel resize |
| Tab activation (~line 588) | `requestAnimationFrame` when tab becomes active | Tab was `display:none`, needs remeasure |
| Post-PTY-start (~line 431) | After PTY connects | Corrects fallback 80x24 to actual size |

### 7.3 Layer 3: Backend PTY resize (cols/rows → OS pseudoterminal)

After FitAddon updates xterm's cols/rows, `handlePtyResize` sends the new dimensions to the backend:

```
InteractiveTerminal.handlePtyResize(cols, rows)
  → shellManager.resizePty(sessionId, cols, rows)
    → WebSocket: POST terminal-command/resize { session_id, cols, rows }
      → ComputeNode._resize_pty()
        → local_compute_provider.resize_pty(node_id, session_id, cols, rows)
          → process.setwinsize(rows, cols)   ← OS-level pty resize (SIGWINCH)
```

The OS PTY sends `SIGWINCH` to the running shell process (bash/zsh/claude), which queries the new window size and redraws accordingly.

### 7.4 Debouncing

The `ResizeObserver` calls `fit.fit()` **immediately** (so xterm reflows text instantly), but the **backend resize is debounced by 250ms** (`resizeTimeoutRef`). This avoids flooding the WebSocket during a window drag-resize — only the final size gets sent to the backend.

### 7.5 Initial Size & Correction

When `startPty` is first called (~line 422), it passes `terminalRef.current.cols || 80` and `rows || 24`. If the terminal hasn't been fitted yet, it falls back to 80x24. The **post-PTY-start fit** (~line 428-441) corrects the backend to match the actual visible size.

### 7.6 Transition Guard

`isTransitioningRef` prevents resize operations during the **150ms** after `sessionId` changes. This avoids stale resize calls hitting the wrong session.

### 7.7 Backend Resize Optimization

```python
# compute_node.py lines 1335-1344
if session.cols == cols and session.rows == rows:
    return  # Skip — no SIGWINCH
```

Prevents unnecessary `SIGWINCH` signals that cause zsh to redraw with `%` artifacts, particularly noticeable during reattach.

### 7.8 Dimension Defaults

| Parameter | Default | Source |
|-----------|---------|--------|
| `cols` | 80 | Backend fallback if not provided |
| `rows` | 24 | Backend fallback if not provided |

Actual values are computed by `FitAddon.fit()` based on container pixel dimensions and font metrics (cell width/height).

---

## 8. PTY Process Layer

### 8.1 Shell Selection

| Platform | Shell |
|----------|-------|
| macOS | `/bin/zsh` |
| Linux | `/bin/bash` (fallback: `/bin/sh`) |
| Windows | PowerShell 7 → powershell.exe → cmd.exe |
| Custom | `$SHELL` environment variable |

### 8.2 Environment Setup

```python
env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
env["TERM"] = "xterm-256color"
env["FLOWPAD_PTY_SESSION_ID"] = session_id
```

### 8.3 Cross-Platform PTY Libraries

| Platform | Library | I/O Types |
|----------|---------|-----------|
| Unix/macOS | `ptyprocess.PtyProcess` | bytes in, bytes out |
| Windows | `winpty.PtyProcess` | str in, str out |

### 8.4 Output Read Thread

- Daemon thread (`daemon=True`) per PTY session
- Non-blocking reads: `process.read(1024)`
- Handles `EOFError` (PTY closed) and process death
- Calls `on_output(data_bytes)` for each chunk
- Calls `on_exit(exit_code)` when process terminates
- Cross-platform normalization: winpty returns str → encoded to bytes

### 8.5 Initial Command Injection

For `initial_command` (e.g., `claude --session-id xxx`):

1. Wrap output callback to detect first output (shell prompt ready)
2. Spawn background thread waiting on `prompt_ready` event
3. On signal: wait 100ms grace period, then write `{command}\r`
4. Timeout: 5 seconds

---

## 9. Key Files Index

| File | Layer | Purpose |
|------|-------|---------|
| `flow_sdk/compute/providers/local_compute_provider.py` | Backend | PTY spawn, read, write, resize, cross-platform |
| `flow_sdk/builtin/faas/compute_node.py` | Backend | REST action handlers, output routing, session coordination |
| `flow_sdk/builtin/faas/pty_session_manager.py` | Backend | Session lifecycle, TTL cleanup, connection tracking |
| `flow_sdk/compute/providers/desktop/pty_stream_file.py` | Backend | Framed on-disk stream: output(+seq)/resize frames, rolling truncation (§10) |
| `flow_sdk/compute/providers/base_pty_session.py` | Backend | Pty handle: resize/repaint + resize-frame recording (incl. jiggle flips) |
| `flow_sdk/server/routes/pty_stream.py` | Backend | `GET /api/v1/shell/{id}/pty-stream` — serves the framed stream (§13) |
| `ui/src/components/terminal/interactive-terminal/pty-replay.ts` | Frontend | Attach-time replay: headless xterm + SerializeAddon at recorded sizes |
| `flow_sdk/api/messages.py` | Backend | PtyOutputMessage, PtySessionStatusMessage definitions |
| `flow_sdk/builtin/agentic_processor.py` | Backend | start-pty, resume-pty, kill-pty actions |
| `server/routes/websocket.py` | Transport | WebSocket endpoint, connection management, message routing |
| `server/routes/ws_rest.py` | Transport | REST-over-WebSocket message handling |
| `ts_sdk/src/websocket.ts` | Transport | Client WebSocket, reconnection, message dispatch |
| `ts_sdk/src/services/shell/shellManager.ts` | Frontend SDK | Session CRUD, PTY commands, output routing, orphan buffer |
| `ts_sdk/src/services/shell/shellSession.ts` | Frontend SDK | Session state, PTY data listeners, persistence |
| `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` | Frontend UI | xterm.js integration, resize, reattach, input/output |
| `ui/src/components/terminal/TabbedTerminal.tsx` | Frontend UI | Multi-tab management, session creation, Claude CLI injection |
| `ui/src/components/process-terminal/ProcessTerminal.tsx` | Frontend UI | AgenticProcess → TabbedTerminal binding |
| `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` | Frontend UI | CLI flag toggles, restart overlay |
| `ui/src/hooks/use-shell.ts` | Frontend | React hooks for shell state (useShell, useShellSession) |
| `ui/src/store/use-terminal-state-store.ts` | Frontend | Zustand store for active session ID |

---

## 10. PTY Stream File Persistence (framed)

Each PTY session persists its output to a `.pty` file on disk via
`PtyStreamFile` (`flow_sdk/compute/providers/desktop/pty_stream_file.py`).
The file is the source for attach-time history replay (§13) and survives
server restarts.

### 10.1 Storage

```
~/.flow/instances/<name>/records_data/shell/shell-@<uid>/<pty_pid>.pty
```

### 10.2 Format — framed JSONL

Raw-byte logs cannot be replayed safely (see §13.2), so the file is a framed
JSONL stream: one JSON value per line.

```
{"v": 1, "cols": 100, "rows": 30}      ← header: format version + initial size
["o", "<base64 output chunk>", 42]      ← output frame (one PTY read) + seq
["r", [80, 24]]                         ← resize frame (cols, rows)
```

- **Output frames** carry the same per-session `seq` as the WS
  `pty_output_msg` chunks — replaying clients dedup against buffered live
  chunks by seq.
- **Resize frames** are appended for every actual winsize change, at their
  exact stream position: `PtySession.resize()` and **both** flips of the
  `force_repaint()` jiggle (output emitted between the flips is calibrated to
  the transient size and must be reinterpreted at it).
- **Legacy detection**: files not starting with `{` are pre-framing raw bytes,
  surfaced as `v: 0` with unknown size; the client skips replay for them
  (replaying at a guessed width is exactly the garble this design removes).

### 10.3 Rolling truncation — frame boundaries only

When the file exceeds `max_size_bytes` (default 10 MB) it is compacted to 75%
by dropping **whole frames** from the front — never splitting an escape
sequence mid-byte. The header is rewritten to the winsize in effect at the
first retained frame (resize frames folded in as they are dropped). A torn
final line (crash mid-write) is dropped by the reader. The writer caches the
file size in memory, so the hot output path performs no `stat()` per chunk.

### 10.4 Lifecycle

- **Created**: lazily on first write (header + first frame).
- **Written**: every `on_pty_output` chunk (PTY read thread) and every resize
  (event loop) — a small lock prevents torn lines across the two writers.
- **Deleted**: when the session is closed.
- **Recovered**: after a server restart the file still serves full history to
  reattaching clients; the shell record recovery (§11) respawns the PTY.
- Each refresh appends the attach-repaint output (a few rows), so the file
  grows slowly with refresh count — bounded by the rolling cap.

## 11. Shell Session Recovery

On server restart, sessions that were running before the shutdown need to be recovered. The recovery flow is triggered during bootstrap, after the local `ComputeNode` is created.

### 11.1 Recovery Flow

1. `ComputeNode.recover_shell_sessions()` is called from the bootstrap endpoint.
2. It delegates to `scan_for_recovery()` which finds all `ShellSessionRecord`s with `status == RUNNING`.
3. For each record:
   - If the `workdir` path no longer exists, the record is marked `CLOSED`.
   - Otherwise, `start_machine_pty_session()` is called with the original `session_id` and `connection_id=None` (no WebSocket client yet).
   - On success, the record's `last_active_at` is updated via `touch()`.
   - On failure (exception), the record is marked `CLOSED`.
4. The function returns the count of successfully recovered sessions.

### 11.2 Design Decisions

- Recovery uses the original `session_id` so frontend clients can reconnect seamlessly.
- `connection_id=None` is passed because no WebSocket client is attached at recovery time; clients attach later via the normal attach flow.
- Recovery is triggered from bootstrap (not `server.on_startup()`) to ensure all entities are initialized first.

## 12. Shell Session Record Lifecycle

`ShellSessionRecord` tracks the full lifecycle of a shell session on disk. The record is created when a PTY is started and transitions through states until closed.

### 12.1 State Machine

```
start_machine_pty_session()
  → Create ShellSessionRecord(state=RUNNING)
  → Create PtyStreamFile at record's pty_stream_path
  → Store PtyStreamFile on PtyState.pty_stream_file

on_pty_output()
  → PtyStreamFile.write(data)  (if pty_stream_file is set)

close_session()
  → Record state → CLOSED
  → PtyStreamFile.delete()
  → Remove PtyState from pty_registry

```

### 12.2 API Endpoints

| Action | Method | Purpose |
|--------|--------|---------|
| `list-shell-sessions` | GET | List all ShellSessionRecords on disk |
| `get-shell-session` | GET | Get a single record by `session_id` query param |
| `update-shell-session` | POST | Update mutable fields: `name`, `is_visible`, `tab_order` |

---

## 13. Attach-Time History Replay

Restores **full terminal scrollback on page refresh / reattach** without
garbling, even across resizes. Replaces the removed raw-byte
`PtyReplayBuffer` (`4466d9bc`). Design validated by a fuzz matrix before
implementation — see §13.5.

### 13.1 Architecture

```
            RECORD (server, always-on)                REPLAY (client, on attach)
┌────────────────────────────────────────┐   ┌─────────────────────────────────────────┐
│ on_pty_output(data)                    │   │ GET /api/v1/shell/{pty_id}/pty-stream   │
│   seq = session.next_seq()             │   │   → {v, cols, rows, events[]}           │
│   PtyStreamFile.write(data, seq)  ──┐  │   │ replayPtyStream():                      │
│                                     │  │   │   headless xterm @ header size          │
│ PtySession.resize(c, r)             │  │   │   for each frame:                       │
│   provider.resize_pty(...)          │  │   │     "o" → write(streaming-decoded text) │
│   PtyStreamFile.write_resize(c, r) ─┤  │   │     "r" → await flush; term.resize(c,r) │
│                                     │  │   │   SerializeAddon.serialize()            │
│ force_repaint() jiggle (both flips)─┘  │   │ visible xterm: reset() → write(serial)  │
│                                        │   │ write live chunks with seq > lastSeq    │
│         <pty_pid>.pty (framed JSONL,   │   │ shell.resize(real dims) → TUI repaints  │
│          10MB rolling, §10)            │   │ subscribe live output                   │
└────────────────────────────────────────┘   └─────────────────────────────────────────┘
```

This is the industry pattern (VS Code's pty-host runs `@xterm/headless` +
SerializeAddon; tmux/zellij keep a server-side grid): **never replay raw
bytes — interpret them once in a terminal emulator at the sizes they were
emitted for, then serialize the resulting state.** Flowpad runs the emulator
client-side (in the page) instead of server-side: the framed file preserves
everything needed, and the browser already ships the exact same xterm engine
as the visible terminal.

### 13.2 Why raw replay garbles (the removed design)

PTY output is calibrated to the winsize at emission time. ink/React TUIs
(Claude Code) repaint by cursor-up-N + erase-line + reprint; with a different
width, lines wrap differently, the cursor-relative moves land on the wrong
rows, and the screen smears. The same bytes are only meaningful at the
recorded size — hence resize frames at exact stream positions, and replay in
an emulator that honors them. xterm reflow then converges the final state:
content written at width A and reflowed to B equals content written at B.

### 13.3 Non-negotiable disciplines (fuzz-derived)

1. **Decode bytes → string with a streaming `TextDecoder` before
   `term.write()`** — never feed re-chunked raw `Uint8Array`s. xterm.js's own
   binary input path silently DROPS a 3-byte UTF-8 char whose trailing bytes
   arrive in a separate `write()` (`[E2 80][94]` → em-dash lost; `—`, `›`,
   `…`, and emoji-ZWJ are all `E2 80 xx`). The live WS path
   (`ptyConnection.appendOutput`) already does this; the replayer must too.
2. **Flush queued writes before every resize** — xterm's write queue is
   async; a resize that overtakes queued output reinterprets it at the wrong
   width.
3. **Record every actual winsize change**, including both repaint-jiggle
   flips.
4. **Preserve recorded chunk boundaries** in the framed file; dedup
   replay-vs-live by the shared seq.
5. The stream endpoint returns the standard `ApiSuccessResponse` envelope —
   the ts_sdk axios interceptor unwraps `response.data.data`; bare JSON
   silently breaks the client.

### 13.4 Known upstream issues (with repros)

| Issue | Impact | Workaround | Repro / link |
|-------|--------|------------|--------------|
| xterm.js drops a multi-byte UTF-8 char when a `write(Uint8Array)` split leaves a `0x80` continuation byte in interim decoder state (`Utf8ToUtf32.decode` counts interim bytes by value-truthiness; `0x80 & 0x3F === 0`) | chars like `—` `›` ZWJ vanish at unlucky chunk boundaries | string-decode discipline (§13.3.1) | [xtermjs/xterm.js#6003](https://github.com/xtermjs/xterm.js/issues/6003) · `tests/pty_fuzz/xterm-utf8-split-repro.mjs` |
| `@xterm/headless` 6.0.0 declares `module: lib/xterm.mjs` but ships `lib-headless/xterm-headless.mjs` — bundlers preferring `module` (Vite) cannot resolve the package | frontend build fails | vite alias in `ui/vite.config.ts` pointing at the shipped `.mjs` | `tests/pty_fuzz/xterm-headless-module-entry-repro.mjs` |
| `SerializeAddon` loses the leading blank cells of a wrapped continuation row (+1 adjacent cell at exact-fit boundaries); such rows arise from reflow gaps when a resize lands mid-soft-wrapped-line | rare cosmetic loss inside one historical wrapped line | none (bounded-loss oracle documents it in `pty-replay-production.test.ts`) | `tests/pty_fuzz/serialize-wrapped-blank-repro.mjs` |

### 13.5 Validation

- **Theory matrix** (`ui/tests/unit/pty-replay-equivalence.test.ts`):
  17 bash content strategies × 6 resize schedules × 6 chunk-split schedules +
  serialize→restore + negative controls + 3×3MB real Claude session streams —
  759/759. Negative control reproduces the old garble on demand (naive
  different-width replay diverges for every width-exercising strategy).
- **Production matrix** (`ui/tests/unit/pty-replay-production.test.ts`):
  fixtures recorded through the real `PtyStreamFile` writer (incl. 64KB-cap
  truncation set), replayed through the real `replayPtyStream()` — 123/123.
- **Backend** (`tests/unit/test_pty_stream_file.py`,
  `tests/api/test_pty_stream_endpoint.py`): framed format, frame-boundary
  truncation, header rewrite, legacy/torn-line handling, resize-frame
  ordering through the real HTTP API.
- **Fuzzer**: generators + recorder + axes documented in
  `tests/pty_fuzz/README.md` (`strategies.sh`, `record_streams.py`
  `--production` mode).
- **Live e2e** (debugMCP, isolated `instance_ctl` instance): 5,024px of
  adversarial scrollback + 2 mid-history resizes survives refresh pixel-clean
  (pre-replay behavior: 624px live frame only); typing/live-stream/restart
  all functional after replay; refreshes idempotent.

### 13.6 Refresh vs Restart — two recovery paths

| | Refresh (attach replay) | Restart session |
|---|---|---|
| Mechanism | framed-stream replay (§13.1) | kill PTY + respawn `claude --resume <session_id>` |
| Source | `<pty_pid>.pty` (exact bytes, recorded sizes) | Claude's session transcript (`.jsonl`) |
| Live process | untouched | restarted |
| Depth | 10MB rolling window | full conversation re-render |
| Use | every reattach, automatic | deep fallback (stream truncated/lost, legacy v0 session) |

