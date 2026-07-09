---
id: f59c4fcb-2d75-5fab-81ac-bdff4302e9e0
---

# PTY, Shell State, and WebSocket Transport

Reference for the current PTY stack: Shell-owned metadata, backend PTY sessions,
WebSocket transport, the connection-membership FSM, **disk-backed framed replay**,
attach/input/resize/close semantics, and how interactive PTY mode differs from
headless CLI mode.

> **Replay model note (read first).** The old *in-memory replay buffer* (a
> `pty_replay_buffer.py` holding `OutputChunk` bytes, replayed over the WebSocket
> on attach via `pty_handle.snapshot(since_seq)`) **no longer exists.** Replay is
> now a **disk-backed framed stream** (`.pty` JSONL file) fetched over a **separate
> HTTP route** and replayed through a headless xterm on the client. `PtyState.seq`
> is now only a monotonic *activity counter* — it stores no bytes. Attach over the
> WebSocket does **no byte replay**; it just repaints the live TUI. Sections 4, 6,
> and 7 below reflect this.

This document reflects the current implementation in these paths:

- `flow_sdk/builtin/shell.py` — Shell entity + metadata, open/close.
- `flow_sdk/builtin/faas/pty_actions.py` — ComputeNode PTY action family.
- `flow_sdk/builtin/faas/pty_session.py` — `Pty` abstract handle interface.
- `flow_sdk/compute/providers/base_pty_state.py` — shared `PtySession` handle body.
- `flow_sdk/compute/providers/desktop/local_pty_session.py` — local provider handle shell.
- `flow_sdk/compute/providers/desktop/provider.py` — OS PTY spawn, read thread, env.
- `flow_sdk/compute/providers/desktop/pty_session_manager.py` — `PtyRegistry` + `PtyState` (membership FSM).
- `flow_sdk/compute/providers/desktop/pty_stream_file.py` — framed `.pty` disk stream (replay source).
- `flow_sdk/server/routes/websocket.py` — WS endpoint, dispatch, membership hooks.
- `flow_sdk/server/routes/ws_rest.py` — `rest_api_msg` execution context.
- `flow_sdk/server/routes/pty_stream.py` — `GET /shell/{id}/pty-stream` (framed history).
- `ts_sdk/src/entities/shell.ts` — TS Shell wrapper + eager `PtyConnection`.
- `ts_sdk/src/services/shell/ptyConnection.ts` — client PTY runtime (attach, dedup, decode).
- `ts_sdk/src/services/shell/ptyOrphanBuffer.ts` — pre-cache output buffer.
- `ts_sdk/src/websocket.ts` — WS client, reconnect, REST-over-WS pending map.
- `ts_sdk/src/FlowSync/store.ts` — DataManager PTY output routing.
- `ui/src/components/terminal/interactive-terminal/pty-replay.ts` — fetch + headless-xterm replay.
- `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` — the attach orchestration.

Cross-references (owned by other docs — do not duplicate):

- Recovery after a server restart (respawn of dead workers): `docs/pty-sync.md`
  and `flow_sdk/server/pty_recovery.py`.
- Headless⇄PTY mode switching: `docs/modes/…`.

---

## 1. Current Stack

`Shell` is the entity wrapper and owns one eager `PtyConnection`. `DataManager`
routes incoming PTY output to the cached `Shell`; `PtyConnection` owns client-side
attach state, sequence deduplication, decode state, and listeners. Attach-time
history restore is done by the terminal component (`InteractiveTerminal` +
`pty-replay.ts`), **not** by `PtyConnection`.

```text
Browser xterm / UI
  -> InteractiveTerminal.tsx        (attach orchestration + history replay)
       fetchPtyStream / replayPtyStream  (ui/.../pty-replay.ts)
  -> Shell entity wrapper           (ts_sdk/src/entities/shell.ts)
  -> PtyConnection                  (ts_sdk/src/services/shell/ptyConnection.ts)
  -> DataManager + ConnectionManager (FlowSync/store.ts, websocket.ts)
  -> WebSocket REST bridge          (server/routes/websocket.py, ws_rest.py)
  -> HTTP framed-stream route       (server/routes/pty_stream.py)   [replay only]
  -> ComputeNode PTY actions        (builtin/faas/pty_actions.py)
  -> Pty handle + membership FSM    (base_pty_state.py, pty_session_manager.py)
  -> framed disk stream             (desktop/pty_stream_file.py)     [replay source]
  -> OS PTY process                 (desktop/provider.py)
```

