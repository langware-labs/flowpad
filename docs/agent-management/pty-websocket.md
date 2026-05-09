# PTY, Shell State, and WebSocket Transport

Reference for the current PTY stack: Shell-owned state, backend PTY sessions,
WebSocket transport, replay buffers, attach/input/resize/close semantics, and
how interactive PTY mode differs from headless CLI mode.

This document reflects the current implementation in these paths:

- `flow_sdk/builtin/shell.py`
- `flow_sdk/builtin/faas/pty_actions.py`
- `flow_sdk/compute/providers/desktop/provider.py`
- `flow_sdk/compute/providers/desktop/pty_session_manager.py`
- `flow_sdk/compute/providers/desktop/pty_replay_buffer.py`
- `ts_sdk/src/entities/shell.ts`
- `ts_sdk/src/services/shell/ptyConnection.ts`
- `ts_sdk/src/websocket.ts`
- `ts_sdk/src/FlowSync/store.ts`

Related transport and wrapper paths:

- `flow_sdk/server/routes/websocket.py`
- `flow_sdk/server/routes/ws_rest.py`
- `flow_sdk/compute/providers/base_pty_session.py`
- `ts_sdk/src/services/shell/ptyOrphanBuffer.ts`

---

## 1. Current Stack

The current frontend no longer uses a `ShellManager` / `ShellSession` pair.
`Shell` is the entity wrapper and owns one eager `PtyConnection`. `DataManager`
routes incoming PTY output to the cached `Shell`, and `PtyConnection` owns
frontend replay state, sequence deduplication, decode state, and listeners.

```text
Browser xterm / UI
  -> Shell entity wrapper
     ts_sdk/src/entities/shell.ts
  -> PtyConnection
     ts_sdk/src/services/shell/ptyConnection.ts
  -> DataManager + ConnectionManager
     ts_sdk/src/FlowSync/store.ts
     ts_sdk/src/websocket.ts
  -> WebSocket REST bridge
     flow_sdk/server/routes/websocket.py
     flow_sdk/server/routes/ws_rest.py
  -> Shell and ComputeNode PTY actions
     flow_sdk/builtin/shell.py
     flow_sdk/builtin/faas/pty_actions.py
  -> PTY manager, replay buffer, provider handle
     flow_sdk/compute/providers/desktop/pty_session_manager.py
     flow_sdk/compute/providers/desktop/pty_replay_buffer.py
     flow_sdk/compute/providers/base_pty_session.py
  -> OS PTY process
     flow_sdk/compute/providers/desktop/provider.py
```

Important identifiers:

| Name | Meaning |
|------|---------|
| `shell_id` | The `Shell.id`. This is also the stable PTY session id. |
| `pty_id` | Usually the same value as `shell_id`; accepted by attach for compatibility. |
| `compute_node_id` | Graph entity id of the owning `ComputeNode`. |
| `provider_node_id` | Provider-specific node id, commonly `local` for the local desktop provider. |
| `pty_key` | Backend in-memory key: `(compute_node_id, provider_node_id, shell_id)`. |
| `connection_id` | Client-generated WebSocket UUID from `ConnectionManager.id`. |

---

## 2. Shell-Owned PTY State

`flow_sdk/builtin/shell.py` is the DB-backed metadata layer for shell tabs and
PTY sessions. The entity id is the session id; there is no separate session-id
field.

Key backend fields:

| Field | Purpose |
|-------|---------|
| `id` | Stable shell id and PTY id. |
| `status` | `idle`, `running`, `closing`, `closed`, or `error`. |
| `pty_pid` | Set to the shell id when a PTY is active. |
| `compute_node_id` / `compute_node_uname` | Bind the shell to the real compute node. |
| `workdir` | Working directory used when spawning the PTY. |
| `env` | Persisted environment overrides; injected into a running PTY when set. |
| `worker_pid` / `worker_name` | Worker process tracked for agentic shells. |
| `last_launch_cmd` | Serialized CLI options for the last launched worker. |

`Shell.start()` is idempotent:

