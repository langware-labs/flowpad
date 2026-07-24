---
id: a92a9c6b-3ea7-5680-bd00-d0bd1902490f
---

# Agent Management

This is the top-level index for agent management documentation. The focused subject
documents live in `docs/agent-management/`.

## Current Model

Flowpad represents an agent run as an `AgenticProcess` entity. The entity is the
durable control plane: it stores the workdir, instruction/context, CLI
configuration, `session_id`, lifecycle `status`, visibility, and the linked
`shell_id` when a terminal is open.

The same entity supports two execution modes:

| Mode | Entity flag | Runtime | Output path | Primary frontend surface |
|------|-------------|---------|-------------|--------------------------|
| **PTY mode** | `visible=true` | A linked `Shell` owns an OS PTY running the worker CLI | PTY bytes -> replay buffer -> WebSocket -> xterm.js | Terminal tab / `InteractiveTerminal` |
| **CLI mode** | `visible=false` | Driver runs a headless print turn, usually one subprocess per prompt | Structured `FlowData` stream plus transcript/history | Programmatic SDK flows and non-terminal UI |

Both modes use the same `session_id` concept. For Claude, that ID points at the
JSONL transcript under `~/.claude/projects/<encoded-project>/<session_id>.jsonl`.
The live PTY identifier is not a process field; it belongs to the linked `Shell`
and is returned from `AgenticProcess.open` as `pty_id`.

## Main Components

| Layer | Role |
|-------|------|
| Backend `AgenticProcess` | Persistent process entity and action surface: `open`, `exit`, `restart`, `fork`, `prompt`, `execute`, `status`, `get-history` |
| Worker drivers | Vendor-specific CLI/transcript behavior under `flow_sdk/builtin/agentic_process/cli_drivers/` |
| `Shell` entity | Owns live PTY metadata, worker PID, terminal input/output, and close/terminate behavior |
| PTY transport | OS PTY, replay buffer, websocket attach/replay/input/resize/close actions |
| Filesystem records | Durable Claude session transcripts, process records, status derivation, and search/index sync |
| Frontend `AgenticProcess` | TypeScript SDK wrapper for starting, forking, restarting, prompting, status updates, and shell attachment |
| Frontend `Shell` / `PtyConnection` | Browser-side PTY attachment, replay sequencing, deduplication, input, and resize |
| UI terminal components | `InteractiveTerminal`, `ProcessToolbar`, route loaders, terminal tab discovery |

## Focused Documentation

### 1. [AgenticProcess Entity](agent-management/agentic-process.md)

Backend and frontend `AgenticProcess` behavior.

Coverage:
- Current entity fields and lifecycle
- `session_id`, `shell_id`, `visible`, `status`, `worker_status`, and `ready_for_input`
- PTY mode startup, restart, fork, close, and shell ownership
- CLI mode prompt/execute streaming
- Driver layer and vendor-specific transcript/history handling
- REST/action entry points

### 2. [Agent Records](agent-management/agent-records.md)

Filesystem records and transcript/status sync.

Coverage:
- `ClaudeSessionRecord` and transcript discovery
- `AgenticProcessRecord` and legacy compatibility fields
- `WorkerStatus` derivation from transcript tails
- Difference between durable records and live `Shell`/PTY runtime state
- How CLI and PTY modes share session history

### 3. [Claude Process Lifecycle & Restart Contract](agent-management/claude-session-manager.md)

The `AgenticProcess` lifecycle reference (the `ClaudeSessionManager` service it
was named for no longer exists).

Coverage:
- Process creation flows (`ComputeNode.createProcess`, `AgenticProcess.spawn`)
- Interactive PTY vs headless CLI lifecycles; stop/restart/fork/close
- The persisted CLI-options model (`cli_config`) and how to change options
- Restart-required detection and the end-to-end restart flow

### 4. [PTY & WebSocket Transport](agent-management/pty-websocket.md)

Terminal runtime and browser transport.

Coverage:
- `Shell`-owned PTY state and worker process liveness
- Compute-node terminal actions: attach, input, resize, close, list, ping
- Replay buffer sequence numbers and reconnect behavior
- WebSocket message routing and browser-side deduplication
- Boundaries between PTY mode and CLI mode

### 5. [Tabs Management](agent-management/tabs-management.md)

Terminal tabs, routing, and visible process discovery.

Coverage:
- Loading an `AgenticProcess` route and opening it in PTY mode
- How visible processes and shells become terminal tabs
- Dock pointers, active shell state, and route-level startup
- How headless CLI processes differ from terminal tabs

### 6. [Terminal Toolbars](agent-management/terminal-toolbars.md)

Controls mounted above interactive agent terminals.

Coverage:
- Current `ProcessToolbar` controls and flag staging
- Restart and fork flows through `AgenticProcess`
- Session info popover behavior
- PTY-only terminal controls versus CLI/headless processes

## Current Source Files

| Area | Main files |
|------|------------|
| Backend process entity | `flow_sdk/builtin/agentic_process/agentic_process.py` |
| Driver layer | `flow_sdk/builtin/agentic_process/cli_drivers/` |
| Shell entity | `flow_sdk/builtin/shell.py` |
| PTY actions | `flow_sdk/builtin/faas/pty_actions.py` |
| Desktop PTY provider | `flow_sdk/compute/providers/desktop/provider.py` |
| Worker status | `flow_sdk/fs_records/agent_status.py` |
| TS process entity | `ts_sdk/src/process/agentic-process.ts` |
| TS status types | `ts_sdk/src/process/agentic-types.ts` |
| TS shell/PTY client | `ts_sdk/src/entities/shell.ts`, `ts_sdk/src/services/shell/ptyConnection.ts` |
| Terminal UI | `ui/src/components/terminal/interactive-terminal/` |
