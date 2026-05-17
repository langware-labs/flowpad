---
id: f4afa785-c2e1-5c52-85e3-a4c970c9ea00
---

# Agent Management Specification

This document is the current implementation-oriented reference for the
`AgenticProcess` system. It supersedes older terminology around
`AgenticProcessor`, `startPty/resumePty/killPty`, `worker_session_id`, and a
process-level `pty_pid`.

## 1. Entity Model

`AgenticProcess` (`agentic_process`) is the durable control-plane entity for an
agent run.

Current backend implementation:

- `flow_sdk/builtin/agentic_process/agentic_process.py`
- `flow_sdk/builtin/agentic_process/status_predicates.py`
- `flow_sdk/builtin/agentic_process/cli_drivers/`

Current frontend implementation:

- `ts_sdk/src/process/agentic-process.ts`
- `ts_sdk/src/process/agentic-types.ts`

Important fields:

| Field | Meaning |
|-------|---------|
| `session_id` | Worker conversation/session ID. For Claude this maps to the JSONL transcript filename. |
| `status` | Stored process lifecycle: `new`, `starting`, `running`, `stopping`, `stopped`, `failed`. |
| `worker_status` | Computed worker state derived from transcript/history where available. |
| `ready_for_input` | Server-computed predicate for whether a prompt can be sent now. |
| `visible` | `true` for PTY mode, `false` for CLI/headless mode. |
| `shell_id` | Linked `Shell` entity when PTY mode is open. |
| `cli_config` | Serialized CLI options such as model, permissions, chrome/debug/worktree flags, agents, add-dir, resume/fork metadata. |
| `context_data` | Additional creation/runtime context retained for compatibility and UI flows. |
| `workdir` | Working directory for the worker. |

Compatibility note: some record structures and request bodies still accept
legacy names such as `worker_session_id`, but the current entity/API field is
`session_id`.

## 2. Execution Modes

The same `AgenticProcess` can be used in two modes. The mode is derived from
`visible`; there is no separate stored mode enum.

### PTY Mode

`visible=true`

PTY mode is the interactive terminal path. It is used by terminal tabs,
`InteractiveTerminal`, and toolbar-driven sessions.

Flow:

```text
frontend process.start({ visible: true, instruction? })
  -> POST agentic_process/<id>/open
  -> backend AgenticProcess.start()
  -> create/reuse linked Shell
  -> Shell.start(spawn_args=<worker cli argv>, extra_env=...)
  -> desktop provider spawns OS PTY
  -> PTY output enters replay buffer and websocket stream
  -> frontend Shell.attachPty()
  -> PtyConnection replays chunks and streams live bytes into xterm.js
```

The linked `Shell` owns live PTY state. The active PTY ID is returned from the
open action as `pty_id` and mirrored by the frontend shell. It is not a durable
`AgenticProcess.pty_pid` field.

### CLI Mode

`visible=false`

CLI mode is the headless/programmatic path. It is used when callers want a
structured `FlowData` stream rather than an interactive terminal.

Flow:

```text
frontend process.prompt(text) or executeInstruction(...)
  -> POST agentic_process/<id>/prompt or execute
  -> backend AgenticProcess.prompt()
  -> driver.run_print_turn(...)
  -> worker CLI runs a print/headless turn
  -> FlowData is streamed to the caller
  -> transcript/history is still available through the driver
```

CLI mode does not create or attach a PTY. It still uses `session_id` where the
driver supports resumable history, so a session can be represented in either
mode over time.

## 3. Status Model

The status model has two axes.

`ProcessStatus` is stored on the entity:

```text
new -> starting -> running -> stopping -> stopped
any -> failed
```

`WorkerStatus` is derived from worker history/transcript:

| Status | Meaning |
|--------|---------|
| `initializing` | Worker started but transcript/history is not materialized yet. |
| `idle` | No prompt is active; ready baseline. |
| `waiting` | User prompt is recorded, assistant has not responded yet. |
| `thinking` | Assistant is generating. |
| `tool_call` | Assistant requested tool use. |
| `tool_running` | Tool/progress events are active. |
| `api_error` | Recoverable API error/retry state. |
| `complete` | Turn completed cleanly. |
| `interrupted` | User interrupted the worker. |
| `inactive` | Transcript appears stale with no terminal signal. |
| `api_timeout` | Waiting state exceeded timeout. |
| `error` | Abnormal/driver-specific error state. |
| `unknown` | Transcript tail did not match known patterns. |