Important identifiers:

| Name | Meaning |
|------|---------|
| `shell_id` | The `Shell.id`. Also the stable PTY session id. |
| `pty_id` / `pty_pid` | Usually equal to `shell_id`; `pty_pid` is the metadata field stamped when a PTY is active and is used to build the `.pty` stream path. |
| `compute_node_id` | Graph entity id of the owning `ComputeNode`. |
| `provider_node_id` | Provider-specific node id (`local` for the desktop provider). |
| `pty_key` | Registry key: `(compute_node_id, provider_node_id, shell_id)` (3-tuple). |
| provider key | Provider-internal `(provider_node_id, session_id)` (2-tuple) into `_pty_processes`. |
| `connection_id` | Client-generated WebSocket UUID (`ConnectionManager.id`). |

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
| `pty_pid` | Set to the shell id when a PTY is active; keys the `.pty` stream file. |
| `compute_node_id` / `compute_node_uname` | Bind the shell to the real compute node. |
| `workdir` | Working directory used when spawning the PTY. |
| `env` | Persisted environment overrides. |
| `worker_pid` / `worker_name` | Worker process tracked for agentic shells. |
| `last_launch_cmd` | Serialized CLI options for the last launched worker. |
| `last_active_at` | Recency signal; gates bare-shell restart recovery. |

`Shell.start()` is idempotent: it repairs/resolves the compute-node binding,
checks for an existing live `Pty` via `compute_node.get_pty(self.id)`, reuses it
when alive and matching, cleans it up when dead/stale, and otherwise calls
`ComputeNode.create_pty(...)` → `PtyActionsMixin.start_machine_pty_session(...)`,
then persists `status="running"`, `pty_pid=self.id`, and `last_active_at`.

`ShellRecord` (an `FSRecord` of type `shell`) is the disk record for shell
metadata. Its associated `.pty` stream file (`PtyStreamFile`, §7) is the
disk-backed byte stream used for replay — this is separate from the DB entity.

---

## 3. Backend PTY Creation

`flow_sdk/builtin/faas/pty_actions.py` is mixed into `ComputeNode` and handles
the `terminal-command/<op>` action family.

`start_machine_pty_session()` (`pty_actions.py:223`) does the backend setup:

1. Builds `pty_key = (self.id, self.node_provider_id, shell_id)`.
2. If a `PtyState` already exists for the key, attaches the connection and returns.
3. **Node-local session cap** (`pty_actions.py:27`): `_PTY_CAP = 70`. When a node
   already has ≥ 70 sessions, the oldest `_PTY_EVICT_COUNT = 10` are closed
   (stamps their Shell entity `closed`, then `pty_registry.close_session`). This
   guards macOS's ~511 PTY-device limit. **This eviction is the only reaper that
   actually runs — see the leak note in §11.**
4. Creates the OS PTY via `compute_provider.get_or_create_pty_session(...)`,
   passing the `on_pty_output` callback. Spawn errors are **re-raised** with the
   root cause (e.g. `Command not found: 'codex'`) rather than flattened to a bool.
5. Registers a `PtyState` via `pty_registry.generate_session(...)`.
6. Creates/updates the `ShellRecord`, then wires a fresh `PtyStreamFile` into
   `PtyState.pty_stream_file` at `shell_pty_stream_path(record.id, pty_pid)`, seeded
   with the initial `cols`/`rows` (the framed header). Resumes the seq counter to
   `pty_stream_file.max_seq()` so seqs stay monotonic across a server restart that
   respawns into the same file.
7. Write-through creates/updates the `Shell` DB entity (tab order for new tabs,
   compute-node binding, `attach_child`).
8. Appends `shell_id` to `ComputeNode.active_pty_sessions`.
9. Broadcasts a `data_op_msg` UPDATE with the full compute-node model dump.

### The output callback (`on_pty_output`)

Runs on the OS read thread for every read chunk. It:

1. Advances `PtyState.seq` (`next_seq()`) — a bare counter; **no bytes are stored
   in memory**.
2. Writes `(data, seq)` to the `.pty` **stream file** for replay persistence.
3. Feeds any registered `Pty.output()` async queues (used by non-WS consumers).
4. Schedules a coroutine on the main loop that fans the chunk out to every
   **ATTACHED** `connection_id` via `_send_pty_output_to_client(...)`.

### The local provider spawn (`desktop/provider.py`)

