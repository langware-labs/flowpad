# Agent Management

This document is the top-level index for all agent management documentation. Each sub-topic has its own focused file in `docs/agent-management/`.

---

## Overview

The agent management system allows the frontend and backend to create, run, monitor, and control Claude CLI agents as `AgenticProcess` entities. Each process can be driven in one of two modes:

- **PTY mode** — a real interactive terminal session (xterm.js + WebSocket + OS pseudo-terminal). Claude is launched as a subprocess; the user can interact in real time.
- **AMD mode** — structured instruction execution via `flow-do` AMD blocks, with streaming `FlowData` output.

Key components in the stack:

| Layer | Role |
|-------|------|
| `AgenticProcess` entity | DB-persisted process record; owns session IDs and state |
| `ClaudeSessionManager` | TS singleton; handles start/resume/fork/restart lifecycle |
| PTY / WebSocket transport | OS PTY → base64 → WebSocket → xterm.js |
| Shell sessions (ShellManager) | Per-tab session bookkeeping, sync, and PTY routing |
| Records layer | Filesystem snapshots (JSONL, record.json) linked via `vfs_record` |
| UI (TabbedTerminal, ProcessToolbar) | Tab bar, toolbar controls, restart overlay |

---

## Sub-Topic Documentation

### 1. [AgenticProcess Entity](agent-management/agentic-process.md)

All fields, PTY lifecycle stages, AMD execution blocks, status derivation from the JSONL transcript, and the TypeScript API.

Topics covered:
- Entity fields and `ProcessorState` structure
- `context_data` keys and `AgenticContext` DTO
- PTY lifecycle: create → start → running → kill → resume → exit callback
- AMD `flow-do` block format, run modes, multi-turn execution, injection, debug mode
- Status derivation: `_discover_status_from_transcript()` decision tree, `stop_reason` mapping
- `AgenticProcess` and `AgenticProcessor` TypeScript class reference
- All REST API endpoints

---

### 2. [Agent Records](agent-management/agent-records.md)

The filesystem record layer and how it syncs with DB entities.

Topics covered:
- Base `Record` / `FsRecord` class: meta vs. data storage, folder layout, `RecordStatus`
- `ClaudeSessionFsRecord`: JSONL parsing, status derivation, `discover()` / `discover_one()`
- `AgenticProcess` Record: `ProcessorStatus` enum, `discover_status()` delegation
- `AgentRecord`: dual-file layout, `--agents` JSON serialization, load priority
- `vfs_record` entity sync: `sync_record()`, `_apply_record_metadata()`, orphan handling
- Read/write patterns with code examples

---

### 3. [ClaudeSessionManager](agent-management/claude-session-manager.md)

The TypeScript singleton that wraps all Claude CLI lifecycle operations.

Topics covered:
- Singleton pattern and responsibilities
- All five public methods: `startSession`, `resumeSession`, `restartSession`, `forkSession`, `killSession`
- `ClaudeSessionEvent` enum and event subscription
- `ClaudeCliCommand`: fields, factory methods, generation, `with()` immutable update
- Session IDs: `worker_session_id` vs `pty_pid` semantics
- Fork pattern: 7-step walkthrough, what is and is not copied
- Restart pattern: before/after state, `context_data` save requirement
- Backend shell command construction and `ProcessToolbar` integration

---

### 4. [PTY & WebSocket Transport](agent-management/pty-websocket.md)

The full data path from OS PTY to xterm.js in the browser.

Topics covered:
- Five-layer PTY stack: OS PTY → replay buffer → WebSocket → ShellManager → xterm.js
- WebSocket endpoint, connection lifecycle, and frame multiplexing
- All message formats: `pty_output_msg`, `pty_session_status_msg`, `data_op_msg`, `response_msg`
- Output encoding: raw bytes → base64 → UTF-8 via streaming `TextDecoder`
- Input encoding: `term.onData` → `rest_api_msg` → `PtyProcess.write`
- Replay buffer: 2 MB / 5000-chunk limit, FIFO eviction, last-chunk protection
- Sequence numbers: assignment, deduplication, client-side tracking
- Reconnection and reattach: survival matrix, exponential backoff, 11-step reattach flow
- Error handling: unknown messages, session expiry, PTY death callback

---

### 5. [Tabs Management](agent-management/tabs-management.md)

The multi-tab terminal UI and session lifecycle management.

Topics covered:
- `TabbedTerminal` props, internal state, creating/closing/renaming tabs
- `ViewType` enum: all 30+ values and what each view renders
- `ShellManager` singleton: session ownership model, all events, all methods
- `ShellSession` data object: properties, PTY state, sequence-number deduplication
- `useShellSessions`, `useShell`, and `useShellSession` hooks
- `SessionViewer`: tab bar, `favorite_index` ordering, tab lifecycle, URL sync
- `NavigationActions`: `openShell`, `openSession`, `openAgenticProcess`, and core navigation

---

### 6. [Terminal Toolbars](agent-management/terminal-toolbars.md)

The `ProcessToolbar` controls and `RestartRequiredOverlay`.

Topics covered:
- Component hierarchy: where the toolbar is mounted in `InteractiveTerminal`
- `ProcessToolbar` props and `IconToggleButton` sub-component
- Chrome toggle: `--chrome` flag, `pendingChrome` staging
- Full Trust toggle: `--dangerously-skip-permissions`, `pendingDanger` staging
- Show Events toggle: `showGutter` / `SnifferGutter` visibility
- Open Terminal button: `navigation.openShell()` with `context_data.workdir`
- Fork button: `handleFork` flow, `claudeSessionManager.forkSession()`
- Restart button: `handleRestart` flow, `claudeSessionManager.restartSession()`
- Session Info popover: all 8 displayed fields and command reconstruction
- `RestartRequiredOverlay`: trigger condition, apply flow, cancel flow
- State management: all local state variables and the `useEffect` reset

---

## Source Specs

The following existing documentation was used as source material for the above files:

| Document | Contents |
|----------|----------|
| [`docs/agent-management-spec.md`](agent-management-spec.md) | Comprehensive spec: entity hierarchy, all lifecycle sections, ClaudeSessionManager reference |
| [`docs/agentic-process.md`](agentic-process.md) | Deep dive: three-layer architecture, PTY mechanics, reconnection flow |
| [`docs/claude-session-manager.md`](claude-session-manager.md) | `ClaudeSessionManager` full API reference (original) |
| [`docs/pty-terminal-spec.md`](pty-terminal-spec.md) | WebSocket protocol, replay buffer, encoding details |
| [`docs/fs_store.md`](fs_store.md) | Record base class, storage layouts, CRUD patterns |
| [`docs/record-entity-sync.md`](record-entity-sync.md) | `vfs_record` sync algorithm and orphan handling |