`ready_for_input` is the canonical send-prompt gate:

```text
status == running and worker_status in { idle, complete, interrupted }
```

## 4. Session and PTY IDs

| Identifier | Owner | Durability | Meaning |
|------------|-------|------------|---------|
| `AgenticProcess.session_id` | Process/driver | Durable | Worker conversation ID and transcript/history lookup key. |
| `AgenticProcess.shell_id` | Process -> Shell link | Durable while linked | Points to the shell used for PTY mode. |
| `Shell.pty_pid` / `open.pty_id` | Shell/runtime | Live runtime | Active PTY session identifier used for websocket terminal routing. |
| `Shell.worker_pid` | Shell/runtime | Live runtime | OS worker process PID when available. |

Older docs referred to `worker_session_id` and process-level `pty_pid`. Those
are not the current source of truth for the entity API.

## 5. Backend Actions

Current important `AgenticProcess` actions:

| Action | Mode | Purpose |
|--------|------|---------|
| `open` | PTY | Starts or reattaches a visible process and returns shell/PTY details. |
| `exit` | PTY | Terminates the live worker/PTY while preserving process/session metadata. |
| `restart` | PTY | Calls `exit` then `start/open` with current config. |
| `fork` | PTY/CLI setup | Creates a sibling process with fork metadata and returns it for start/open. |
| `prompt` | CLI primarily | Runs a headless prompt stream for invisible processes; rejects visible live PTY prompts. |
| `execute` | CLI or routed prompt | Delegates to prompt routing. |
| `cancel-prompt` | CLI | Cancels an in-flight headless worker if registered. |
| `get-history` | Both | Loads worker history through the active driver. |
| `status` | Both | Returns lifecycle status, `worker_status`, and `ready_for_input`. |
| `close` | PTY/process | Permanently closes the process UI/runtime link and linked shell. |

## 6. Frontend Flow

Important TypeScript entry points:

| Method | Behavior |
|--------|----------|
| `AgenticProcess.spawn(options, workerOptions)` | Creates a process and either starts PTY mode or runs headless depending on `workerOptions.headless`. |
| `AgenticProcess.start({ visible, instruction })` | Calls backend `open`, syncs `session_id`/`shell_id`, and attaches the linked shell PTY. |
| `AgenticProcess.prompt(text)` | CLI/headless streaming prompt path. |
| `AgenticProcess.executeInstruction(...)` | Sends an instruction and optionally waits for stream completion. |
| `AgenticProcess.fork(visible)` | Calls backend `fork`, then starts the new process if requested. |
| `AgenticProcess.restart()` | Stops the linked shell/worker then starts again with current config. |

Terminal route loading uses `process.start({ visible: true })` before rendering
the terminal. The terminal component attaches to the linked `Shell`, replays PTY
chunks, subscribes to live output, and sends user input through the shell's
`PtyConnection`.

## 7. ClaudeSessionManager

`ts_sdk/src/services/claude/claudeSessionManager.ts` is now a small helper, not
the canonical lifecycle API.

Current public API:

```ts
await claudeSessionManager.createAndStartSession(context, { instruction });
```

Lifecycle operations such as restart, fork, prompt, and stop live on
`AgenticProcess`.

## 8. Current Source Reference

| Area | File |
|------|------|
| Backend process entity | `flow_sdk/builtin/agentic_process/agentic_process.py` |
| Backend status predicate | `flow_sdk/builtin/agentic_process/status_predicates.py` |
| Worker drivers | `flow_sdk/builtin/agentic_process/cli_drivers/` |
| Shell entity | `flow_sdk/builtin/shell.py` |
| PTY actions | `flow_sdk/builtin/faas/pty_actions.py` |
| Desktop PTY provider | `flow_sdk/compute/providers/desktop/provider.py` |
| Replay/session managers | `flow_sdk/compute/providers/desktop/pty_replay_buffer.py`, `flow_sdk/compute/providers/desktop/pty_session_manager.py` |
| Worker status parser | `flow_sdk/fs_records/agent_status.py` |
| TS process entity | `ts_sdk/src/process/agentic-process.ts` |
| TS process status types | `ts_sdk/src/process/agentic-types.ts` |
| TS shell entity | `ts_sdk/src/entities/shell.ts` |
| TS PTY connection | `ts_sdk/src/services/shell/ptyConnection.ts` |
| Terminal UI | `ui/src/components/terminal/interactive-terminal/` |