1. It repairs or resolves the live compute-node binding.
2. It checks for an existing `Pty` handle through `compute_node.get_pty(self.id)`.
3. If the PTY is alive and matches requested direct-spawn args, it reuses it.
4. If the PTY is dead or stale, it cleans it up.
5. It calls `ComputeNode.create_pty(...)`, which delegates to
   `PtyActionsMixin.start_machine_pty_session(...)`.
6. It persists `status="running"`, `pty_pid=self.id`, and `last_active_at`.

`ShellRecord` remains the disk record for shell metadata and PTY stream bytes.
`start_machine_pty_session()` creates or updates the record and wires a
`PtyStreamFile` into `PtySessionState.pty_stream_file`. `Shell.read()` reads the
accumulated stream file; this is separate from the in-memory replay buffer.

---

## 3. Backend PTY Creation

`flow_sdk/builtin/faas/pty_actions.py` is mixed into `ComputeNode` and handles
the `terminal-command/<op>` action family.

`start_machine_pty_session()` does the backend PTY setup:

1. Builds `pty_key = (compute_node.id, compute_node.node_provider_id, shell_id)`.
2. Reuses an existing `PtySessionState` if present and attaches the connection.
3. Enforces a node-local session cap of 70 by evicting 10 oldest sessions.
4. Creates the provider PTY via `compute_provider.get_or_create_pty_session(...)`.
5. Registers a `PtySessionState` in `pty_session_manager`.
6. Creates or updates `ShellRecord`, then creates/updates the `Shell` entity.
7. Appends `shell_id` to `ComputeNode.active_pty_sessions`.
8. Broadcasts a `data_op_msg` update with the full compute-node model dump.

The local desktop provider is `flow_sdk/compute/providers/desktop/provider.py`.
It uses:

| Platform | PTY implementation |
|----------|--------------------|
| Windows | `winpty.PtyProcess` from `pywinpty` |
| macOS/Linux | `ptyprocess.PtyProcess` |

When no direct `spawn_args` are supplied, the provider spawns a shell:

- Windows prefers `pwsh`, then `powershell`, then `cmd.exe`.
- Unix uses `$SHELL` when it points to an existing executable.
- macOS falls back to `/bin/zsh`.
- Linux falls back to `/bin/bash` or `/bin/sh`.

When `spawn_args` are supplied, the provided argv is spawned directly. This is
used by direct agentic PTY mode, where the worker executable is the PTY process
instead of being launched inside an intermediate shell.

The provider always sets:

- `TERM=xterm-256color`
- `FLOWPAD_PTY_SESSION_ID=<shell_id>`

It strips `CLAUDECODE*` environment variables before spawning to avoid nested
Claude Code detection.

A daemon read thread calls `pty_process.read(1024)`, normalizes returned data to
bytes, and calls the `on_output(data_bytes)` callback. On process exit it calls
the optional `on_exit(exit_code)` callback from the read thread.

---

## 4. WebSocket Transport

### Endpoint

```text
ws://localhost:9007/api/v1/connect/ws/{connection_id}
```

`ConnectionManager` creates the `connection_id` with `uuidv4()`, builds the URL
from `${config.SERVER_URL}${config.API_PREFIXES.connect}/${this.id}`, converts
`http` to `ws` or `https` to `wss`, and sets `socket.binaryType = "arraybuffer"`.

On connect, `flow_sdk/server/routes/websocket.py`:

1. Accepts the WebSocket.
2. Stores it in the active connection map.
3. Adds it to the registry used by `get_connection_handler(...)`.
4. Sends a confirmation `response_msg`.

Example confirmation:

```json
{
  "message_type": "response_msg",
  "message_id": "<uuid>",
  "status": "ok",
  "data": {
    "connection_id": "<connection_id>",
    "message": "Connected to Flowpad WebSocket server"
  }
}
```

On disconnect, the server removes the connection, removes watch registrations,
and calls `PtySessionManager.detach_all_for_connection(connection_id)`. That
only detaches the WebSocket id; it does not close the PTY process.

### Message Dispatch

`ts_sdk/src/websocket.ts` dispatches by `message_type`:

| Message type | Client handler |
|--------------|----------------|
| `response_msg` | Resolves or rejects the pending REST-over-WS request. |
| `pty_output_msg` | Emits `on_pty_output_msg`. |
| `data_op_msg` | Emits `on_data_op`. |
| `flow_data_msg` | Emits `on_flow_data`. |
| `transcript_msg` | Emits `on_stream_msg`. |
| `control_msg` | Emits `on_control_msg`. |
| `oauth_msg` | Emits `on_oauth_msg`. |
| `llm_config_msg` | Emits `on_llm_config_msg`. |
| `ui_command` | Emits `on_ui_command`. |

Binary frames are msgpack stream frames and are separate from PTY output. PTY
output is transported as JSON text with base64 data.

### Reconnect

Unexpected WebSocket close triggers indefinite reconnect attempts with
exponential backoff and jitter:

```text
delay = min(500ms * 2^(attempt - 1), 10000ms) + random(0, 1000ms)
```

There is no hard retry cap in the current `ConnectionManager`. On successful
reconnect it emits `on_reconnected`.

`DataManager` re-registers watched entities on `on_open`. `Shell` registers a
single static listener pair for all live Shell instances:

- `on_close` -> `shell.ptyConnection.handleWsClose()`
- `on_reconnected` -> `shell.start(...)` for shells whose tab has been active

---

## 5. REST Over WebSocket

Terminal operations use REST-over-WebSocket frames:

```json
{
  "message_type": "rest_api_msg",
  "message_id": "<uuid>",
  "method": "POST",
  "scope": [{ "type": "compute_node", "id": "<compute_node_id>" }],
  "target_typeid": { "type": "compute_node", "id": "<compute_node_id>" },
  "action": "terminal-command",
  "sub_path": "attach",
  "body": {
    "shell_id": "<shell_id>",
    "pty_id": "<pty_id>",
    "since_seq": 0,
    "connection_id": "<connection_id>"
  }
}
```

`flow_sdk/server/routes/ws_rest.py` routes the message through the graph action
handler with request context fields:

- `request_message_id = rest_api_msg.message_id`
- `request_connection_id = connection_id`

If an action returns `ApiResponse(data=<ResponseMessage>)`, `ws_rest.py` sends
that nested `response_msg` directly. Otherwise it wraps the `ApiResponse` in a
`response_msg` whose `content` is the full API response payload.

`ConnectionManager.sendRestApiMessage()` stores a pending request by
`message_id` and resolves it when a `response_msg.response_message_id` matches.
The default timeout is 30 seconds.

---

## 6. PTY Operations

### Open / Start

The current TypeScript `Shell.start()` does not normally call
`terminal-command/start`. It calls the Shell entity action:

```text
POST /api/v1/graph/shell/{shell_id}/open
```

Body:

```json
{
  "connection_id": "<connection_id>",
  "cols": 80,
  "rows": 24,
  "working_dir": "/optional/path"
}
```

Backend path:

```text
Shell._http_open()
  -> Shell.start(...)
  -> ComputeNode.create_pty(...)
  -> PtyActionsMixin.start_machine_pty_session(...)
```

The response is the updated `Shell` entity data plus `pty_id`. The frontend then
calls `Shell.attachPty(...)` to attach over WebSocket and drain replay.

`terminal-command/start` still exists for lower-level compute-node callers. It
requires `shell_id` and a WebSocket connection id from request context or body.

### Attach And Replay

Frontend path:

```text
Shell.attachPty(...)
  -> PtyConnection.attach(ptyId)
  -> PtyConnection._reattach(ptyId, sinceSeq)
  -> dataManager.callActionOverWS(terminal-command/attach)
```

Current attach body:

```json
{
  "shell_id": "<shell_id>",
  "pty_id": "<pty_id>",
  "since_seq": 0,
  "connection_id": "<connection_id>"
}
```

`PtyConnection.attach()` currently resets `lastSeq` to `0` before reattaching,
so it requests all retained replay chunks from the backend buffer. This replaces
the older localStorage-based incremental `since_seq` behavior.

