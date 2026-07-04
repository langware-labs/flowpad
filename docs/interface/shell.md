---
id: 9aa192ca-c374-5028-96cf-4f460d9efaf2
---

# Shell — interface

The **Shell** is the DB-backed metadata layer for a PTY session (one terminal tab). The
canonical stream data lives on disk in `ShellRecord`; the entity is the SQLite layer that
enables fast queries, relationship tracking (child of `ComputeNode`), and standard graph
CRUD. The entity `id` (a UUID) **is** the session id — there is no separate session field.
TypeId format: `shell-<uuid>`.

Narrative background lives in [docs/shell-claude-session-api.md](../shell-claude-session-api.md)
(worker-CLI / shell-mode narrative) and [docs/agent-management/pty-websocket.md](../agent-management/pty-websocket.md)
(the PTY-over-WS transport). This page is the interface reference only; it cross-links
rather than duplicates.

---

## Python object & API

`flow_sdk/builtin/shell.py` — `class Shell(Entity)` (~:82).

### Fields (persisted `APIField`s)

| Field | Type | Purpose |
| --- | --- | --- |
| `type` | `str` | `shell` (BuiltinEntityType.SHELL) |
| `name` | `str \| None` | Tab display name |
| `status` | `str` | `ShellStatus` value (default `idle`) |
| `workdir` | `str \| None` | PTY working directory |
| `env` | `dict \| None` | Custom environment variables |
| `pty_pid` | `str \| None` | PTY session id (set to `self.id` on spawn) |
| `compute_node_id` | `str \| None` | Owning compute node (id binding) |
| `compute_node_uname` | `str \| None` | Owning compute node (uname binding, preferred) |
| `collaboration_room_id` | `str \| None` | Room this shell is shared into (null = not shared) |
| `agentic_process_id` | `str \| None` | Owning `AgenticProcess` (reverse of `AgenticProcess.shell_id`); set once at creation, lets a bare `/dock/shell/<id>` URL resolve its owner by get-by-id |
| `created_at` | `str \| None` | ISO creation timestamp |
| `error_message` | `str \| None` | Populated when `status=error` |
| `worker_pid` | `int \| None` | OS PID of the running worker process |
| `worker_name` | `str \| None` | Worker executable name (e.g. `claude`) |
| `auto_rename` | `bool` | When True, PTY OSC title escapes may update `name`; cleared on first manual rename |
| `last_launch_cmd` | `dict \| None` | Serialized `WorkerCLIOptions` from the last `launch()` |

`tab_order` and `last_active_at` are base-`Entity` fields (no per-shell `tabbed` flag — strip
membership is the `Tab` entity, see [docs/tab-management.md](../tab-management.md)).

### Public API

**Construction**

| Method | Kind | Description |
| --- | --- | --- |
| `open(cls, workdir=None, **kwargs)` | classmethod | Create + `start_pty()` immediately; returns a ready shell |
| `__aenter__` / `__aexit__` | async ctx | `start_pty()` on enter, `close()` on exit |
| `save(*args, **kwargs)` | async | Persists; defaults `project_id` to the `@local` Project when none supplied |

**Lifecycle**

| Method | Description |
| --- | --- |
| `start_pty(rows=24, cols=80, on_exit=None, connection_id=None, spawn_args=None, extra_env=None)` | Spawn the OS PTY. Idempotent — no-op (returns `False`) if already alive; returns `True` when a fresh PTY was spawned. Rebinds compute node, cleans a stale session, then `cn.create_pty(...)`; sets `status=running`, `pty_pid=id`. Raises `RuntimeError` on bad status / missing compute node |
| `start(*args, **kwargs)` | Back-compat alias for `start_pty` (prefer `start_pty`) |
| `stop()` | `terminate_worker()` + kill PTY, keep the entity; `status=idle` |
| `restart()` | `stop()` then `start_pty()`; preserves workdir/env/tab_order |
| `terminate_worker()` | SIGTERM worker + descendants, wait ≤3s to reap, SIGKILL survivors. Entity + PTY left alive |

