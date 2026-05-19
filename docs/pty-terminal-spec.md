---
id: f167e843-4f52-5252-8a2c-fae98ce44479
---

# PTY / xterm Terminal System Specification

## Overview

The terminal system provides interactive PTY (pseudo-terminal) sessions in the browser via xterm.js. It spans four layers: **PTY process** (OS-level), **backend session management** (Python/FastAPI), **WebSocket transport**, and **frontend rendering** (React/xterm.js). Sessions survive page refreshes via replay buffers and sequence-based reattachment.

---

## 1. End-to-End Data Flow

### 1.1 Output Path (Backend → Frontend)

```
OS PTY fd (raw bytes)
  → daemon read_thread (1024-byte reads)
  → on_output callback
  → PtyReplayBuffer.append() assigns monotonic seq number
  → PtyOutputMessage.from_bytes() base64-encodes data
  → WebSocket send to all attached connection_ids
  → ConnectionManager dispatches 'pty_output_msg'
  → ShellManager.handlePtyOutputMsg()
      - atob() → Uint8Array → TextDecoder({ stream: true }) → string
      - routes to ShellSession.appendPtyOutput(data, seq)
  → InteractiveTerminal onPtyData listener
      - if reattaching: push to reattachBufferRef[]
      - else: term.write(data)
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
| read_thread → replay buffer | Raw bytes (`OutputChunk.data`) |
| replay buffer → WebSocket | Base64 string in JSON (`PtyOutputMessage.data`) |
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

Multiple browser tabs/windows can attach to the same PTY session simultaneously — each gets its own `connection_id` in the session's `connection_ids` set.

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
| `attach` | `session_id`, `since_seq?` | Replay chunks + `{ status: "reattached", latest_seq, replay_truncated }` | Reattach after refresh |
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
  "replay_truncated": false,
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

#### PtySessionState (in-memory, `pty_session_manager.py`)

```python
class PtySessionState:
    pty_key: tuple                    # (compute_node_id, provider_node_id, session_id)
    connection_ids: set[str]          # All attached WebSocket connections
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

#### Replay Buffer (in-memory, `pty_replay_buffer.py`)

Per-session circular buffer:

```python
class SessionBuffer:
    chunks: Deque[OutputChunk]    # Circular deque of output chunks
    total_size_bytes: int         # Tracked for eviction
    next_seq: int                 # Next sequence number to assign

class OutputChunk:
    seq: int                      # Monotonic sequence number
    data: bytes                   # Raw PTY output
    timestamp: float              # Unix timestamp
```

**Limits**: 2MB max per session, 5000 chunks max. Evicts oldest when exceeded (never evicts last chunk).

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

### 4.5 TTL Cleanup (Backend)

Background task runs every **120 seconds**, closing sessions detached for > **900 seconds** (15 min):

```python
session_manager.start_cleanup_task(interval_seconds=120, ttl_seconds=900)
```

A session is "detached" when its `connection_ids` set is empty (all WebSocket clients disconnected).

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
2. session.ptyStarted=true (from entity/persistence) but ptyOwnedByUs=false
3. connectPty() detects reattach needed
4. reattachBufferRef = []  ← start buffering live output
5. shellManager.reattachSessionFromServer(sessionId, sinceSeq)
6. Backend: snapshot replay buffer BEFORE attaching connection
7. Backend: attach connection → live output starts flowing
8. Backend: send replay chunks (seq > sinceSeq) as pty_output_msg
9. Backend: send pty_session_status_msg { status: "reattached", latest_seq }
10. Frontend: replay chunks arrive → buffered in reattachBufferRef
11. Frontend: live chunks also arrive → also buffered
12. Frontend: flush complete → write all buffered data to xterm at once
13. reattachBufferRef = null  ← stop buffering, direct write mode
14. ptyOwnedByUsRef = true
```

**Race condition prevention**: Replay buffer is snapshotted BEFORE the connection is attached. This ensures replay chunks have lower seq numbers than live output, maintaining ordering.

### 5.3 Sequence Number Deduplication

Both backend and frontend track sequence numbers:

- **Backend**: `last_seq_received` on `PtySessionState`
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
  │                         └── maps to PtySessionState (backend)
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
| `flow_sdk/builtin/faas/pty_replay_buffer.py` | Backend | Circular output buffer (2MB/5000 chunks per session) |
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
| `flow_sdk/builtin/faas/pty_stream_file.py` | Backend | Rolling file buffer for PTY output persistence |

---

## 10. PTY Stream File Persistence

Each PTY session can optionally persist its raw output to a `.pty` file on disk via `PtyStreamFile`. This enables recovery of terminal history after a server restart.

### 10.1 Storage

Files are stored at:
```
~/.flow/records/shell_session/<shell_session>-@<uid>/<pty_pid>.pty
```

### 10.2 Rolling Buffer Strategy

`PtyStreamFile` appends every PTY output chunk to the file. When the file exceeds `max_size_bytes` (default 10 MB), the oldest data is discarded: the last `max_size_bytes` bytes are read and the file is rewritten with only that tail. This bounds disk usage per session while retaining recent history.

### 10.3 Lifecycle

- **Created**: On first PTY output write (lazy — no file until data arrives).
- **Written**: Each `on_pty_output` callback appends to the file.
- **Deleted**: When the session is closed (`ShellSession.close()` or `PtySessionManager.close_session()`).
- **Recovered**: On server restart, the `.pty` file provides terminal history for sessions that were running before the crash.

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
  → Store PtyStreamFile on PtySessionState.pty_stream_file

on_pty_output()
  → PtyStreamFile.write(data)  (if pty_stream_file is set)

close_session()
  → Record state → CLOSED
  → PtyStreamFile.delete()
  → Remove PtySessionState from session_manager

```

### 12.2 API Endpoints

| Action | Method | Purpose |
|--------|--------|---------|
| `list-shell-sessions` | GET | List all ShellSessionRecords on disk |
| `get-shell-session` | GET | Get a single record by `session_id` query param |
| `update-shell-session` | POST | Update mutable fields: `name`, `is_visible`, `tab_order` |