| Platform | PTY implementation |
|----------|--------------------|
| Windows | `winpty.PtyProcess` (pywinpty) |
| macOS/Linux | `ptyprocess.PtyProcess` |

Shell selection when no `spawn_args` are supplied:

- Windows prefers `pwsh`, then `powershell` (spawned `-NoProfile -NoLogo`), then `cmd.exe`.
- Unix uses `$SHELL` when it points at an existing executable.
- macOS falls back to `/bin/zsh`; Linux to `/bin/bash` (`--norc --noprofile`) or `/bin/sh`.
- **zsh is spawned with no `-l`** (avoids `.zprofile`/`.zlogin` PTY hangs — see the
  `zsh -l blocks PTY` project note) and with `ZSH_DISABLE_COMPFIX=true` and
  `ZDOTDIR=~`.

When `spawn_args` *are* supplied, that exact argv is spawned directly — this is
**direct agentic PTY mode**, where the worker executable *is* the PTY process.

`find_command()` resolves argv[0] against the **child's** PATH before spawning, so
a missing binary fails fast with `Command not found: 'x'` instead of a deep
ptyprocess/winpty traceback. Resolve + `makedirs` + `PtyProcess.spawn` all run in
**one worker thread** (`asyncio.to_thread`) so the event loop keeps serving while a
worker boots (spawning on the loop previously froze the backend ~15 s per start).

Environment (`_build_interactive_pty_env`, `provider.py:70`): inherits `os.environ`
minus color-suppressors (`NO_COLOR`, `NODE_DISABLE_COLORS`, `CODEX_CI`, falsey
`CLICOLOR*`/`FORCE_COLOR`), and **strips the whole `CLAUDECODE*` / `CLAUDE_CODE_*`
family plus `ENABLE_IDE_INTEGRATION`** (so a nested `claude` runs as a clean
top-level session and writes its own transcript). Always sets:

- `TERM=xterm-256color`
- `COLORTERM=truecolor` (unless already set)
- `FLOWPAD_PTY_SESSION_ID=<shell_id>`

A daemon read thread loops `pty_process.read(1024)`, normalizes to bytes, and
calls `on_output(data_bytes)`. On process exit it calls the optional
`on_exit(exit_code)` from that thread. The provider retries `send_pty_input` /
`resize_pty` **once** by re-spawning if it finds the process dead (using the
stored `on_output` callback).

---

## 4. WebSocket Transport

### Endpoint

```text
ws://<host>/api/v1/connect/ws/{connection_id}
```

`ConnectionManager` mints `connection_id` with `uuidv4()`, derives the URL from the
SDK config base, converts `http(s)`→`ws(s)`, and sets `binaryType="arraybuffer"`.

On accept, `websocket.py`:

1. Accepts the WebSocket and stores it in `_active_connections` (as `ConnectionInfo`,
   which also tracks per-tab `visible`/`focused` presence and `browser_context`).
2. **Resumes PTY membership**: `_dispatch_pty_ws_lifecycle(connection_id, "connect")`
   → `PtyRegistry.on_ws_connect` (DETACHED → ATTACHED for any parked subscription;
   no-op for a fresh id).
3. Sends a confirmation `response_msg`.