Backend path:

```text
PtyActionsMixin._attach_pty_session(...)
  -> pty_handle = ComputeNode.get_pty(pty_id)
  -> replay_chunks = pty_handle.snapshot(since_seq)
  -> pty_handle.attach(connection_id)
  -> send replay chunks
  -> return PtySessionStatusMessage(status="reattached", latest_seq=...)
```

The replay snapshot is taken before attaching the connection. After attach,
live output can flow to the same connection. Sequence deduplication in
`PtyConnection.appendOutput()` protects against duplicate chunks if replay and
live output overlap.

Replay chunks are sent as `response_msg` frames whose `content` is a
`pty_output_msg`. Each replay chunk receives its own unique `message_id` and
`response_message_id`, so it does not collide with the pending attach request.

Attach status response content:

```json
{
  "message_type": "pty_session_status_msg",
  "shell_id": "<shell_id>",
  "status": "reattached",
  "replay_truncated": false,
  "latest_seq": 42
}
```

If the PTY is missing, attach resolves to:

```json
{
  "message_type": "pty_session_status_msg",
  "shell_id": "<shell_id>",
  "status": "not_found",
  "replay_truncated": false,
  "latest_seq": null
}
```

The frontend treats `not_found` as a failed attach, sets `started=false`, and
throws from `PtyConnection.attach()`.

After `_reattach()` returns, `PtyConnection.attach()` waits up to 2 seconds for
`lastSeq >= latest_seq`, then sets `replayDone=true` and emits ready. Live output
listeners are gated until `replayDone` is true.

### Output

Backend output flow:

```text
OS PTY read thread
  -> on_pty_output(data: bytes)
  -> replay_buffer.append(pty_key, data)
  -> session_state.pty_stream_file.write(data)
  -> session_state.output_queues
  -> _send_pty_output_to_client(...) for every attached connection_id
```

`PtyOutputMessage` fields:

```json
{
  "message_type": "pty_output_msg",
  "provider_node_id": "local",
  "shell_id": "<shell_id>",
  "data": "<base64 raw PTY bytes>",
  "seq": 42,
  "timestamp_ms": 1710000000000
}
```

Live output is usually delivered wrapped in a `response_msg`:

```json
{
  "message_type": "response_msg",
  "message_id": "<uuid>",
  "response_message_id": "<uuid>",
  "content": {
    "message_type": "pty_output_msg",
    "shell_id": "<shell_id>",
    "data": "<base64>",
    "seq": 42
  },
  "error": null
}
```

`ConnectionManager.onResponseMessage()` unwraps `content.message_type ===
"pty_output_msg"` when there is no matching pending request, then emits
`on_pty_output_msg`.

Frontend output flow:

```text
ConnectionManager.on_pty_output_msg
  -> DataManager.onPtyOutputMessage(...)
  -> cached Shell.ptyConnection.routeOutput(...)
  -> PtyConnection.appendOutput(...)
  -> listeners after replayDone
```

If the `Shell` is not in the entity cache yet, `DataManager` buffers the base64
chunk in `ptyOrphanBuffer`. Limits are 200 chunks per shell, 5 MB total, and 30
seconds max age. `PtyConnection._reattach()` flushes that buffer after a
successful attach response.

### Input

Frontend path:

```text
Shell.sendInput(data)
  -> PtyConnection.sendInput(data)
  -> terminal-command/input over WebSocket
```

Body:

```json
{
  "shell_id": "<shell_id>",
  "data": "<string from terminal>"
}
```

`PtyConnection.sendInput()` only sends when `isLive` is true:

```text
started && !restarting && dataContext.isConnected
```

Backend path:

```text
PtyActionsMixin._send_pty_input(...)
  -> pty = ComputeNode.get_pty(shell_id)
  -> data.encode("utf-8")
  -> pty.write(data_bytes)
  -> provider.send_pty_input(...)
  -> PtyProcess.write(...)
```

On Windows the provider writes a string to `winpty`; on Unix it writes bytes to
`ptyprocess`.

