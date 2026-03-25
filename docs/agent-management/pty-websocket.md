# PTY Layers, WebSocket Transport, and Reconnection

Reference for the PTY system stack, WebSocket protocol, replay buffer, sequence numbers, input/output encoding, and reconnection mechanics. This document focuses on the transport and session-recovery concerns. For overall AgenticProcess architecture and status derivation from transcripts, see `docs/agentic-process.md`.

---

## Table of Contents

1. [PTY Layer Stack](#1-pty-layer-stack)
2. [WebSocket Transport](#2-websocket-transport)
3. [Message Formats](#3-message-formats)
4. [Output Encoding](#4-output-encoding)
5. [Input Encoding](#5-input-encoding)
6. [Replay Buffer](#6-replay-buffer)
7. [Sequence Numbers](#7-sequence-numbers)
8. [Reconnection and Reattach](#8-reconnection-and-reattach)
9. [Error Handling](#9-error-handling)
10. [Key Files Index](#10-key-files-index)

---

## 1. PTY Layer Stack

Five layers sit between the kernel PTY and the pixels rendered in the browser. Each layer has a single responsibility.

```
Layer 5: xterm.js (Browser DOM)
         Renders ANSI/VT sequences. Fires term.onData() on keystrokes.
         ↕
Layer 4: ShellManager / ShellSession (TypeScript SDK)
         Decodes base64 output, routes to sessions, owns TextDecoder
         instances, enforces sequence deduplication.
         ↕
Layer 3: WebSocket / REST-over-WS (Transport)
         JSON text frames for output push. REST-over-WS for input,
         resize, attach, and control commands.
         ↕
Layer 2: PtySessionManager + PtyReplayBuffer (Backend in-memory)
         Tracks attached connection IDs per session. Stores output
         chunks with monotonic sequence numbers. TTL cleanup task.
         ↕
Layer 1: OS PTY (ptyprocess / winpty)
         Daemon read thread at 1024-byte granularity. Writes to PTY
         stdin on input. Sends SIGWINCH on resize.
```

### Layer 1: OS PTY Process

The backend spawns a real OS process via a pseudo-terminal.

- **macOS/Linux**: `ptyprocess.PtyProcess.spawn()` — bytes in, bytes out
- **Windows**: `winpty.PtyProcess.spawn()` — str in, str out (normalized to bytes)
- Shell selection: `/bin/zsh` (macOS), `/bin/bash` or `/bin/sh` (Linux), PowerShell 7 / cmd.exe (Windows), `$SHELL` if set
- A **daemon thread** per session calls `process.read(1024)` in a blocking loop and invokes `on_output(data_bytes)` for each chunk
- On exit, `on_exit(exit_code)` is scheduled on the async event loop via `asyncio.run_coroutine_threadsafe()`
- Source: `flow_sdk/compute/providers/local_compute_provider.py`

### Layer 2: Backend In-Memory State

Two singletons hold ephemeral state. Neither survives a server restart.

**PtySessionManager** (`flow_sdk/builtin/faas/pty_session_manager.py`):

Tracks which WebSocket `connection_id` values are attached to which PTY sessions.

```python
class PtySessionState:
    pty_key: tuple                    # (compute_node_id, provider_node_id, session_id)
    connection_ids: set[str]          # All attached WebSocket connection IDs
    cols: int
    rows: int
    name: str | None
    last_seq_received: int
    created_at: float
    last_detached_at: float | None    # None when currently attached
```

**PtyReplayBuffer** (`flow_sdk/builtin/faas/pty_replay_buffer.py`):

Circular buffer of recent output per session. Limits: **2 MB** and **5,000 chunks** per session. When exceeded, oldest chunks are evicted. The last chunk is never evicted.

```python
class OutputChunk:
    seq: int        # Monotonic sequence number (starts at 1)
    data: bytes     # Raw PTY output
    timestamp: float
```

**TTL cleanup**: Background asyncio task runs every **120 seconds**. Sessions fully detached (no WebSocket connections) for more than **900 seconds** (15 minutes) are killed and removed.

### Layer 3: WebSocket / REST-over-WS Transport

A single persistent WebSocket connection per browser tab carries all PTY sessions for a ComputeNode. The connection ID is a client-generated UUID embedded in the URL. See [Section 2](#2-websocket-transport) for full details.

### Layer 4: ShellManager and ShellSession (TypeScript SDK)

`ShellManager` (`ts_sdk/src/services/shell/shellManager.ts`) is a singleton coordinator:

- Registers a single `on_pty_output_msg` listener on `ConnectionManager`
- Decodes base64 output to UTF-8 (once, using per-session `TextDecoder` with `{ stream: true }`)
- Routes decoded output to `ShellSession.appendPtyOutput(data, seq)`
- Maintains an orphan buffer for output arriving before a session is locally registered (max 200 chunks per session, 5 MB total, 30 s max age)
- On node change, all buffers are cleared

`ShellSession` (`ts_sdk/src/services/shell/shellSession.ts`) is a per-tab object:

- Holds `lastSeqReceived` for deduplication
- Exposes `onPtyData(listener): () => void` — xterm.js subscribes here
- `appendPtyOutput(data, seq)`: drops duplicates (seq <= lastSeqReceived), then calls all listeners

Persistence in `localStorage` under key `pty_session_{sessionId}`: stores `cols`, `rows`, `lastSeqReceived`, `computeNodeId`, `lastAttachedAt`. Used on page refresh to pass `since_seq` to the attach operation.

### Layer 5: xterm.js (Browser)

`InteractiveTerminal.tsx` creates an xterm.js instance per session:

- All tabs stay **mounted** (`display: none` when inactive) to avoid PTY data loss on tab switches
- `FitAddon` auto-sizes the grid from container pixel dimensions
- `WebLinksAddon` makes URLs clickable
- `term.write(data)` receives decoded UTF-8 strings from the `onPtyData` listener
- Three CSI handler intercepts prevent xterm auto-reply loops:

```typescript
term.parser.registerCsiHandler({ final: 'c', prefix: '?' }, () => true); // Device Attributes
term.parser.registerCsiHandler({ final: 'I' }, () => true);               // Focus In
term.parser.registerCsiHandler({ final: 'O' }, () => true);               // Focus Out
```

---

## 2. WebSocket Transport

### Endpoint

```
ws://localhost:9007/api/v1/connect/ws/{connection_id}
```

- `connection_id`: client-generated UUID (`uuidv4()` in `ConnectionManager`)
- The URL path is constructed as `${config.SERVER_URL}${config.API_PREFIXES.connect}/${this.id}`
- `http://` is converted to `ws://` and `https://` to `wss://` before connecting
- `socket.binaryType = 'arraybuffer'` is set on connect

### Connection Lifecycle

```
Client                                     Server
  |                                           |
  |--- new WebSocket(ws://…/{id}) ----------->|
  |<-- accept + confirmation response_msg ----|
  |                                           |
  |   (bidirectional message exchange)        |
  |                                           |
  |--- { message_type: "hangup" } ----------->|  (clean close)
  |                                           |
  |   OR: server closes (error/restart)       |
  |<-- WebSocketDisconnect -------------------|
```

On connect the server:
1. Accepts the WebSocket
2. Stores `connection_id -> WebSocket` in `_active_connections`
3. Registers the connection in the SDK connection registry via `add_registry_connection()`
4. Sends a confirmation message:

```json
{
  "message_type": "response_msg",
  "message_id": "<uuid>",
  "status": "ok",
  "data": {
    "connection_id": "<id>",
    "message": "Connected to minihub WebSocket server"
  }
}
```

On disconnect the server removes the connection from `_active_connections`, calls `remove_registry_connection()`, and runs `cleanup_connection()` to remove all entity watches registered by that connection.

### Multiplexing

All PTY sessions for a ComputeNode share the single WebSocket connection. Messages are demultiplexed by `session_id`. Multiple browser tabs can attach to the same PTY session simultaneously — each tab has its own `connection_id` in the session's `connection_ids` set and receives identical output.

```
WebSocket /api/v1/connect/ws/{connection_id}
  ├── session_id: "shell-1709..." → xterm.js Tab 1
  ├── session_id: "shell-1709..." → xterm.js Tab 2
  └── session_id: "shell-1709..." → xterm.js Tab 3
```

### Frame Types

| Frame type | Encoding | Used for |
|-----------|----------|---------|
| Text | JSON | All control messages, PTY output, entity notifications |
| Binary | msgpack | `stream_msg` binary data transfer (stub in desktop mode) |

The `ConnectionManager` in the TypeScript SDK dispatches on `message_type`:

```
pty_output_msg   → onPtyOutputMessage() → emit 'on_pty_output_msg'
data_op_msg      → onDataOpMessage()    → emit 'on_data_op'
response_msg     → onResponseMessage()  → resolve/reject pending request
flow_data_msg    → onFlowDataMessage()  → emit 'on_flow_data'
llm_config_msg   → onLlmConfigMessage() → emit 'on_llm_config_msg'
transcript_msg   → onStreamMessage()    → emit 'on_stream_msg'
control_msg      → onControlMessage()   → emit 'on_control_msg'
oauth_msg        → onOAuthMessage()     → emit 'on_oauth_msg'
```

### REST-over-WebSocket (Terminal Commands)

Terminal operations are not HTTP POST requests — they travel as `rest_api_msg` frames over the WebSocket. `ConnectionManager.sendRestApiMessage()` sends the message and resolves a Promise when the matching `response_msg` arrives (30 s timeout).

URL pattern for terminal operations:
```
POST /api/v1/graph/compute_node/{compute_node_id}/terminal-command/{operation}
```

Encoded as a WebSocket frame:

```json
{
  "message_type": "rest_api_msg",
  "message_id": "<uuid>",
  "method": "POST",
  "scope": [{ "type": "ComputeNode", "id": "{compute_node_id}" }],
  "action": "terminal-command",
  "sub_path": "{operation}",
  "body": { ... }
}
```

Available operations:

| Operation | Body fields | Response |
|-----------|------------|---------|
| `start` | `session_id`, `cols`, `rows`, `name?`, `working_dir?`, `initial_command?` | `{ status: "connected" }` |
| `attach` | `session_id`, `since_seq?` | `{ status: "reattached", latest_seq, replay_truncated }` |
| `input` | `session_id`, `data` | `{ status: "ok" }` |
| `resize` | `session_id`, `cols`, `rows` | `{ status: "ok" }` |
| `close` | `session_id` | `{ status: "ok" }` |
| `list` | (none) | `{ sessions: [{ session_id, name }] }` |
| `rename` | `session_id`, `name` | `{ status: "ok" }` |

---

## 3. Message Formats

### PTY Output Message (Server → Client)

```json
{
  "message_type": "pty_output_msg",
  "message_id": "<uuid>",
  "provider_node_id": "local-machine",
  "session_id": "shell-1709...",
  "data": "G1szMm0kIGxzIC1sYQ==",
  "seq": 42
}
```

- `data`: Base64-encoded raw PTY bytes
- `seq`: Monotonic integer, starts at 1, assigned by `PtyReplayBuffer.append()`

### PTY Session Status Message (Server → Client)

Sent after `start` and `attach` operations.

```json
{
  "message_type": "pty_session_status_msg",
  "message_id": "<uuid>",
  "session_id": "shell-1709...",
  "status": "reattached",
  "replay_truncated": false,
  "latest_seq": 42
}
```

`status` values:

| Value | Meaning |
|-------|---------|
| `"connected"` | New PTY session started |
| `"reattached"` | Existing session reattached after disconnect |
| `"not_found"` | No session with this ID exists on backend |
| `"expired"` | Session existed but was cleaned up by TTL |

### Data Operation Message (Entity Updates)

Sent when PTY-related entity fields change (e.g., `active_pty_sessions` on ComputeNode).

```json
{
  "message_type": "data_op_msg",
  "message_id": "<uuid>",
  "to_entity": "compute_node-{id}",
  "op": "update",
  "data": { "active_pty_sessions": ["shell-1", "shell-2"] }
}
```

`op` is `"create"`, `"update"`, or `"delete"`. Creates are broadcast to all connections; updates and deletes are sent only to connections that have called `watch` on that entity.

### Response Message (Server → Client)

Wraps the result of every `rest_api_msg`.

```json
{
  "message_type": "response_msg",
  "message_id": "<uuid>",
  "response_message_id": "{original_request_message_id}",
  "content": { "status": "connected", "latest_seq": 42 },
  "error": null
}
```

If `error` is non-null, the TypeScript SDK rejects the pending Promise. If `response_message_id` has no matching pending request, the message is discarded (or re-dispatched if the content is itself a `pty_output_msg`).

---

## 4. Output Encoding

PTY output passes through three encoding stages from the kernel to xterm.js.

### Stage 1: Backend — raw bytes to base64

The daemon read thread produces raw bytes. `PtyOutputMessage.from_bytes()` base64-encodes them before wrapping in JSON:

```python
# Conceptual — actual in flow_sdk/api/messages.py
{
    "data": base64.b64encode(raw_bytes).decode("ascii")
}
```

Why base64? PTY output can contain arbitrary binary data — ANSI escape sequences, box-drawing characters, binary tool output. Base64 guarantees safe transport in JSON text frames with ~33% size overhead.

### Stage 2: Transport — JSON text frame

The JSON message is sent as a WebSocket text frame. No additional encoding is applied.

### Stage 3: Frontend — base64 to UTF-8 string

`ShellManager.handlePtyOutputMsg()` decodes the message:

```typescript
const binaryString = atob(msg.data);                         // base64 → binary string
const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));  // binary string → bytes
let decoder = this.ptyDecoders.get(sessionId);               // per-session decoder
if (!decoder) {
  decoder = new TextDecoder('utf-8');
  this.ptyDecoders.set(sessionId, decoder);
}
decoded = decoder.decode(bytes, { stream: true });           // bytes → UTF-8 string
```

Why `{ stream: true }` on `TextDecoder`? Multi-byte UTF-8 characters (e.g., the box-drawing character `─` is 3 bytes: `0xE2 0x94 0x80`) can be split across WebSocket message boundaries. Without `stream: true`, the incomplete sequence is replaced with `U+FFFD` (replacement character `\uFFFD`). With `stream: true`, the decoder buffers the incomplete bytes and completes the character on the next call. The per-session decoder instances in `ptyDecoders` preserve this state across messages.

### Encoding Summary

| Segment | Format |
|---------|--------|
| OS PTY fd → daemon read thread | Raw bytes |
| read thread → replay buffer | Raw bytes (`OutputChunk.data: bytes`) |
| replay buffer → WebSocket JSON | Base64 string (`PtyOutputMessage.data`) |
| WebSocket frame | JSON text |
| WebSocket → ShellManager | `atob()` → `Uint8Array` |
| Uint8Array → ShellSession | `TextDecoder('utf-8', { stream: true })` → UTF-8 string |
| ShellSession → xterm.js | UTF-8 string via `term.write()` |

---

## 5. Input Encoding

Keystrokes travel from the browser back to the PTY stdin as UTF-8 bytes.

### Stage 1: xterm.js captures keystrokes

```typescript
term.onData((data: string) => {
  // data is a UTF-8 string produced by xterm.js key handler
  shellManager.sendPtyInput(sessionId, data);
});
```

Device Attributes auto-replies (`CSI ?c`) are suppressed by the registered CSI handler (see Layer 5 above) to prevent feedback loops between xterm.js and the shell's terminal capability queries.

Ctrl+C is **not** forwarded from xterm.js — it is redirected to clipboard copy. The running shell process handles its own SIGINT (e.g., when the user types `^C` in the terminal, zsh/bash catch it and interrupt the foreground job).

### Stage 2: ShellManager sends REST-over-WS

```typescript
// ShellManager.sendPtyInput()
action.subpath = 'input';
action.bodyParameters = {
  session_id: sessionId,
  data,   // UTF-8 string from xterm.js
};
await dataManager.callActionOverWS<undefined, any>(action);
```

### Stage 3: Backend writes to PTY stdin

```python
# ComputeNode._send_pty_input()
data_bytes = data.encode('utf-8')
compute_provider.send_pty_input(session_id, data_bytes)
# → PtyProcess.write(data_bytes) → OS PTY fd stdin
```

### Input Encoding Summary

| Segment | Format |
|---------|--------|
| Browser keypresses | UTF-8 string (xterm.js `term.onData()`) |
| ShellManager → WebSocket | UTF-8 string in JSON body `{ session_id, data }` |
| WebSocket → backend | Parsed JSON string |
| Backend → PTY stdin | `data.encode('utf-8')` → `PtyProcess.write(bytes)` |

---

## 6. Replay Buffer

The replay buffer allows a client to recover all terminal output it missed since it last received data — across page refreshes, tab switches, and brief network interruptions.

### Structure

```python
# flow_sdk/builtin/faas/pty_replay_buffer.py

class SessionBuffer:
    chunks: Deque[OutputChunk]    # Circular deque
    total_size_bytes: int
    next_seq: int                 # Next sequence number to assign (starts at 1)

class OutputChunk:
    seq: int         # Monotonic sequence number
    data: bytes      # Raw PTY output bytes
    timestamp: float # Unix timestamp
```

### Limits

| Limit | Value |
|-------|-------|
| Max chunks per session | 5,000 |
| Max bytes per session | 2 MB |
| Eviction policy | FIFO, oldest chunks first |
| Last chunk protection | The final chunk is never evicted |

When a new chunk would exceed either limit, the oldest chunks are removed until the constraint is satisfied. The last remaining chunk is never removed regardless of size, ensuring the latest `seq` is always known.

### How It Is Used

1. Every PTY output chunk is passed to `PtyReplayBuffer.append(session_id, data_bytes)`, which assigns the next monotonic `seq` and stores `(seq, data, timestamp)`.
2. The assigned `seq` is embedded in the `pty_output_msg` sent to all currently attached connections.
3. When a client reattaches, it calls `get_replay(session_id, since_seq)`, which returns all chunks where `seq > since_seq`.
4. The backend snapshots the replay buffer **before** registering the new connection (see Section 8 for why this ordering matters).

### Scope

The replay buffer is in-memory only. It is lost on server restart. After a server restart, the `AgenticProcess.worker_session_id` is preserved in SQLite; the PTY must be resumed with `claude --resume <worker_session_id>` to continue the session, but no terminal output history can be replayed.

---

## 7. Sequence Numbers

Sequence numbers provide the backbone for deduplication and gap-free replay.

### Assignment

The backend `PtyReplayBuffer` assigns a monotonic `seq` to every output chunk:
- Starting value: **1** (not 0; 0 is used as "no data received yet" sentinel by clients)
- Increment: **1 per chunk**
- Scope: per PTY session (each session has its own counter starting at 1)

### Tracking

Both backend and frontend track the latest sequence number seen:

| Location | Field | Purpose |
|----------|-------|---------|
| `PtySessionState` (backend) | `last_seq_received` | Diagnostic / telemetry |
| `ShellSession` (frontend) | `lastSeqReceived` | Deduplication + reattach |
| `localStorage` | `pty_session_{id}.lastSeqReceived` | Survives page refresh |

### Deduplication

`ShellSession.appendPtyOutput(data, seq)` drops a message if `seq <= lastSeqReceived`:

```typescript
if (seq !== undefined) {
  if (seq <= this.lastSeqReceived) {
    return false; // duplicate — discard
  }
  this.lastSeqReceived = seq;
}
// notify listeners
```

Additionally, `ShellManager` keeps a 200-entry recent chunk key cache for a second dedup pass before the message reaches the session.

### How Clients Use Sequence Numbers

1. **First connect** — client sends `start` with no `since_seq`. The backend assigns sequence numbers starting at 1.
2. **While connected** — each `pty_output_msg` carries a `seq`. The client updates `lastSeqReceived` on each message and periodically writes it to `localStorage`.
3. **Before refresh** — `ShellSession` persistence writes `lastSeqReceived` to `localStorage`.
4. **On reattach** — the client reads `lastSeqReceived` from `localStorage` and sends `attach` with `since_seq = lastSeqReceived`. The backend returns only chunks with `seq > since_seq`.

---

## 8. Reconnection and Reattach

The system distinguishes between two recovery scenarios:

| Scenario | PTY alive | Replay buffer | Recovery |
|----------|-----------|--------------|---------|
| WebSocket drop (brief) | Yes | Yes | Automatic WS reconnect + `attach` |
| Page refresh | Yes | Yes | `attach` with `since_seq` |
| Detach > 15 min | No (TTL killed) | No | `resumePty()` — new PTY with `--resume` |
| Server restart | No | No | `resumePty()` — new PTY with `--resume` |

### WebSocket Reconnection

`ConnectionManager` uses exponential backoff with jitter on unexpected close (when `event.wasClean === false`):

```
delay = min(500ms * 2^(attempt-1), 10000ms) + random(0, 1000ms)
```

| Attempt | Base delay | With max jitter |
|---------|-----------|----------------|
| 1 | 500 ms | 1500 ms |
| 2 | 1000 ms | 2000 ms |
| 3 | 2000 ms | 3000 ms |
| 4 | 4000 ms | 5000 ms |
| 5 | 8000 ms | 9000 ms |
| 6–10 | 10000 ms | 11000 ms |
| 11 | — | Give up, emit `on_reconnect_failed` |

On successful reconnect, `reconnectAttempts` resets to 0 and the `on_reconnected` event fires. `ShellManager` listens for this event to retrigger session sync.

### Reattach Flow (Page Refresh)

The critical challenge is avoiding duplicate or missing output at the boundary between the replay and the live stream.

```
1.  Page loads → InteractiveTerminal mounts with empty xterm.js instance
2.  session.ptyStarted = true (from localStorage persistence)
    ptyOwnedByUs = false (this browser instance did not start it)
3.  connectPty() detects reattach needed
4.  reattachBufferRef = []        ← start buffering ALL incoming live output
5.  shellManager.reattachSessionFromServer(sessionId, sinceSeq)
      action.subpath = 'attach'
      action.bodyParameters = { session_id, since_seq: lastSeqReceived }
6.  Backend:
      a. Snapshot replay buffer: get_replay(since_seq)
      b. Attach this connection to session (live output now flows to this connection)
      c. Send replay chunks as individual pty_output_msg frames
      d. Send pty_session_status_msg { status: "reattached", latest_seq }
7.  Frontend receives replay chunks → appended to reattachBufferRef[]
8.  Frontend receives live chunks → also appended to reattachBufferRef[]
9.  pty_session_status_msg arrives → flush reattachBufferRef to xterm.js
10. reattachBufferRef = null       ← stop buffering, enter direct-write mode
11. ptyOwnedByUsRef = true
```

Step 6a-6b ordering is the race condition guard: the replay buffer is snapshotted **before** the connection is attached. This means all replay chunks have lower `seq` values than any live output that arrives after attachment. Combined with sequence-number deduplication (step 7/8), any live chunk that overlaps with a replay chunk is silently dropped.

### Backend Reattach Logic

```python
# ComputeNode._attach_and_replay()
replay_chunks = pty_replay_buffer.get_replay(session_id, since_seq)
# ↑ snapshot BEFORE attaching
pty_session_manager.attach_session(session_id, connection_id)
# ↑ live output now flows to connection_id
for chunk in replay_chunks:
    send pty_output_msg(seq=chunk.seq, data=base64(chunk.data))
send pty_session_status_msg(status="reattached", latest_seq=last_seq)
```

### Post-Reconnect Session Sync

When the WebSocket reconnects, `ShellManager.syncSessionsWithBackend()` calls `terminal-command/list` to discover which sessions still exist on the backend. For each session that existed locally and was previously started (`sessionExistedLocally && sessionWasActive`), it calls `reattachSessionFromServer()`. For new sessions discovered on the backend, it marks them as started without replaying history.

---

## 9. Error Handling

### Unknown Message Type

If the server receives a `message_type` it does not recognise, it replies with an error `response_msg`:

```json
{
  "message_type": "response_msg",
  "response_message_id": "{original_message_id}",
  "status": "error",
  "error": "Unknown message type: ..."
}
```

### Invalid JSON

If the server receives a text frame that is not valid JSON, it logs a warning and replies with an error `response_msg` (without `response_message_id` since parsing failed).

### Handler Exception

If an exception occurs inside `handle_json_message`, the server catches it and sends an error `response_msg` to the client. The connection stays open.

### WebSocket Disconnect During Message

If `websocket.send_text()` fails during a broadcast, the failing `connection_id` is added to a disconnect list and removed from `_active_connections` after the loop. This prevents one dead connection from interrupting delivery to others.

### Client-Side Timeout

`ConnectionManager.sendRestApiMessage()` sets a 30-second timeout on each pending request. If no `response_msg` arrives in time, the Promise is rejected with `"Request timeout for message_id: ..."` and the pending entry is removed from the map.

### Session Not Found or Expired

If the backend responds to a `start` or `attach` with `status: "not_found"` or `"expired"`, `ShellManager.startPty()` clears the stale `localStorage` persistence (`ShellSession.clearPersistence(sessionId)`) and retries the `start` operation fresh (without `since_seq`).

### WebSocket Reconnect Failure

If `ConnectionManager` exhausts all 10 reconnect attempts, it emits `on_reconnect_failed`. The UI is expected to display a disconnected state. No automatic further reconnects are attempted.

### PTY Process Death

When the PTY process exits unexpectedly, the daemon thread calls `on_exit(exit_code)`, which schedules `_on_pty_exit()` on the async event loop:

1. Checks if `pty_pid` was already cleared by a concurrent `kill_pty()` call (skip if so)
2. If `exit_code != 0`: writes an error message to `process.state` via `_set_process_state(error=...)`
3. Clears `pty_pid` on the `AgenticProcess` entity
4. Saves the entity to SQLite

The frontend detects the cleared `pty_pid` on the next entity update and shows the restart overlay.

---

## 10. Key Files Index

| File | Layer | Purpose |
|------|-------|---------|
| `flow_sdk/compute/providers/local_compute_provider.py` | Layer 1 | PTY spawn, read thread, write to stdin, resize (SIGWINCH), cross-platform |
| `flow_sdk/builtin/faas/pty_session_manager.py` | Layer 2 | Session registry, connection attachment, TTL cleanup |
| `flow_sdk/builtin/faas/pty_replay_buffer.py` | Layer 2 | Circular output buffer: 2 MB / 5000 chunks per session |
| `flow_sdk/builtin/faas/compute_node.py` | Layer 2-3 | PTY action handlers, replay delivery, output routing |
| `flow_sdk/api/messages.py` | Layer 3 | `PtyOutputMessage`, `PtySessionStatusMessage` Pydantic models |
| `flow_sdk/builtin/agentic_processor.py` | Layer 2 | `start-pty`, `resume-pty`, `kill-pty` actions on AgenticProcess |
| `server/routes/websocket.py` | Layer 3 | WebSocket endpoint, connection lifecycle, message dispatch |
| `server/routes/ws_rest.py` | Layer 3 | REST-over-WebSocket message handler |
| `ts_sdk/src/websocket.ts` | Layer 3-4 | `ConnectionManager`: connect, reconnect, message dispatch, pending request map |
| `ts_sdk/src/services/shell/shellManager.ts` | Layer 4 | `ShellManager`: PTY output routing, orphan buffer, sync, reattach |
| `ts_sdk/src/services/shell/shellSession.ts` | Layer 4 | `ShellSession`: `appendPtyOutput`, deduplication, `onPtyData`, localStorage persistence |
| `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` | Layer 5 | xterm.js instance, FitAddon, reattach buffer, CSI intercepts |
| `ui/src/components/terminal/TabbedTerminal.tsx` | Layer 5 | Multi-tab manager, always-mounted strategy, session creation |
| `ui/src/components/process-terminal/ProcessTerminal.tsx` | Layer 5 | AgenticProcess entity watch, syncs `pty_pid` to tabs |
