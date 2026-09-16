---
id: a92a9c6b-3ea7-5680-bd00-d0bd1902490f
---

# Agent Management

This is the top-level index for agent management documentation. The focused subject
documents live in `docs/agent-management/`.

## Current Model

Flowpad separates the persistent agent from each execution:

- An `Agent` is a named, launchable identity and authoring bundle. Project
  members create one with **New → Agent**, or create a personal Agent by
  choosing the User scope.
- A `Deployment` of kind `runtime.agent` records where an Agent is placed.
- An `AgenticProcess` records one run. It stores the workdir,
  instruction/context, CLI configuration, `session_id`, lifecycle `status`,
  visibility, and linked `shell_id` when a terminal is open.

Creating an Agent authors the definition only. Cloud deployment and sandbox
identity provisioning are separate deployment phases.

## Agent authoring bundle

A project-scoped Agent is stored under the selected Project, using a
backend-derived lowercase filesystem slug. For example, an Agent whose name is
`Q` has this portable bundle:

```text
agentic-assets/agent/q/
├── agent.md
└── avatar.png
```

`name` is the addressable identity (`Q`) and supplies the filesystem slug
(`q`). `title` is the human role shown in the profile (`QA manager`); it does
not rename the Agent. Both values round-trip through `agent.md` frontmatter.

An uploaded image is kept beside `agent.md`, and frontmatter stores only the
portable bundle-relative reference `avatar: ./avatar.png`. Absolute paths,
parent traversal such as `../avatar.png`, and generated download URLs are not
portable identity data and are rejected by the authoring UI. Emoji and registry
icon values remain supported for Agents that do not use an image.

Creating another Agent whose normalized name resolves to an occupied bundle
returns a conflict and never overwrites the existing Agent or its files.

### Intro and project auto-launch

Three frontmatter keys are **declaration only**: they round-trip through
`agent.md`, show in the profile editor, and never enter `to_agent_options`, so
setting them does not flip `restart_required` on a running process.

| Key | Meaning |
|-----|---------|
| `intro` | Welcome text rendered as the agent's first message in Vibe and Standard chat (`AgentIntroMessage`). Presentation only: not in the transcript, never sent to the model. Hidden in Advanced/Dev, which show the raw session. |
| `auto_launch` | Launch this agent once, the first time the project it lives in is opened. |
| `auto_launch_prompt` | First prompt of that session, delivered through the process prompt queue. Empty opens the session with no first turn. |

Auto-launch is **once per project, ever**. The dock loaders run a load-redirect
resolver (`ui/src/agents/agent-auto-launch-redirect.ts`, registered after the
journey one) that calls `POST /api/v1/agents/auto-launch {project_id}`.
`Agent.auto_launch_for` scopes candidates to agents rooted in the project or
one of its direct context folders, `enabled` with `auto_launch` on, and not yet
in the project's device state (`<instance_dir>/projects/<project_id>/device_state.json`,
key `agent_auto_launched`, via `flow_sdk/project_device_state.py` — backend-owned so no
UI `project.save()` can clobber it; read it back with `GET /api/v1/agents/auto-launch?project_id=`). The **oldest** wins — first
indexed (`created_date`), then alphabetical by folder — and every candidate,
winner and cancelled alike, is recorded before the session opens, so a cancelled
agent never fires on a later open and a failed launch is not retried. The UI
warns which launches were cancelled. The session is opened with `use()`, the
prompt is enqueued server-side, and the UI embeds the vibe persona before it
kicks the queue with `drain-queue`. Never set `auto_launch` on a system agent:
the system project is a context root of every project.

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