On disconnect (the endpoint's `finally`), it removes the connection, cleans up
watches and hub context-watches, and **parks** PTY membership:
`_dispatch_pty_ws_lifecycle(connection_id, "disconnect")` → `on_ws_disconnect`
moves the id ATTACHED → DETACHED on every `PtyState` (kept, not discarded). The
PTY is never touched by a transport drop.

### Message Dispatch

`ts_sdk/src/websocket.ts` dispatches by `message_type`:

| Message type | Client handler |
|--------------|----------------|
| `response_msg` | Resolves/rejects the pending REST-over-WS request; unwraps a nested `pty_output_msg` when there is no matching request. |
| `pty_output_msg` | Emits `on_pty_output_msg`. |
| `data_op_msg` | Emits `on_data_op`. |
| `recovered_msg` | Emits `on_recovered` (post-restart worker respawn — see §9 / pty-sync.md). |
| `flow_data_msg` / `transcript_msg` / `control_msg` / `oauth_msg` / `llm_config_msg` / `ui_command` | Emit their respective events. |

Client→server fire-and-forget messages (no reply): `presence` (visible/focused),
`browser_context` (per-tab data-context snapshot), `ping`/`echo`/`broadcast`,
`hangup`. Binary frames are msgpack stream frames, separate from PTY output; **PTY
output is JSON text with base64 data**, not binary frames.

### Reconnect

Unexpected close triggers indefinite reconnect with exponential backoff + jitter:

```text
delay = min(500ms * 2^(attempt - 1), 10000ms) + random(0, 1000ms)
```

There is no hard retry cap. On successful reconnect it emits `on_reconnected`.
`DataManager` re-registers watched entities on `on_open`.

**PTY membership is backend-owned.** There is no per-Shell static listener and no
client re-attach on reconnect: `on_ws_connect` restores delivery server-side. The
only client reaction is in `InteractiveTerminal` — on `on_reconnected` it re-runs
its attach handshake to **repaint the gap** (re-fetch + replay the framed stream,
seq-deduped) and re-subscribe its renderer. It issues **no** backend attach call
from there.

---

## 5. REST Over WebSocket

Terminal operations use REST-over-WebSocket frames:

```json
{
  "message_type": "rest_api_msg",
  "message_id": "<uuid>",
  "method": "POST",
  "target_typeid": { "type": "compute_node", "id": "<compute_node_id>" },
  "action": "terminal-command",
  "sub_path": "attach",
  "body": { "shell_id": "<shell_id>", "pty_id": "<pty_id>", "connection_id": "<connection_id>", "cols": 120, "rows": 32 }
}
```

`flow_sdk/server/routes/ws_rest.py` runs the message through the graph action
handler with context fields `request_message_id = message_id` and
`request_connection_id = connection_id`. If an action returns
`ApiResponse(data=<ResponseMessage>)`, `ws_rest.py` sends that nested `response_msg`
directly; otherwise it wraps the `ApiResponse` payload.

`ConnectionManager.sendRestApiMessage()` stores a pending request by `message_id`
and resolves it when a `response_msg.response_message_id` matches. Default timeout
is 30 seconds.

---

## 6. PTY Operations

### Open / Start

The TypeScript `Shell.start()` calls the Shell entity `open` action
(`POST /api/v1/graph/shell/{shell_id}/open`) with `{connection_id, cols, rows,
working_dir?}`. Backend path:
`Shell._http_open() → Shell.start(...) → ComputeNode.create_pty(...) →
start_machine_pty_session(...)`. The frontend then calls `Shell.attachPty(...)`.

`terminal-command/start` still exists for lower-level compute-node callers (needs
`shell_id` + a connection id from context or body).

### Attach (no byte replay)

Frontend path:

```text
Shell.attachPty(...)
  -> PtyConnection.attach(ptyId, {cols, rows, force?, timeout?})
  -> PtyConnection._reattach(ptyId, cols, rows)
  -> dataManager.callActionOverWS(terminal-command/attach)
```

Attach body: `{shell_id, pty_id, connection_id, cols?, rows?}`. There is **no
`since_seq`** anymore.

Backend `_attach_pty_session()` (`pty_actions.py:728`):

1. Resolves the `Pty` handle via `get_pty(pty_id)`. Missing → returns
   `PtySessionStatusMessage(status="not_found")`; the client sets `started=false`
   and `attach()` throws.
2. `pty_handle.attach(connection_id)` — registry marks the id ATTACHED, so live
   output starts flowing to this connection.
3. `pty_handle.repaint(cols, rows)` — the **only** "replay-ish" step: it asserts
   the client's size (a real resize → SIGWINCH) when different, else jiggles the
   winsize at the current size (`force_repaint`, `base_pty_state.py:77`), forcing
   the running TUI (claude/vim/readline) to redraw its **live** frame. `0`/missing
   dims → no size override. Best-effort — the attach succeeds regardless.
4. Returns `PtySessionStatusMessage(status="reattached", latest_seq=<PtyState.seq>)`.

`PtyConnection._reattach` does **not** reset `lastSeq`; `clear()` (which zeroes it)
runs only when attaching to a *different* pty id, so reconnect to the same pty
preserves the dedup cursor. After a successful attach it flushes the
`ptyOrphanBuffer` for this shell.

### History Replay (disk-backed, over HTTP)

Full scrollback restore is a **separate transport** from attach, orchestrated by
`InteractiveTerminal`'s `onConnected` (`InteractiveTerminal.tsx:1061`):

```text
fetchPtyStream(ptyId)   ->  GET /api/v1/shell/{shell_id}/pty-stream   (pty_stream.py)
replayPtyStream(stream) ->  headless xterm @ recorded sizes -> serialize
term.reset(); term.write(historySerialized)                          (visible xterm)
+ write live chunks with seq > historyLastSeq (dedup vs replay)
subscribe live output; assert client size (resize)
```

`GET /shell/{id}/pty-stream` (`pty_stream.py`) reads the `.pty` file via
`PtyStreamFile.read_frames()` and returns the framed JSON (`{v, cols, rows,
events}`) in the standard envelope; 404 when no record / no pty / no stream.

`replayPtyStream` (`pty-replay.ts`) replays frames through an
`@xterm/headless` terminal **at the recorded sizes** (applying `["r", …]` resize
frames), then `SerializeAddon.serialize()`s the result. Two fuzz-derived
disciplines: (a) decode with a **streaming** `TextDecoder` before `term.write`
(xterm's Uint8Array path drops split multi-byte chars, xterm.js#6003); (b) flush
queued output before each resize so resizes can't overtake output. Legacy `v0`
streams (unknown size) return `null` — replay would garble at a guessed width, so
history is skipped and the session goes live-only.

Live chunks accumulated since attach (`shell.getPtyChunks()`) are then written,
skipping any `chunk.seq <= historyLastSeq` (the framed file records the same
per-session `seq` as the WS chunks, so the two streams dedup cleanly). Skipped
chunks are still decoded so the streaming-decoder's partial-char state stays
aligned across the boundary.

### Output

Backend live-output flow (per attached connection):

```text
OS read thread -> on_pty_output(bytes)
  -> PtyState.next_seq()
  -> PtyStreamFile.write(data, seq)          # disk persistence (replay source)
  -> Pty.output() queues                     # non-WS consumers
  -> _send_pty_output_to_client(...)          # one send per ATTACHED connection_id
```

`PtyOutputMessage`: `{message_type:"pty_output_msg", provider_node_id, shell_id,
data:"<base64>", seq, timestamp_ms}`, wrapped in a `response_msg`
(`content = pty_output_msg`) with a fresh `message_id`. A send to a closed socket
(tab closed mid-stream) is logged at debug, not warning — the PTY keeps running.

Frontend: `ConnectionManager.on_pty_output_msg → DataManager.onPtyOutputMessage →
cached Shell.ptyConnection.routeOutput → appendOutput`. If the `Shell` is not yet
cached, `DataManager` buffers the chunk in `ptyOrphanBuffer` (limits: 200 chunks /
shell, 5 MB total, 30 s max age), flushed after attach.

### Input / Resize

Input: `Shell.sendInput → PtyConnection.sendInput` (only when `isLive`:
`started && !restarting && dataContext.isConnected`) → `terminal-command/input`
`{shell_id, data}` → `_send_pty_input → pty.write(data.encode()) →
provider.send_pty_input → PtyProcess.write`. (Backend `Shell.write(text)` differs
from browser input: it waits for idle, appends CR, and writes a command;
`Shell.write_raw(bytes)` sends raw.)

Resize: `terminal-command/resize` `{shell_id, cols, rows}` → `_resize_pty →
pty.resize → provider.resize_pty → PtyProcess.setwinsize(rows, cols)`. `PtySession.resize`
**skips when cols/rows are unchanged** (avoids spurious SIGWINCH / zsh redraw
artifacts). Each real resize also appends an `["r", …]` frame to the `.pty` file
so replay interprets subsequent output at the right width.

### Close / Detach / Disconnect

**Transport disconnect and intent-close are different** — this is the core of the
membership FSM (`pty_session_manager.py`):

| Case | Behavior |
|------|----------|
| **WS disconnect** | `on_ws_disconnect` **parks** the id (ATTACHED → DETACHED, kept). Arms the orphan timer if it was the last attached connection. PTY stays alive. |
| **WS reconnect** | `on_ws_connect` **resumes** the id (DETACHED → ATTACHED). Delivery restarts, no client action. |
| `terminal-command/close` (explicit) | Marks Shell entity + record `closed`, then `pty.close_for_connection(connection_id)` — removes that connection and destroys the `PtyState` (+ OS PTY) **only if none remain**. Idempotent when the pty is already gone. |
| `Shell.close()` / `pty.close()` | Permanent teardown: kill OS PTY, delete the `.pty` stream file, close the shell record, drop the `PtyState`. |
| `pty.kill()` | Crash simulation: kill OS PTY + drop `PtyState`, but **keep** the DB row and `.pty` file (identical to a real SIGKILL, so restart recovery can respawn). |

`close_session` (registry) also transitions the `ShellRecord` to CLOSED, deletes
the stream file, and closes the OS PTY via the provider.

> **Reaper status (important).** `PtyRegistry.start_cleanup_task` /
> `cleanup_expired_sessions` implement two bounded reapers (orphan-TTL close +
> parked-grace drop), but **no production code calls `start_cleanup_task`** — it is
> invoked only from unit tests. In a running backend these reapers do **not** run,
> so the doc-claimed "nothing leaks" guarantee does not hold. The only bound on
> `PtyState` accumulation is the `_PTY_CAP = 70` FIFO eviction in
> `start_machine_pty_session`, plus explicit close, provider death, and restart.
> See §11.

---

## 7. Replay Persistence And Sequence Numbers

Replay is served from a **disk-backed framed stream file**, not an in-memory
buffer: `flow_sdk/compute/providers/desktop/pty_stream_file.py`. One `.pty` file
per shell, at `shell_pty_stream_path(record.id, pty_pid)`.

Format — JSONL, one JSON value per line:

```text
{"v": 1, "cols": 100, "rows": 30}       # header: version + initial winsize
["o", "<base64 output chunk>", 42]       # output frame (one PTY read) + seq
["r", [80, 24]]                          # resize frame (cols, rows)
```

Why framed (both fuzz-validated, `tests/pty_fuzz/`):

1. **Resize events at exact stream positions** — output is calibrated to the
   winsize in effect when emitted; replaying at another width garbles
   cursor-relative TUI repaints. Every winsize change (including the attach-time
   repaint jiggle) is recorded.
2. **Frame-boundary truncation** — the rolling cap drops whole frames from the
   front (never splitting an escape sequence) and rewrites the header to the
   winsize in effect at the first retained frame.

| Limit | Value |
|-------|-------|
| Max file size | 10 MB on-disk (~7.5 MB raw output after base64) |
| Truncate-to fraction | 0.75 of max (amortizes compaction) |
| Sequence start | 1 (0 = no output yet) |

`PtyState.seq` is a monotonic **counter only** (no bytes). It is written into each
output frame and each `pty_output_msg`. At (re)spawn the counter resumes past
`PtyStreamFile.max_seq()` so seqs stay monotonic within one file across a server
restart — otherwise the frontend's `chunk.seq <= lastSeq` dedup would wrongly drop
post-restart output ("PTY looks dead after restart").

Legacy handling: pre-framing raw files (first byte ≠ `{`) surface as `v0` with a
single output frame and `cols/rows = None`. "Chimera" files (raw prefix + a framed
tail appended by a pre-upgrade build) are salvaged from the tail's first resize
frame; the writer upgrades a legacy file to `v1` in place before its first append.

Frontend sequence handling (`PtyConnection.appendOutput`): drop when
`seq <= lastSeq && lastSeq > 0`; else update `lastSeq`, store decoded bytes in the
`chunks: Map<number, OutputChunk>`, and (once `_attached`) notify live listeners.
The framed-stream replay path (`replayPtyStream`) tracks its own `lastSeq` used as
the dedup boundary against live chunks.

> The `.pty` file survives a server restart; the in-memory `PtyState` does not.
> `PtySessionStatusMessage.replay_truncated` exists and defaults to `false`, but
> nothing computes it — front-truncation is silent to the client.

---

## 8. Encoding

PTY output is binary-safe over JSON:

| Segment | Format |
|---------|--------|
| OS PTY → read thread | Raw bytes or `str` normalized to bytes |
| read thread → stream file | Base64 output frame + seq |
| stream file / live → WebSocket | Base64 in `PtyOutputMessage.data` |
| WebSocket frame | JSON text |
| client decode | `base64ToBytes` → `TextDecoder('utf-8',{fatal:false})` streaming |
| terminal listener | Decoded UTF-8 string |

Both the live `PtyConnection` decoder and the replay decoder use `{stream: true}`
so partial multi-byte UTF-8 characters split across chunks are preserved.

Input reverse path: JS string → JSON `data` → `data.encode("utf-8")` → bytes on
Unix / `str` on Windows.

---

## 9. Browser Shell Runtime

`ts_sdk/src/entities/shell.ts` eagerly constructs `this.ptyConnection`. The wrapper
delegates: `start` (open action, then `attachPty`), `attachPty → PtyConnection.attach`,
`sendInput`, `resize`, `onOutput` (only after `_attached`), `getPtyChunks`.

`attachPty` is the **one-time intent** ("this connection wants to view this PTY"),
deferred until the tab is active at least once. There is no client shell registry
and no client reaction to WS close for membership — that is fully backend-owned.

Reconnect behavior (backend-driven), as wired in `InteractiveTerminal`:

1. WS closes → `onDisconnected` cancels any in-flight replay (`connectGen++`),
   unsubscribes output, `setShellReady(false)`. The PTY pipeline stays armed.
2. Backend `on_ws_disconnect` parks this id.
3. `ConnectionManager` reconnects with backoff.
4. Backend `on_ws_connect` resumes the id; live output flows again — **no client
   re-attach call**.
5. `on_reconnected` (and the distinct `on_recovered`, see pty-sync.md) re-run
   `onConnected`: fetch + replay the framed stream, dedup live chunks by seq,
   re-subscribe, and assert the client size. `connectGen` makes a newer connect
   supersede an in-flight one.

There is no localStorage `lastSeq` persistence; gap recovery is the framed-stream
replay keyed on the per-session `seq`.

---

## 10. Interactive PTY Mode Vs Headless CLI Mode

### Interactive PTY Mode

Used when an `AgenticProcess` is visible in the shell UI. It has a `Shell` and a
live PTY. Two launch styles (`agentic_process.py`):

| Setting | Behavior |
|---------|----------|
| `shell_mode=False` | Default. **Direct spawn**: the worker executable is the PTY process (`Shell.start(spawn_args=…, extra_env=…)`, `set_worker_pid_direct`). |
| `shell_mode=True` | Legacy shell intermediary: start a shell, then inject the worker command and poll for the child pid. |

Both go through the replay stream file + WS output routing; browser I/O uses
`PtyConnection`; `AgenticProcess.prompt(...)` writes to the live PTY.

### Headless CLI Mode

`AgenticProcess.prompt(...)` when `visible=False` routes to
`self.driver.headless_prompt(...)` — no Shell, no PTY, no WS replay. Driver
headless implementations run CLI print/exec modes and return structured output.
The bridge between modes is the worker `session_id`/transcript identity, not the
PTY transport: a process can preserve `session_id` and, on becoming visible, resume
or fork the transcript.

---

## 11. Lifecycle Holes & Robustness Concerns

For a later architecture review. Each is grounded in the code read for this doc.

1. **The orphan/parked reapers do not run in production.**
   `PtyRegistry.start_cleanup_task` is defined but has **no caller** outside unit
   tests (`grep` confirms only `tests/unit/test_pty_session_manager.py` and the
   class's own `cleanup_loop`). So `cleanup_expired_sessions` never fires in a
   running backend. Consequences: a `PtyState` with all connections parked/detached
   is **not** closed after the 900 s orphan TTL, and stale `detached_connections`
   entries are **never** grace-reaped. The class docstring and prior versions of
   this doc claim "nothing leaks" — that is currently false. Only mitigations that
   actually run: the `_PTY_CAP = 70` FIFO eviction, explicit close, provider death,
   and server restart. *Either wire `start_cleanup_task` at startup or delete the
   dead code and document the cap as the real bound.*

2. **`PtyState` created without a connection never arms the orphan timer.**
   `is_expired` returns `False` while `last_detached_at is None`, and that field is
   set only when the *last attached* connection parks/detaches. A session created
   with `connection_id=None` that is never attached (or whose only connection
   dropped before attaching) keeps `last_detached_at = None` forever → even if the
   reaper were running, it would never reap this one. `created_at` exists but no
   reaper consults it.

3. **Unbounded client-side `chunks` map during one live session.**
   `PtyConnection.chunks` (keyed by seq) accumulates every live chunk with **no
   cap** until `clear()` (which runs only on attach to a *different* pty). A single
   long-running, high-output session grows browser memory unbounded within that
   session. The disk `.pty` file is capped (10 MB); the in-browser map is not.

4. **`replay_truncated` is dead metadata.** `PtySessionStatusMessage.replay_truncated`
   defaults `false` and is never computed. When the 10 MB front-truncation drops
   early scrollback, the client silently shows partial history with no signal.

5. **Two-transport replay is eventually-consistent, not atomic.** History comes
   over HTTP (`/pty-stream`, reads the disk file) while live output comes over WS;
   they are reconciled purely by per-session `seq` dedup. This is sound *because*
   the read thread writes the disk frame before scheduling the WS send (disk ≥ WS),
   but it depends on that ordering and on seq monotonicity across restart
   (`max_seq()` resume). Any path that writes a WS chunk without a corresponding
   disk frame, or resets seq, would produce a replay/live gap or duplicate.

6. **Provider retry re-spawns a *bare shell* on a dead agentic PTY.**
   `send_pty_input`/`resize_pty` retry once via `get_or_create_pty_session(...)`
   **without** the original `spawn_args`/`extra_env` — so a dead *direct-spawn
   agentic* PTY would be resurrected as a plain shell, not the worker. In practice
   the recovery watchdog (`pty_recovery.py`, with `--resume`) is the intended
   respawn path; the provider retry is aimed at plain shells. Worth confirming the
   agentic case can't hit the provider retry first.

7. **Membership FSM scans all states on every WS connect/disconnect.**
   `on_ws_connect`/`on_ws_disconnect` iterate **every** `PtyState`
   (`for pty_key, state in list(self.states.items())`). Bounded by the 70-session
   cap today, but it is O(sessions) per transport event across all nodes.

8. **`.pty` stream files outlive leaked sessions.** A `PtyState` that leaks (item 1)
   or whose Shell record is never closed leaves its `.pty` file on disk (bounded at
   10 MB each) until an explicit close deletes it. Bounded per-file, unbounded in
   count if sessions leak.

---

## 12. Key Files Index

| File | Purpose |
|------|---------|
| `flow_sdk/builtin/shell.py` | Shell entity, PTY metadata, open/close/run, worker-PID tracking, `shell_pty_stream_path`. |
| `flow_sdk/builtin/faas/pty_actions.py` | ComputeNode PTY actions: start, attach (repaint, no replay), input, resize, close, list, rename, ping, output routing, session cap. |
| `flow_sdk/builtin/faas/pty_session.py` | `Pty` abstract handle interface. |
| `flow_sdk/compute/providers/base_pty_state.py` | Shared `PtySession` body: write, resize, repaint/force_repaint (jiggle), output queues, attach/detach/close/kill, `latest_seq`. |
| `flow_sdk/compute/providers/desktop/local_pty_session.py` | Trivial local-provider handle subclass. |
| `flow_sdk/compute/providers/desktop/provider.py` | OS PTY spawn (shell selection, env scrub, threaded spawn), read thread, provider write/resize/close/list, dead-process retry. |
| `flow_sdk/compute/providers/desktop/pty_session_manager.py` | `PtyRegistry` + `PtyState`: membership FSM (attach/detach, `on_ws_connect`/`on_ws_disconnect`), seq counter, **unwired** reapers. |
| `flow_sdk/compute/providers/desktop/pty_stream_file.py` | Framed `.pty` disk stream: write/resize frames, 10 MB front-truncation, legacy upgrade/salvage, `read_frames`/`max_seq`. |
| `flow_sdk/server/routes/websocket.py` | WS endpoint, dispatch, presence/browser_context, membership FSM hooks. |
| `flow_sdk/server/routes/ws_rest.py` | `rest_api_msg` execution context + response wrapping. |
| `flow_sdk/server/routes/pty_stream.py` | `GET /shell/{id}/pty-stream` — framed history for replay. |
| `flow_sdk/server/pty_recovery.py` | Post-restart dead-worker respawn (on-demand) — see pty-sync.md. |
| `flow_sdk/api/messages.py` | `PtyOutputMessage`, `PtySessionStatusMessage`, `ResponseMessage`, message-type enums. |
| `ts_sdk/src/entities/shell.ts` | Shell wrapper, eager `PtyConnection`, open/attach/input/resize delegation. |
| `ts_sdk/src/services/shell/ptyConnection.ts` | Client PTY runtime: attach handshake (no replay), seq dedup, streaming decode, triggers/line stream. |
| `ts_sdk/src/services/shell/ptyOrphanBuffer.ts` | Pre-cache output buffer. |
| `ts_sdk/src/websocket.ts` | WS client, reconnect loop, dispatch, REST-over-WS pending map. |
| `ts_sdk/src/FlowSync/store.ts` | DataManager PTY output routing, watch re-registration. |
| `ui/src/components/terminal/interactive-terminal/pty-replay.ts` | `fetchPtyStream` + `replayPtyStream` (headless-xterm replay at recorded sizes). |
| `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx` | Attach orchestration: connect/disconnect/reconnect/recovered handshakes. |
| `flow_sdk/builtin/agentic_process/agentic_process.py` | Interactive (direct-spawn / legacy shell) vs headless routing. |
</content>