**PTY I/O**

| Method | Description |
| --- | --- |
| `write(text)` | Gate on `_wait_for_shell_ready()`, then write `text + "\r"` in one write (as if typed) |
| `write_raw(data: bytes)` | Send raw bytes verbatim (control sequences: ESC, Ctrl-C, Ctrl-D). No gate, no `\r` |
| `write_then_submit(text, submit_delay=0.4)` | Type text, settle, then send Enter as a **separate** write — required by rich TUI agents (Copilot CLI, Codex) that treat a trailing `\r` in a paste as literal text |
| `read() -> bytes` | Non-destructive replay of accumulated PTY output from the disk stream file; `b""` if none |
| `output()` | Async generator streaming live PTY output; delegates to `self.pty.output()` |
| `wait_for_input_ready(timeout=5.0)` | Public prompt gate. `write`/`write_then_submit` call it internally; a raw `write_raw` (e.g. `AgenticProcess.input`) must call it FIRST or a fresh TUI drops keystrokes |
| `launch(cmd, instruction=None) -> WorkerExecutionInfo` | shell-mode path: inject `cmd.to_shell_string(...)` via `write()`, poll ≤1s for the worker child PID, persist `worker_pid`/`worker_name`/`last_launch_cmd` |
| `set_env(**vars)` | Persist env vars on the entity and inject live (`export`/`set`) if `status=running` |
| `rename(name)` | Mirror new name + pin (`auto_rename=False`) so PTY OSC titles stop overwriting it |

**Liveness / PTY handle**

| Member | Kind | Description |
| --- | --- | --- |
| `is_alive` | property | Sync in-memory check: PTY exists and `pty.is_alive` |
| `pty` | property | The live `Pty` handle, or `None` if not started/closed |
| `has_attachable_pty()` | async | Rebind compute node, then True iff a live PTY backs this shell |
| `worker_alive()` | async | True if `worker_pid` runs and its cmdline matches `worker_name` (+ session id). Raises if the PTY itself is dead |
| `evict_pty_handle()` | async | Kill the in-memory PTY handle if present (no-op otherwise); does not touch worker or `.pty` file |
| `compute_node` | property | Real bound `ComputeNode` (cached), else a synthetic local stub |

> **`compute_node.get_pty(shell_id)` returns a new wrapper per call, not a stable handle.** It delegates to `compute_provider.get_pty_session`, which constructs a fresh `LocalPtySession(cn_id, connection_id, shell_id, …)` each call — the durable PTY state lives in `pty_registry`, and the returned object is a thin per-call view over it. Don't cache the returned handle expecting identity, and don't compare two `get_pty` results with `is`; re-fetch when you need current state.

| `ensure_live_compute_node_binding()` | async | Repair stale binding by uname → id → local; caches the real CN |

**Worker tracking**

| Method | Description |
| --- | --- |
| `set_worker_pid_direct(cmd) -> WorkerExecutionInfo` | Direct-spawn path (`shell_mode=False`): the PTY PID **is** the worker, read it immediately from the provider — no child-process polling |
| `launch(...)` | Legacy `_poll_for_worker_pid`-based tracking (see PTY I/O above) |

**Class utilities**

| Method | Description |
| --- | --- |
| `active(compute_node_typeid=None) -> list[Shell]` | All non-closed shells, sorted by `tab_order` |
| `next_tab_order() -> int` | A `tab_order` after all existing shells; never returns `0` (0 = unassigned) |

### Module helpers & enum

| Symbol | Description |
| --- | --- |
| `ShellStatus` | `StrEnum`: `IDLE`, `RUNNING`, `CLOSING`, `CLOSED`, `ERROR` |
| `get_shell_record(uid) -> FSRecord \| None` | O(1) lookup of the shell FSRecord by id |
| `shell_pty_stream_path(record_id, pty_pid)` | Path to the `.pty` stream file; raises `ValueError` if `pty_pid` is None |
| `close_shell_record(record)` | Set `status=CLOSED`, unlink the `.pty` file. Idempotent |