Higher-level backend `Shell.write(text)` is different from browser input: it
waits for the shell to go idle, appends carriage return, and writes the command.
`Shell.write_raw(bytes)` sends raw bytes directly.

### Resize

Frontend body:

```json
{
  "shell_id": "<shell_id>",
  "cols": 120,
  "rows": 32
}
```

Backend path:

```text
PtyActionsMixin._resize_pty(...)
  -> pty.resize(cols, rows)
  -> provider.resize_pty(provider_node_id, shell_id, cols, rows)
  -> PtyProcess.setwinsize(rows, cols)
```

`flow_sdk/compute/providers/base_pty_session.py` skips resize if cols and rows
are unchanged. This avoids unnecessary `SIGWINCH` redraws.

If resize fails because the PTY process died, the provider cleans up the dead
session and retries once with the stored output callback.

### Close, Detach, And Disconnect

There are three distinct cases:

| Case | Current behavior |
|------|------------------|
| WebSocket disconnect | Server removes only that `connection_id` from every session. PTY stays alive. |
| `Shell.close()` | Deletes the `ShellRecord`, closes the PTY handle if present, deletes the `Shell` entity. |
| `terminal-command/close` | Marks Shell/ShellRecord closed, calls `Shell.close()` when possible, then falls back to `pty.close_for_connection(...)` if a PTY handle remains. |

Low-level `PtySession.close_for_connection(connection_id)` removes one
connection from the session and only destroys the PTY when no connections
remain. When the session is destroyed, the replay buffer is cleared.

`PtySessionManager` also implements TTL cleanup:

- default interval: 120 seconds
- default detached TTL: 900 seconds

The manager exposes `start_cleanup_task(...)`, but the inspected code paths do
not start that task automatically. WebSocket disconnect cleanup is immediate
detachment only.

---

## 7. Replay Buffer And Sequence Numbers

The replay buffer is
`flow_sdk/compute/providers/desktop/pty_replay_buffer.py`.

State is keyed by:

```python
(compute_node_id, provider_node_id, shell_id)
```

Each buffer stores `OutputChunk` records:

```python
class OutputChunk:
    seq: int
    data: bytes
    timestamp: float
```

Limits:

| Limit | Value |
|-------|-------|
| Max bytes per PTY session | 2 MB |
| Max chunks per PTY session | 5,000 |
| Sequence start | 1 |
| Empty latest sequence | 0 |
| Eviction | FIFO, never evict the final remaining chunk |

Every output callback appends raw bytes to the buffer and receives the assigned
sequence number. That `seq` is sent to clients in each `pty_output_msg`.

Frontend sequence handling is in `PtyConnection.appendOutput(...)`:

- If `seq <= lastSeq` and `lastSeq > 0`, the chunk is dropped.
- Otherwise `lastSeq` is updated.
- Decoded bytes are stored in `chunks: Map<number, OutputChunk>`.
- Listeners are called only after `replayDone=true`.

The replay buffer is in-memory only. It is lost on server restart. The PTY
stream file under `ShellRecord` is the disk-backed accumulated byte stream, but
it is not used by attach replay.

`PtySessionStatusMessage.replay_truncated` exists and defaults to `false`, but
the current attach path does not compute or set truncation. If old chunks were
evicted from the 2 MB / 5,000 chunk buffer, attach from `since_seq=0` replays
only the retained tail and still reports `replay_truncated=false`.

---

## 8. Encoding

PTY output is binary-safe over JSON:

| Segment | Format |
|---------|--------|
| OS PTY -> read thread | Raw bytes or `str` normalized to bytes |
| read thread -> replay buffer | Raw bytes |
| replay buffer -> WebSocket | Base64 in `PtyOutputMessage.data` |
| WebSocket frame | JSON text |
| `PtyConnection` decode | `atob()` -> `Uint8Array` -> `TextDecoder` |
| terminal listener | Decoded UTF-8 string |

`PtyConnection` owns a single streaming `TextDecoder('utf-8', { fatal: false })`
per shell connection and calls:

```ts
this.decoder.decode(bytes, { stream: true })
```

