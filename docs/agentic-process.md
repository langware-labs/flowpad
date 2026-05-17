---
id: e5da519d-77ef-57fb-8adf-faf38d99b810
---

# AgenticProcess Architecture

`AgenticProcess` is the durable entity that represents an agent run. It is not
the PTY itself and it is not a frontend-only session. It coordinates process
metadata, worker CLI configuration, session history, and the optional terminal
runtime.

Current implementation:

- Backend: `flow_sdk/builtin/agentic_process/agentic_process.py`
- Backend drivers: `flow_sdk/builtin/agentic_process/cli_drivers/`
- Frontend entity: `ts_sdk/src/process/agentic-process.ts`
- Frontend status types: `ts_sdk/src/process/agentic-types.ts`

## Two Modes

The process supports two modes, derived from `visible`.

| Mode | `visible` | Runtime | User surface |
|------|-----------|---------|--------------|
| **PTY mode** | `true` | Linked `Shell` starts a real OS PTY and runs the worker CLI interactively. | Terminal tab with xterm.js. |
| **CLI mode** | `false` | Driver runs a headless print/prompt turn and streams structured output. | SDK/programmatic flows and non-terminal UI. |

Both modes share the same `session_id` where the worker supports history. For
Claude, that session ID maps to the JSONL transcript in
`~/.claude/projects/<encoded-project>/<session_id>.jsonl`.

## Backend Entity

The backend entity stores the durable state:

| Field | Purpose |
|-------|---------|
| `session_id` | Worker conversation ID. Replaces older `worker_session_id` terminology in the current entity API. |
| `status` | Stored lifecycle: `new`, `starting`, `running`, `stopping`, `stopped`, `failed`. |
| `worker_status` | Computed field exposed on serialization from worker transcript/history. |
| `ready_for_input` | Computed send-prompt predicate. |
| `visible` | Selects PTY mode (`true`) or CLI mode (`false`). |
| `shell_id` | Linked `Shell` entity when a terminal runtime exists. |
| `cli_config` | Serialized CLI options, including model, permissions, chrome/debug/worktree, resume/fork metadata, add-dir, and agents. |
| `workdir` | Worker working directory. |

The entity resolves a vendor driver through
`flow_sdk/builtin/agentic_process/cli_drivers/get_driver`. Vendor details such
as CLI args, transcript lookup, history loading, and status tail parsing belong
to the driver layer rather than being hard-coded throughout the entity.

## PTY Mode Runtime

PTY mode is opened through `AgenticProcess.start()` on the backend and
`AgenticProcess.start({ visible: true })` on the frontend.

Flow:

```text
frontend start({ visible: true, instruction? })
  -> POST /agentic_process/<id>/open
  -> backend AgenticProcess.start()
  -> create/reuse Shell
  -> build worker CLI args through driver
  -> Shell.start(spawn_args, extra_env)
  -> desktop compute provider spawns OS PTY
  -> PTY bytes go to replay buffer and websocket
  -> frontend Shell.attachPty()
  -> PtyConnection replays and streams into xterm.js
```

The `Shell` owns the live terminal state:

- active PTY id (`shell.pty_pid`, returned from `open` as `pty_id`)
- worker PID where available
- attach/input/resize/close routing
- terminal replay chunks

The current `AgenticProcess` does not own a process-level `pty_pid`. Older docs
that describe `AgenticProcess.pty_pid` are describing a stale model.

## CLI Mode Runtime

CLI mode is the headless path. It is used when `visible=false`, especially from
`prompt()` or programmatic `executeInstruction()` calls that expect structured
`FlowData` instead of terminal bytes.

Flow:

```text
frontend prompt/executeInstruction
  -> backend AgenticProcess.prompt()
  -> if visible=false: driver.run_print_turn(...)
  -> stream FlowData through the HTTP response/websocket processing path
  -> update transcript/history through the worker driver
```

If a process is visible and already has a live PTY worker, normal user input
should be sent through the terminal. The backend `prompt` action rejects the
streaming CLI prompt path for visible live PTY processes.

## Status Model

Status has two axes.

`ProcessStatus` is stored on the entity:

```text
new -> starting -> running -> stopping -> stopped
any -> failed
```

`WorkerStatus` is derived from worker history/transcript and exposed as
`worker_status`:

- `initializing`
- `idle`
- `waiting`
- `thinking`
- `tool_call`
- `tool_running`
- `api_error`
- `complete`
- `interrupted`
- `inactive`
- `api_timeout`
- `error`
- `unknown`

`ready_for_input` is true only when:

```text
status == running
and worker_status in { idle, complete, interrupted }
```

The transcript parser lives in `flow_sdk/fs_records/agent_status.py`. The
TypeScript mirror lives in `ts_sdk/src/process/agentic-types.ts`.

## Reconnect and Replay

PTY reconnection is handled by the shell/PTY stack, not by recreating the
`AgenticProcess`.

Relevant files:

- `flow_sdk/builtin/faas/pty_actions.py`
- `flow_sdk/compute/providers/desktop/provider.py`
- `flow_sdk/compute/providers/desktop/pty_session_manager.py`
- `flow_sdk/compute/providers/desktop/pty_replay_buffer.py`
- `ts_sdk/src/entities/shell.ts`
- `ts_sdk/src/services/shell/ptyConnection.ts`

Replay flow:

1. Backend assigns a monotonic sequence number to each PTY output chunk.
2. Browser tracks the highest sequence it has applied.
3. On attach/reconnect, browser sends `since_seq`.
4. Backend snapshots replay chunks before attaching the websocket connection.
5. Browser applies replay chunks, marks replay complete, then accepts live chunks.

This prevents terminal output loss during page refreshes, tab switches, and
websocket reconnects while the PTY is still alive.

## Main Actions

| Action | Purpose |
|--------|---------|
| `open` | Start or reattach PTY mode. |
| `exit` | Terminate live PTY worker while preserving process/session metadata. |
| `restart` | Exit then start again with current CLI config. |
| `fork` | Create a sibling process with fork metadata. |
| `prompt` | Run a headless CLI prompt stream for invisible processes. |
| `execute` | Execute instruction content through the prompt routing path. |
| `get-history` | Load worker history through the current driver. |
| `status` | Return lifecycle status, worker status, and readiness. |
| `close` | Close the process UI/runtime link and linked shell. |

## Frontend Flow

`ts_sdk/src/process/agentic-process.ts` is the canonical frontend entity.

Important methods:

- `start({ visible, instruction })`: calls backend `open`, syncs shell/process
  fields, and attaches PTY when visible.
- `prompt(text)`: headless CLI streaming path.
- `executeInstruction(...)`: sends instruction content and optionally waits.
- `fork(visible)`: creates a sibling process and starts it if requested.
- `restart()`: stops the current linked shell/worker and starts again.

The terminal UI is mounted from:

- `ui/src/routes/loaders/load-process.ts`
- `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx`
- `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx`

The route loader opens the process in PTY mode before rendering the terminal.
The terminal then attaches to the linked shell, replays existing chunks, and
sends keyboard input through the shell's `PtyConnection`.