---

## Backend actions

`@action.post` methods on `Shell` (verified — exactly four):

| Action | Verb | Python method | Guards | Description |
| --- | --- | --- | --- | --- |
| `open` | POST | `_http_open` | catches `RuntimeError` → `ApiFailResponse` | Start PTY (`start_pty`), set `status=running`. Body: `{connection_id?, cols?, rows?, working_dir?}`. Returns entity + `pty_id` |
| `close` | POST | `close` | best-effort (each step wrapped) | Kill worker + PTY, **delete disk record + delete entity**. Permanent teardown |
| `run` | POST | `run` | `command` required else `ApiFailResponse` | Run a command in a one-shot subprocess; returns `{stdout, stderr, exit_code}` |
| `set-env` | POST | `_http_set_env` | `vars` required else `ApiFailResponse` | Persist + live-inject env vars. Body: `{vars: {k: v}}` |

**`close` vs worker-exit semantics.** `close` is destructive: it terminates the worker, deletes
the on-disk `ShellRecord`, kills the PTY, and deletes the `Shell` entity — the tab is gone.
Contrast `AgenticProcess` exit, which **preserves** the Shell (only the worker process ends);
the terminal tab survives and can be resumed. `stop()` sits in between — it kills worker + PTY
but keeps the entity (`status=idle`) for manual resume.

---

## Frontend TS interface

`ts_sdk/src/entities/shell.ts` — `class Shell extends APIEntity<Shell>` (~:73). Mirrors the
Python fields (`IShell`), owns an eagerly-created `PtyConnection`, and delegates all PTY
lifecycle/I/O to it.

### Statics

| Static | Description |
| --- | --- |
| `create(computeNode, opts?)` | Construct an unsaved `Shell` bound to a compute node (id + uname) |
| `newLiveShell(opts?)` | Construct against `dataContext.computeNode`, `save()`, then `start()` — a ready live shell |
| `list(computeNodeId)` | `list-shells` action on `ComputeNode`; merges into cached instances (never orphans subscribers) |
| `getActiveSessions()` | `query({})` filtered to non-`CLOSED`, sorted by `tab_order` |
| `DEFAULT_COLS` / `DEFAULT_ROWS` | `80` / `24` |

### Getters

| Getter | Description |
| --- | --- |
| `dockPointer` | `DockPointerData(ViewType.SHELL, typeId)` |
| `computeNodeTypeId` | `TypeId('compute_node', compute_node_id)` or null |
| `connected` | `ptyConnection.isLive` (WS up + started) |
| `attached` | `ptyConnection.attached` (attach completed, no WS dependency) |
| `ptyStarted` | `ptyConnection.started` |
| `shellStatus` | Human string: error/closing/closed/`Restarting…`/`Not connected`/`Disconnected`/`Live` |

### Methods

| Method | Description |
| --- | --- |
| `start(opts?) -> Promise<string>` | Call the `open` action (with `connection_id`, cols/rows, workdir), then `attachPty`; returns the pty id |
| `attachPty(opts)` | Single PTY lifecycle entry point; deferred until first activation (`isActive`); `force` re-attaches. Delegates to `ptyConnection.attach` |
| `sendInput(data)` | → `ptyConnection.sendInput` |
| `resize(cols, rows)` | → `ptyConnection.resize` |
| `close()` | `close` action; on success (or 404) dispose connection + `status=CLOSED` |
| `run(command) -> ShellResult` | `run` action → `{stdout, stderr, exitCode}` |
| `setEnv(vars)` | `set-env` action |
| `onOutput(fn)` | Live output subscription (gated on `attached`; undefined if not attached yet) |
| `onLine(fn)` | ANSI-stripped line subscription (fires for replay too) |
| `routePtyOutput(data, seq?, ts?)` | Route a `pty_output_msg` from DataManager into the connection |
| `getPtyChunks()` | Sorted output chunks (VirtualTerminal rebuild on resize) |
| `addTrigger(trigger)` | Register a regex trigger over the line stream |
| `getPtyEventFires()` / `onPtyEventFire(fn)` | Read / subscribe to recorded trigger fires |

