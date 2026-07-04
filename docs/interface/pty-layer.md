---
id: 8a2e3132-0493-545a-9acc-2f2faed61a69
---

# PTY layer — interface

The internal PTY layer runs interactive terminal/agent processes on the local
machine, persists their output for faithful replay, and fans live output to the
WebSocket connections that have declared intent to watch. It has **no entity
actions of its own** — it is surfaced to clients through `ComputeNode`'s
`PtyActionsMixin` (see [Transport endpoints](#transport-endpoints)).

This file is the API surface. For the lifecycle narrative see
[../agent-management/pty-websocket.md](../agent-management/pty-websocket.md); for
the recovery/replay story see [../pty-sync.md](../pty-sync.md). Flows are linked
from [Flows](#flows) (see `./flows.md`).

Source: `flow_sdk/compute/providers/desktop/` (PTY runtime),
`flow_sdk/builtin/faas/` (ComputeNode actions + `Pty` handle),
`flow_sdk/server/routes/` (transport), `ts_sdk` + `ui` (frontend consumers).

---

## Python objects & API

### `PtyState` / `PtyRegistry` — membership FSM (`desktop/pty_session_manager.py`)

`PtyRegistry` is a per-process singleton (`pty_registry` module global,
`get_instance()`), holding one `PtyState` per running PTY keyed by
`PtyKey = (compute_node_id, provider_node_id, shell_id)`. The PTY process is
decoupled from any connection — a dropped socket never kills the shell. The FSM
is driven entirely by the WS lifecycle and the terminal-command actions.

`PtyState` fields: `pty_key`, `attached_connections: set[str]` (receive live
output), `detached_connections: dict[str, float]` (parked, `connection_id →
detached_at`), `seq` (monotonic output-chunk counter), `cols`/`rows`, `name`,
`pty_stream_file`, `output_queues` (feeds `Pty.output()`), timestamps.
Helpers: `next_seq()`, `mark_attached(cid)`, `is_attached`, `connection_id`
(compat: first attached or None).

| `PtyRegistry` method | Semantics |
| --- | --- |
| `generate_session(pty_key, cn_id, connection_id, cols, rows)` | Get-or-create the `PtyState`; adds `connection_id` to attached, refreshes activity. |
| `get_session(pty_key)` | Lookup, `None` if absent. |
| `attach(pty_key, connection_id)` | DETACHED/NONE → ATTACHED (`mark_attached`); raises `KeyError` if no state. |
| `detach(pty_key, connection_id=None)` | Remove one (or all) from `attached_connections`; arms orphan TTL when none remain. Does not park. |
| `on_ws_connect(connection_id)` | WS accept: resume — DETACHED → ATTACHED on every state that parked this id. Idempotent; no-op for a fresh id. |
| `on_ws_disconnect(connection_id)` | WS drop: park — ATTACHED → DETACHED on every state; keeps the subscription; arms orphan TTL. PTY untouched. |
| `close_for_connection(pty_key, connection_id)` | Drop this connection; `close_session` only if it was the last. |
| `close_session(pty_key)` | Destroy: transition Shell record → CLOSED, delete `.pty` file, provider `close_pty_session`, drop state. |
| `is_expired(state, ttl)` | `True` if detached longer than `ttl` (never while attached). |
| `cleanup_expired_sessions(ttl=900, detach_grace=900)` | Two bounded reapers: close orphan states (no attached > ttl); drop stale parked ids (> grace). |
| `start_cleanup_task(interval=120, ttl=900)` / `stop_cleanup_task()` | Background reaper loop lifecycle. |

> **Caution — the reapers do not run in production.** `start_cleanup_task` has
> **no production caller** (arch-review CONFIRMED). `cleanup_expired_sessions`,
> `is_expired`, and the detach-grace logic are therefore dormant; the only live
> backstop against PTY leaks is the **`_PTY_CAP` FIFO eviction** in
> `start_machine_pty_session` (see below). Orphaned-but-attached-once states are
> never TTL-reaped.

### `PtyStreamFile` — framed rolling buffer (`desktop/pty_stream_file.py`)

Persists PTY output to a `.pty` JSONL file so a client can faithfully **replay**
after reattach (refresh / server restart). Frame format: header
`{"v":1,"cols":C,"rows":R}`, then output frames `["o", "<b64>", seq]` and resize
frames `["r", [cols, rows]]`. Every winsize change (including the attach-time
jiggle) is recorded so replay interprets output at the correct width. Rolling cap
is **10 MB on-disk** (~7.5 MB raw after base64), truncated **at frame
boundaries** from the front (never splitting an escape sequence), rewriting the
header to the winsize in effect at the first retained frame.

| Method | Semantics |
| --- | --- |
| `write(data, seq=None)` | Append an output frame (from the PTY read thread); creates file + header on first write. |
| `write_resize(cols, rows)` | Append a resize frame (from the event loop). |
| `read_frames()` | `{"v","cols","rows","events"}` or `None`. Legacy raw files → v0 (size `None`); salvages framed tails of chimera files. |
| `max_seq()` | Highest persisted output-frame seq (0 if none) — used to reseed `seq` on respawn. |
| `read_all()` | Concatenated raw output bytes (resize frames excluded) — forensics/tests only. |
| `delete()` / `exists` / `size` | Lifecycle + on-disk introspection. |

Legacy handling: a non-`{` first byte marks a pre-framing raw file; the writer
upgrades it in place before its first append, and readers salvage a contiguous
framed tail from its first resize frame. A torn final line (crash mid-write) is
dropped silently. Concurrent appends are serialized by a small lock (output
frames from the read thread, resize frames from the loop).

### `LocalComputeProvider` — PTY surface (`desktop/provider.py`)

Owns the actual OS PTY processes in `_pty_processes: {(provider_node_id,
session_id) → {pid, process, running, read_thread, on_output}}`. A daemon read
thread pumps `on_output(bytes)` for each 1 KB read and fires `on_exit(code)` on
death.

| Method | Semantics |
| --- | --- |
| `get_or_create_pty_session(pn_id, session_id, on_output, rows, cols, working_dir, on_exit, spawn_args, extra_env)` | Spawn (or return) the PTY. Resolve+spawn run in **one worker thread** (`asyncio.to_thread`) — spawning on the loop previously froze the backend ~15s per "Start Claude". `spawn_args=None` → detect the user's default shell; otherwise exact argv. |
| `send_pty_input(pn_id, session_id, data, cols, rows)` | Write bytes to PTY stdin. |
| `resize_pty(pn_id, session_id, cols, rows)` | `setwinsize(rows, cols)`. |
| `is_pty_alive(pn_id, session_id)` | Sync liveness (`os.kill(pid,0)` / `psutil.pid_exists`). |
| `get_pty_shell_pid(pn_id, session_id)` | OS PID of the shell, or `None`. |
| `close_pty_session(pn_id, session_id)` | `terminate(force=True)` + drop process entry. |
| `get_pty_session(cn_id, shell_id)` | Return a `LocalPtySession` handle if a registry state exists. |
| `list_pty_sessions(cn_id)` / `reset_all_sessions(cn_id, pn_id)` | Registry-backed listing / wipe-all in-memory state. |

**Env construction** (`_build_interactive_pty_env(session_id, extra_env)`):
inherits `os.environ`, then **strips** the `CLAUDECODE*` / `CLAUDE_CODE_*` family
and `ENABLE_IDE_INTEGRATION` (so a nested `claude` runs as a clean top-level
session and actually writes its transcript), strips inherited no-color markers
(`NO_COLOR`, `CODEX_CI`, …), sets `TERM=xterm-256color`,
`COLORTERM=truecolor`, and `FLOWPAD_PTY_SESSION_ID`. Shell spawn: **zsh without
`-l`** (`.zprofile`/`.zlogin` block the PTY on this machine) with
`ZDOTDIR=~` + `ZSH_DISABLE_COMPFIX`; **bash** with `--norc --noprofile`.
`extra_env` always wins last.

> **Caution — respawn drops `spawn_args`.** `send_pty_input` / `resize_pty` retry
> once on a dead process by calling
> `get_or_create_pty_session(..., on_output, rows, cols)` **without the original
> `spawn_args`/`extra_env`/`working_dir`** — so an agent PTY (e.g. `claude`,
> `codex`) respawns as a **bare shell** at the default cwd (arch-review CONFIRMED
> hazard).

### `Pty` handle — `LocalPtySession` / `PtySession` base (`faas/pty_session.py`, `providers/base_pty_state.py`)

`Pty` (ABC in `faas/pty_session.py`) is the handle returned by
`ComputeNode.get_pty()` / `create_pty()`. `PtySession` (in
`providers/base_pty_state.py`) is the shared body wrapping the provider +
`PtyRegistry`; `LocalPtySession` is a trivial typed subclass. Surface:
`is_alive`, `await write(data)`, `await resize(cols, rows)` (same-size no-op to
avoid spurious SIGWINCH), `output()` (async iterator over live chunks via a
per-session queue), `await repaint(cols, rows)` / `await force_repaint()`
(attach-time resize-or-jiggle so a blank terminal redraws — see `.md` note on the
50 ms jiggle), `latest_seq`, `await attach(id)` / `detach(id)` / `connections`,
`name` (r/w), `cols`/`rows`, `await kill()` (crash sim: evict state + kill OS
process, leave DB/`.pty`), `await close()` (permanent teardown),
`close_for_connection(id)`.

### `PtyActionsMixin` — ComputeNode surface (`faas/pty_actions.py`)

Mixed into `ComputeNode`; provides the `@action` bodies (the stubs live in
`faas/compute_node.py`). Key non-action method: `start_machine_pty_session(...)`
— spawns via the provider, wires the `on_pty_output` callback (assigns `seq`,
writes the `.pty` file, feeds `output_queues`, fans to `attached_connections`),
registers the `PtyState`, creates/updates the Shell record + `PtyStreamFile`,
reseeds `seq` from `max_seq()`, and enforces the **`_PTY_CAP=70` FIFO eviction**
(closes the 10 oldest when the cap is hit — the only live leak backstop).
`create_pty(...)` / `get_pty(shell_id)` return `Pty` handles.

---

## Transport endpoints

This layer's equivalent of backend actions. All PTY client operations route
through **one** ComputeNode action, `terminal-command`, sub-pathed by operation.

### `POST /api/v1/graph/compute_node/<id>/terminal-command/<op>`

Dispatched by `_pty_terminal_command`; each op delegates to a provider/handle
method. `connection_id` comes from the WS request context (or `body.connection_id`
for REST callers).

| op | Body | Semantics |
| --- | --- | --- |
| `start` | `shell_id, cols, rows, name?, working_dir?, connection_id?` | Spawn + register (`start_machine_pty_session`). Spawn errors raise the root cause (e.g. `Command not found: 'codex'`). |
| `attach` | `pty_id`/`shell_id, cols?, rows?, connection_id?` | Reattach: `attach` + `repaint`. **No byte replay** — client mounts blank and replays via the HTTP route; returns `reattached`+`latest_seq`, or `not_found` after a restart. |
| `input` | `shell_id, data` | Write bytes to PTY stdin (`Pty.write`). |
| `resize` | `shell_id, cols, rows` | Resize (`Pty.resize`; same-size no-op). |
| `close` | `shell_id` | `close_for_connection` — destroys only if the last connection; marks Shell CLOSED. Idempotent. |
| `list` | — | Active sessions for this node, enriched with `agentic_process_id`. |
| `rename` | `shell_id, name` | Update the session's display name. |
| `ping` | `shell_id` | `{alive: bool}` via `is_pty_alive`. |

Adjacent PTY-related ComputeNode actions from the same mixin:
`GET list-shells` (active Shell entities), `GET session-transcript` /
`session-transcript-raw` (Claude JSONL), `GET discovery/<record_type>`,
`POST reset-pty` (wipe in-memory PTY state for the node — mimics a restart),
`POST update-shell` (tab_order/name).

### WS lifecycle dispatch — `_dispatch_pty_ws_lifecycle` (`server/routes/websocket.py`)

The transport driver for the membership FSM. On WS **accept** it calls
`pty_registry.on_ws_connect(connection_id)` (resume parked subscriptions); in the
connection's **finally** block it calls `on_ws_disconnect(connection_id)` (park
them, PTYs stay alive). Membership lives entirely in the backend; the frontend
declares intent once on open and otherwise just renders.

### PTY output flow — `on_pty_output` → client (`faas/pty_actions.py`)

Read thread → `on_pty_output(data)`: assign `seq = state.next_seq()`, write
`["o", b64, seq]` to the `.pty` file, feed `output_queues`, then (on the loop via
`run_coroutine_threadsafe`) for each id in `attached_connections` send a
`PtyOutputMessage` (`_send_pty_output_to_client`) carrying `shell_id`, base64
`data`, `seq`, `timestamp`. A closed socket is logged at debug (the PTY keeps
running; reattach repaints).

### HTTP replay route — `GET /api/v1/shell/{shell_id}/pty-stream` (`server/routes/pty_stream.py`)

| Aspect | Detail |
| --- | --- |
| Caller | Frontend on terminal mount (`fetchPtyStream`). |
| Returns | `PtyStreamFile.read_frames()` in the standard `{status,data}` envelope. |
| Errors | 404 `shell not found` / `shell has no pty` / `no stream recorded`. |
| Semantics | Serves the framed history for headless-xterm replay before live attach. |

### seq-monotonicity rule

`seq` is a per-session monotonic output-chunk counter. On PTY **respawn**
(recovery into the same `.pty` file) it is reseeded from `PtyStreamFile.max_seq()`
so seqs never regress across a server-process epoch. This underwrites the
frontend's replay-vs-live dedup (`chunk.seq <= replay.lastSeq` is dropped) — a
regressed seq makes the terminal "look dead after a server restart."

---

## Frontend TS interface

Brief here; full detail in `./shell.md`.

### `ts_sdk/src/services/shell/ptyConnection.ts` — `PtyConnection`

The per-terminal client and the **entire** FE PTY transport — all WS I/O goes
through the `terminal-command` action on `compute_node` with sub-paths
`start` / `attach` / `input` / `resize` / `ping` / `close`; there are **no shell
entity actions** in this path. Ingests `PtyOutputMessage` chunks (base64 → bytes
via `base64ToBytes`), gates live output behind an `_attached` flag, and dedups
against the replay tail by `seq`. Exposes `onOutput` / `onReady` /
`onDisconnect` listeners, `status` (`idle|connecting|live|restarting|closed`),
and line/event listeners. Cross-ref `./shell.md` for the full state machine.

Connection membership is **backend-owned**: `PtyRegistry` parks/resumes on the
WS lifecycle, so `PtyConnection` deliberately has **no client WS-close handler**
(a dropped socket parks the subscription; a reconnect of the same id resumes it).
Derived state: `isLive = started && !restarting && dataContext.isConnected`;
`isReady = attached && isLive` (the old `shell.connected`).

### `ui/src/components/terminal/interactive-terminal/pty-replay.ts`

Attach-time history replay of the framed stream:

| Export | Semantics |
| --- | --- |
| `fetchPtyStream(shellId)` | GET the framed stream via `apiClient`; `null` on 404/none. |
| `replayPtyStream(stream)` | Replay through a **headless xterm at the recorded sizes** (applies `["r",[c,r]]` frames), serialize scrollback+screen+cursor, return `{serialized, lastSeq, cols, rows}`. Returns `null` for empty or v0 legacy (unknown-size) streams. |

Disciplines (fuzz-derived): decode bytes with a **streaming `TextDecoder`**
before `term.write()` (xterm's Uint8Array path drops multi-byte chars split
across writes); **flush queued output before every resize** so resizes can't
overtake output. `lastSeq` is the dedup boundary handed to `PtyConnection` so
live chunks already present in the replay are dropped.

---

## Flows

Short pointers into `./flows.md` (sibling agent owns that file):

- **Start a terminal** — `terminal-command/start` → spawn + register + first
  `PtyStreamFile`. See `./flows.md#pty-start`.
- **Reattach after refresh** — `GET /shell/{id}/pty-stream` → `replayPtyStream`
  → `terminal-command/attach` (repaint) → live output. See
  `./flows.md#pty-reattach`.
- **Sleep/wake reconnect** — WS drop parks (`on_ws_disconnect`), reconnect
  resumes (`on_ws_connect`) with no client action. See `./flows.md#pty-resume`.
- **Server-restart recovery** — respawn into the same `.pty`, reseed `seq` from
  `max_seq()`. See `./flows.md#pty-recovery` and [../pty-sync.md](../pty-sync.md).