Streaming decode preserves partial multi-byte UTF-8 characters split across PTY
chunks.

Input takes the reverse path for browser keystrokes:

| Segment | Format |
|---------|--------|
| Terminal UI -> `PtyConnection.sendInput` | JavaScript string |
| REST-over-WS body | JSON string in `data` |
| backend `_send_pty_input` | `data.encode("utf-8")` |
| provider write | bytes on Unix, string on Windows |

---

## 9. Browser Shell Runtime

`ts_sdk/src/entities/shell.ts` eagerly constructs `this.ptyConnection` in the
`Shell` constructor. The entity wrapper delegates PTY operations:

| Shell API | Delegates to |
|-----------|--------------|
| `start(...)` | Shell entity `open` action, then `attachPty(...)` |
| `attachPty(...)` | `PtyConnection.attach(...)` |
| `sendInput(data)` | `PtyConnection.sendInput(data)` |
| `resize(cols, rows)` | `PtyConnection.resize(cols, rows)` |
| `onOutput(fn)` | `PtyConnection.onOutput(fn)`, only after replay is done |
| `getPtyChunks()` | Sorted chunks from `PtyConnection.chunks` |

`Shell.attachPty(...)` is deferred until the tab is active at least once. Once a
shell has ever been active, it is registered in a static shell registry so one
global `ConnectionManager` listener pair can fan out `on_close` and
`on_reconnected` to all live shells.

Current reconnect behavior is intentionally simple:

1. WebSocket closes.
2. `PtyConnection.handleWsClose()` sets `replayDone=false` and emits disconnect.
3. `ConnectionManager` reconnects indefinitely.
4. `Shell._onCmReconnected()` calls `Shell.start(...)` again for active shells.
5. `Shell.start(...)` reuses a live backend PTY or recreates a missing one.
6. `PtyConnection.attach(...)` requests retained replay and reopens listeners.

There is no current localStorage-backed `lastSeqReceived` persistence in the
inspected `Shell` / `PtyConnection` implementation.

---

## 10. Interactive PTY Mode Vs Headless CLI Mode

There are two agent execution modes that share some records but have different
transport paths.

### Interactive PTY Mode

Interactive mode is used when an `AgenticProcess` is visible in the shell UI.
It has a `Shell` entity and a live PTY.

`flow_sdk/builtin/agentic_process/agentic_process.py` currently supports two
interactive PTY launch styles:

| Setting | Behavior |
|---------|----------|
| `shell_mode=False` | Default. Direct spawn: the worker executable is the PTY process. |
| `shell_mode=True` | Legacy shell intermediary: start a shell, then inject the worker command. |

Direct spawn path:

```text
AgenticProcess.start(...)
  -> cmd.to_spawn_args(...)
  -> Shell.start(spawn_args=..., extra_env=...)
  -> provider spawns worker argv as PTY process
  -> Shell.set_worker_pid_direct(...)
```

Legacy shell mode path:

```text
AgenticProcess.start(...)
  -> Shell.start(...)
  -> Shell.launch(cmd, instruction)
  -> Shell.write(command)
  -> poll for worker child pid
```

In both interactive styles:

- PTY output goes through replay buffer and WebSocket output routing.
- Browser attach/input/resize uses `PtyConnection`.
- `AgenticProcess.prompt(...)` sends to the live PTY when the worker is running.
- A server restart loses in-memory replay and PTY state, but the process
  `session_id` and transcript files can be used to resume the worker.

### Headless CLI Mode

Headless mode is the `AgenticProcess.prompt(...)` route when
`AgenticProcess.visible` is false. That prompt turn does not create a `Shell`,
does not create a PTY, and does not use PTY WebSocket replay. An explicit
`AgenticProcess.start(...)` call is still the interactive opener and creates or
reuses a Shell-backed PTY.

Current routing in `AgenticProcess.prompt(...)`:

```text
visible=True  -> interactive PTY path
visible=False -> self.driver.run_print_turn(...)
```