### PtyConnection

`ts_sdk/src/services/shell/ptyConnection.ts` — `class PtyConnection` (~:63). The single PTY
interface: lifecycle, WS I/O, output routing, line stream, and triggers. Connection membership
is backend-owned (`PtyRegistry` parks/resumes on the WS lifecycle) — there is deliberately no
client-side WS-close handler.

| Getter | Description |
| --- | --- |
| `attached` | attach completed (no WS dependency; safe in unit tests) |
| `isReady` | `attached && isLive` (old `shell.connected`) |
| `isLive` | `started && !restarting && dataContext.isConnected` |
| `status` | `PtyConnectionStatus`: `idle`/`connecting`/`live`/`restarting`/`closed` |

| Method | Description |
| --- | --- |
| `attach(ptyId, opts?)` | Attach/re-attach; idempotent + deduped. No byte replay — server asserts client size and forces a repaint |
| `sendInput(data)` | `terminal-command`/`input` over WS; on `PTY session not found` marks disconnected |
| `resize(cols, rows)` | `terminal-command`/`resize` over WS |
| `onOutput(fn)` / `offOutput(fn)` | Live output listener (fires only after `attached`) |
| `onReady(fn)` | Fires each time attach completes (immediately if already attached) |
| `onDisconnect(fn)` | Fires when the WS drops |
| `onLine(fn)` | ANSI-stripped line stream (replay included) |
| `addTrigger(trigger)` | Regex trigger; retroactively matches buffered history (`duringReplay`) |
| `getSortedChunks()` / `getChunk(seq)` | Chunk buffer access |
| `flush(entries)` | Drain orphan-buffer chunks that arrived pre-attach |
| `clear()` | Clear chunk buffer + seq + event fires (keeps attach state) |
| `dispose()` | Drop all listeners, triggers, chunks |

**Types.** `PtyConnectionStatus = 'idle' | 'connecting' | 'live' | 'restarting' | 'closed'`.
`PtyEventFire` — one recorded trigger fire (`id`, `ts`, `patternSource`, `label?`, `line`,
`match: string[]`, `duringReplay`). `PtyEvent` — `{ pattern, onMatch, label? }`.

---

## shell_mode vs direct spawn

Two ways the worker CLI reaches the PTY, selected by `AgenticProcess`:

- **Direct spawn (default, `shell_mode=False`)** — the worker CLI (e.g. `claude`) is spawned
  **as** the PTY process itself. The PTY PID **is** the worker PID, read immediately via
  `set_worker_pid_direct(cmd)` — no child-process hunting. `start_pty(spawn_args=[...])`
  carries the worker argv.
- **shell-mode (`shell_mode=True`, legacy)** — the PTY runs `$SHELL` as an intermediary; the
  worker command is **typed** into it (`launch(cmd)` → `write(...)`), and the child PID is
  discovered by `_poll_for_worker_pid` walking the shell's process tree.

Full narrative (why direct spawn is the default, the npm-shebang argv[1] matching, session-id
resumption) is in [docs/shell-claude-session-api.md](../shell-claude-session-api.md) — not
duplicated here.

---

## Flows

- PTY attach lifecycle — [./flows.md#pty-attach](./flows.md#pty-attach)
- Shell open / start — [./flows.md#shell-open](./flows.md#shell-open)
- Shell close / teardown — [./flows.md#shell-close](./flows.md#shell-close)
- Worker launch (direct spawn vs shell-mode) — [./flows.md#worker-launch](./flows.md#worker-launch)