Driver-specific headless implementations run CLI print/exec commands such as
Claude print mode or Codex exec mode, capture structured output/transcripts, and
return API responses without xterm, `PtyConnection`, or `pty_output_msg` frames.

The bridge between modes is the worker session/transcript identity, not the PTY
transport. A process can preserve `session_id` across headless and interactive
opens; when it becomes visible, interactive startup can resume or fork from the
existing transcript/session where supported by the worker driver.

---

## 11. Error Handling Notes

| Case | Behavior |
|------|----------|
| Invalid JSON over WS | Server sends `response_msg` with `status="error"` when possible. |
| Unknown WS message type | Server sends error `response_msg` with the original `message_id` as `response_message_id`. |
| REST-over-WS timeout | `ConnectionManager` rejects after 30 seconds by default. |
| Attach missing PTY | Backend returns `PtySessionStatusMessage(status="not_found")`; frontend marks not started and throws. |
| Input missing PTY | Backend returns an error; frontend marks disconnected if the message includes `PTY session not found`. |
| Resize missing/dead PTY | Backend errors; frontend marks `started=false` for not found or failed resize. |
| Provider write/resize on dead process | Provider cleans up and retries once if it has the stored output callback. |
| PTY process exit | Provider calls `on_exit`; `AgenticProcess` callbacks update process status and may index transcripts. |

`terminal-command/ping` is available as a lightweight process-alive check. It
returns a plain API response wrapped by `ws_rest.py`, so the TypeScript caller
reads `result.data.alive`.

---

## 12. Key Files Index

| File | Purpose |
|------|---------|
| `flow_sdk/builtin/shell.py` | Shell entity, persistent PTY metadata, open/close/run actions, backend read/write helpers, worker PID tracking. |
| `flow_sdk/builtin/faas/pty_actions.py` | ComputeNode PTY actions: start, attach, input, resize, close, list, rename, ping, output routing. |
| `flow_sdk/builtin/faas/compute_node.py` | Action stubs that delegate PTY routes to `PtyActionsMixin`. |
| `flow_sdk/compute/providers/desktop/provider.py` | Local desktop PTY spawn, read thread, provider write/resize/close/list operations. |
| `flow_sdk/compute/providers/base_pty_session.py` | Provider-neutral `Pty` handle: write, resize, output iterator, snapshot, attach, close, latest_seq. |
| `flow_sdk/compute/providers/desktop/pty_session_manager.py` | In-memory PTY session registry, attached connection ids, detach/close/TTL cleanup methods. |
| `flow_sdk/compute/providers/desktop/pty_replay_buffer.py` | In-memory replay buffer with per-session sequence numbers and 2 MB / 5,000 chunk limits. |
| `flow_sdk/server/routes/websocket.py` | WebSocket endpoint, message dispatch, reconnect-side cleanup, detach-on-disconnect. |
| `flow_sdk/server/routes/ws_rest.py` | `rest_api_msg` execution context and response wrapping/unwrapping. |
| `flow_sdk/api/messages.py` | `PtyOutputMessage`, `PtySessionStatusMessage`, `ResponseMessage`, and message type enums. |
| `ts_sdk/src/entities/shell.ts` | TypeScript Shell entity wrapper, eager `PtyConnection`, Shell open/attach/input/resize/close delegation. |
| `ts_sdk/src/services/shell/ptyConnection.ts` | Frontend PTY runtime state, attach/replay gate, sequence dedup, base64 decode, input/resize. |
| `ts_sdk/src/services/shell/ptyOrphanBuffer.ts` | Short-lived buffer for output received before a Shell is cached locally. |
| `ts_sdk/src/websocket.ts` | WebSocket client, reconnect loop, message dispatch, REST-over-WS pending request map. |
| `ts_sdk/src/FlowSync/store.ts` | DataManager routing for PTY output, watch re-registration, REST-over-WS message construction. |
| `flow_sdk/builtin/agentic_process/agentic_process.py` | Interactive PTY vs headless CLI routing for agentic processes. |
| `flow_sdk/builtin/agentic_process/status_predicates.py` | Worker mode derivation: `visible=True` interactive, `visible=False` CLI. |
