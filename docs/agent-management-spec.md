# Agent Management Specification

Complete reference for the `AgenticProcess` system: execution models, lifecycle, session management, status tracking, and frontend integration.

---

## Table of Contents

1. [Entity Hierarchy](#1-entity-hierarchy)
2. [Execution Models](#2-execution-models)
3. [AgenticContext — Configuration DTO](#3-agenticcontext--configuration-dto)
4. [Process Status](#4-process-status)
5. [Session IDs](#5-session-ids)
6. [PTY Lifecycle (Claude CLI Model)](#6-pty-lifecycle-claude-cli-model)
7. [AMD/FlowData Lifecycle (Streaming Model)](#7-amdflowdata-lifecycle-streaming-model)
8. [ClaudeSessionManager](#8-claudesessionmanager)
9. [Frontend UI Components](#9-frontend-ui-components)
10. [Backend Python Entities](#10-backend-python-entities)
11. [API Endpoints](#11-api-endpoints)
12. [Key Files Reference](#12-key-files-reference)

---

## 1. Entity

**AgenticProcess** (`agentic_process`):
- Represents one Claude Code execution session.
- Created via `ComputeNode.createProcess(context)` — `compute_node_id` is the ownership link.
- Has two representations:
  - **Entity** (`flow_sdk/builtin/agentic_process/agentic_process.py`) — SQLite-backed, survives server restart.
  - **Record** (`flow_sdk/fs_records/agentic_process.py`) — filesystem snapshot, lightweight.
- Carries `worker_session_id` → the bridge to the JSONL transcript on disk.

---

## 2. Execution Models

The system supports two fundamentally different execution models on the same `AgenticProcess` entity:

### Model A: PTY / Claude CLI (Interactive)

Used by `ProcessToolbar`, `InteractiveTerminal`, and all user-facing terminal tabs.

```
processor.createProcess(context)
  → AgenticProcess entity (idle, no session yet)
  → process.startPty({ instruction })
  → Backend spawns PTY running: claude --session-id <sid> -p "..."
  → xterm.js renders live output via WebSocket
  → Session transcript saved at ~/.claude/projects/.../<worker_session_id>.jsonl
```

Status is derived on every API read by scanning the JSONL transcript. The DB `state.status` is only a fallback.

### Model B: AMD / FlowData (Streaming SDK)

Used by scripts, automation, and the legacy processor run loop.

```
processor.run(instructionFile, context)
  → Backend executes AMD instructions via Python interpreter
  → FlowData events pushed to frontend via WebSocket entity notifications
  → process.output() AsyncGenerator yields FlowData
  → Status from entity state.status field (no transcript)
```

The two models are **mutually exclusive per process instance**. A PTY process should not also be run via `processor.run()`.

---

## 3. AgenticContext — Configuration DTO

**TypeScript interface** (`ts_sdk/src/agentic_processor/agentic-context.ts`):

```ts
interface AgenticContext {
  workdir?: string;             // Working directory
  model?: string;               // Claude model (e.g. "claude-sonnet-4-20250514")
  permissionMode?: PermissionMode; // 'bypassPermissions' | 'askUser'
  chrome?: boolean;             // Pass --chrome flag
  agentsJson?: Record<string, Record<string, unknown>>; // --agents spec
  envVars?: Record<string, string>; // Extra env vars for PTY
  instructions?: string;        // Prepended instruction text
  maxThinkingTokens?: number;
  projectId?: string;
  resumeSessionId?: string;     // Worker session ID to resume
  forkSession?: boolean;        // Fork instead of resume in-place
}
```

**Serialization** — `serializeAgenticContext()` converts camelCase → snake_case for the Python backend:

| TS field | Python key |
|----------|-----------|
| `permissionMode` | `permission_mode` |
| `agentsJson` | `agents_json` |
| `envVars` | `env_vars` |
| `maxThinkingTokens` | `max_thinking_tokens` |
| `resumeSessionId` | `resume_session_id` |
| `forkSession` | `fork_session` |

**Persisted as `context_data`**: When a process is created via `createProcess()`, the context is stored as `context_data` on the entity so it can be re-read on resume.

---

## 4. Process Status

### Status Enum

```ts
enum WorkerStatus {
  IDLE       = 'idle',        // Created, no session started
  RUNNING    = 'running',     // Claude actively processing
  PAUSED     = 'paused',      // Debug breakpoint hit
  STEPPING   = 'stepping',    // Debug step mode
  COMPLETE   = 'complete',    // Turn finished (end_turn / stop_sequence)
  ERROR      = 'error',       // Non-zero exit / execution error
  TERMINATED = 'terminated',  // Explicitly killed via exit()
}
```

### PTY Model: Status Derivation

Status is **not stored** in the DB for PTY processes. On every API read, `_discover_status_from_transcript()` scans the JSONL:

```
worker_session_id set?     No  → None (use DB fallback: "idle")
Transcript file exists?    No  → None (use DB fallback)
Any assistant entries?     No  → "idle"
Last assistant stop_reason:
  "end_turn"               → "complete"
  "stop_sequence"          → "complete"
  "tool_use"               → "running"
  None                     → "running"  (streaming or interrupted)
```

The DB `state.status` is only written on error (`_set_process_state(error=...)`) and acts as a fallback when no transcript exists.

### Status by Scenario (PTY)

| Scenario | `pty_pid` | Last stop_reason | Status |
|----------|-----------------|-----------------|--------|
| Just created | null | — | **idle** |
| PTY started, no response yet | set | — | **idle** |
| Claude actively streaming | set | None | **running** |
| Claude calling a tool | set | "tool_use" | **running** |
| Claude finished turn | set | "end_turn" | **complete** |
| `-p` flag completed | set | "stop_sequence" | **complete** |
| PTY killed mid-stream | null | None | **running** (known limitation) |
| PTY killed after end_turn | null | "end_turn" | **complete** |

**Known limitation**: Interrupted and actively running sessions are indistinguishable from the transcript alone. Check `pty_pid != null` to confirm the PTY is still alive.

---

## 5. Session IDs

Two independent IDs track different aspects of a session:

| Field | Type | Scope | Survives | Changes when |
|-------|------|-------|----------|-------------|
| `worker_session_id` | UUID | Claude Code session | PTY death, server restart | Never (except `startPty` for new sessions) |
| `pty_pid` | UUID | OS-level PTY process | Tab switch, page refresh | Every `resumePty()` call, cleared on kill |

### `worker_session_id`

- Set by `start_pty()` on the backend (generated once).
- Passed to Claude CLI as `--session-id <sid>` on first start.
- Passed as `--resume <sid>` on `resume_pty()`.
- Claude Code uses it as the JSONL filename: `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
- Preserved across PTY restarts — this is what makes resumability work.

### `pty_pid`

- Generated on each `start_pty()` or `resume_pty()` call.
- Used to route WebSocket messages to the correct PTY.
- Cleared (`null`) when `kill_pty()` is called or PTY process dies.
- The UI checks `pty_pid` to know if a live PTY is attached.

---

## 6. PTY Lifecycle (Claude CLI Model)

### 6.1 Create Process

```ts
// TypeScript
const processor = await AgenticProcessor.getById<AgenticProcessor>(processorId);
const process = await processor.createProcess({
  workdir: '/path/to/project',
  permissionMode: 'bypassPermissions',
  chrome: false,
  model: 'claude-sonnet-4-20250514',
});
// process.worker_session_id == null
// process.pty_pid == null
// process.state.status == 'idle'
```

Python action: `POST /api/v1/graph/agentic_processor/<id>/createProcess`

### 6.2 Start PTY

```ts
// TypeScript
const { ptyPid, workerSessionId } = await process.startPty({
  instruction: 'List all Python files in the project',
});
// process.worker_session_id == workerSessionId  (new UUID)
// process.pty_pid == ptyPid        (new UUID)
```

Backend builds the full shell command:

```bash
cd <workdir> && \
  CLAUDE_PROJECT_DIR=<workdir> \
  AGENT_HOOKS_REPORT_URL=<webhook_url> \
  FLOWPAD_EXECUTION_SCOPE='[{"type":"agentic_process","id":"<id>"}]' \
  claude \
    [--dangerously-skip-permissions] \
    [--chrome] \
    --session-id <worker_session_id> \
    [--model <model>] \
    [--agents '<json>'] \
    -p "$(cat <<'EOF'
<instruction>
EOF
)"
```

Python action: `POST /api/v1/graph/agentic_process/<id>/start-pty`

### 6.3 Kill PTY

```ts
await process.killPty();
// process.pty_pid == null
// process.worker_session_id unchanged
```

Backend sequence:
1. Clear `pty_pid` in DB **before** sending signal (prevents race with `_on_pty_exit`).
2. Send SIGINT to PTY process.
3. Close PTY session.

Python action: `POST /api/v1/graph/agentic_process/<id>/kill-pty`

### 6.4 Resume PTY

```ts
const { ptyPid } = await process.resumePty();
// process.pty_pid == ptyPid  (new UUID)
// process.worker_session_id unchanged
```

Backend builds: `claude --resume <worker_session_id>`

Claude Code resumes the conversation by reading the existing JSONL transcript and continuing from the last turn.

Python action: `POST /api/v1/graph/agentic_process/<id>/resume-pty`

### 6.5 PTY Exit Callback

When the PTY process dies (any cause):

```
_on_pty_exit(exit_code) fires from daemon thread
  → asyncio.run_coroutine_threadsafe() schedules cleanup
  → Check: pty_pid already cleared? (kill_pty handled it → skip)
  → If exit_code != 0: _set_process_state(error="Exit code N")
  → Clear pty_pid
  → Save entity
  → Status on next read: transcript-derived
```

### 6.6 Survival Matrix

| Event | PTY | Replay buffer | DB entity | Recovery |
|-------|-----|--------------|-----------|---------|
| Tab switch | Alive | In memory | Persisted | Instant reattach |
| Page refresh | Alive | In replay buffer | Persisted | Reattach + replay |
| Detach > 15 min | Killed by TTL | Lost | Persisted | `resumePty()` |
| Server restart | Killed | Lost | Persisted | `resumePty()` |
| Entity deleted | Killed | Lost | Deleted | Not recoverable |

---

## 7. AMD/FlowData Lifecycle (Streaming Model)

### 7.1 Run Instruction File

```ts
const instructionFile = InstructionFile.fromContent(amdContent);
const process = await processor.run(instructionFile, {
  workdir: '/path/to/project',
  permissionMode: 'bypassPermissions',
});

for await (const flowData of process.output()) {
  console.log(flowData.data);
}
```

Backend action: `POST /api/v1/graph/agentic_processor/<id>/run`

### 7.2 Execute Plain Text

```ts
// Simple one-liner — wraps in AMD automatically
const process = await AgenticProcess.execute('List all Python files');
```

Or via processor:

```ts
const process = await processor.execute('List all Python files', {
  workdir: '/path/to/project',
});
```

### 7.3 Create Idle Process + Multi-Turn

```ts
// Create a process that persists between instructions
const process = await processor.createProcess({ workdir: '/path' });

await process.executeInstruction('Remember the number 42');
await process.executeInstruction("What's the number?");

await process.exit(); // Cleanup
```

### 7.4 Inject Mid-Execution

```ts
// While a process is running, inject additional instructions
const result = await process.inject('Also count the files');
console.log('Queue size:', result.injectedQueueSize);
```

### 7.5 Debug Mode

```ts
// Enable breakpoints
const process = await processor.run(instructionFile, context, {
  debug: true,
  breakpoints: ['instr_001', 'instr_003'],
});

// Step through
await processor.step('over');   // Step over current instruction
await processor.step('into');   // Step into sub-call
await processor.step('out');    // Step out of current frame
```

### 7.6 User Input (Blocking UI)

```ts
processor.on('waiting', (inputId) => {
  const answer = getUserInput();
  processor.sendInput({ answer }, inputId);
});
```

---

## 8. ClaudeSessionManager

Singleton TypeScript service that coordinates all PTY session operations.
Full reference: `docs/claude-session-manager.md`.

```ts
import { claudeSessionManager } from '@sdk';
```

### Methods

| Method | Description |
|--------|-------------|
| `startSession(process, opts?)` | New session — calls `process.startPty()` |
| `resumeSession(process)` | Resume — calls `process.resumePty()` |
| `restartSession(process)` | Kill then resume (canonical restart after flag change) |
| `forkSession(process)` | Create sibling process with same `context_data`, fresh session |
| `killSession(process)` | Kill PTY, preserve `worker_session_id` for future resume |

### Events

```ts
claudeSessionManager.on(ClaudeSessionEvent.SESSION_RESTARTED, ({ process, result }) => { ... });
```

| Event | Payload |
|-------|---------|
| `SESSION_STARTED` | `{ process, result }` |
| `SESSION_RESUMED` | `{ process, result }` |
| `SESSION_RESTARTED` | `{ process, result }` |
| `SESSION_FORKED` | `{ sourceProcess, newProcess }` |
| `SESSION_KILLED` | `{ process }` |
| `SESSION_ERROR` | `{ process, error }` |

### Fork Pattern

`forkSession()` creates a sibling process with the same settings but a completely new session history:

1. Reads `context_data` from the source process → builds `AgenticContext`
2. Calls `AgenticProcessor.getById(process.processor_id)` to get the parent
3. `processor.createProcess(context)` → new entity (new DB row)
4. `newProcess.startPty()` → fresh `worker_session_id` and PTY
5. Emits `SESSION_FORKED`

JSONL history is **not** copied. The fork starts with an empty transcript.

### Restart Pattern

`restartSession()` is the canonical flow when flags change:

```ts
// Save updated context_data first
process.context_data = { ...process.context_data, chrome: true };
await process.save();

// Kill old PTY and resume (picks up new context_data)
await claudeSessionManager.restartSession(process);
```

Internally: `killPty()` → `resumePty()` → emit `SESSION_RESTARTED`.

---

## 9. Frontend UI Components

### Component Hierarchy (PTY View)

```
TabbedTerminal.tsx
  └── ProcessTerminal.tsx          (ViewType.AGENTIC_PROCESS)
        ├── ProcessToolbar.tsx     (Chrome/Trust toggles, Fork, Restart, Session Info)
        ├── InteractiveTerminal.tsx (xterm.js + WebSocket)
        └── RestartRequiredOverlay.tsx (shown when flags change)
```

### ProcessToolbar

**File**: `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx`

Controls:

| Control | Source | Action when changed |
|---------|--------|-------------------|
| Chrome toggle | `context_data.chrome` | Set pending, show overlay |
| Full Trust toggle | `context_data.permission_mode === 'bypassPermissions'` | Set pending, show overlay |
| Show Events toggle | Local state | `onToggleShowEvents` callback |
| Open Terminal | `context_data.workdir` | `navigation.openShell({ cwd })` |
| Fork | `worker_session_id` | `claudeSessionManager.forkSession()` |
| Restart | `worker_session_id` | `claudeSessionManager.restartSession()` |
| Session Info popover | All fields | Display only |

**Toggle availability**: Toggles are enabled whenever `process.worker_session_id` is set. For a running PTY, `status: 'running'` is expected (Claude idle at prompt). It does not mean Claude is busy.

### RestartRequiredOverlay

Shown when `pendingChrome !== currentChrome || pendingDanger !== currentDanger`.

- **Restart** → saves `context_data`, calls `claudeSessionManager.restartSession()`
- **Cancel** → resets pending state to current

### Session Info Popover

Shown when `worker_session_id` is set. Displays:

| Field | Source |
|-------|--------|
| Status | `process.state.status` |
| Working Dir | `context_data.workdir` |
| Session ID | `worker_session_id` |
| PTY ID | `pty_pid` (or "none (detached)") |
| Permission | `context_data.permission_mode` |
| Chrome | `context_data.chrome` |
| Model | `context_data.model` |
| Command | Reconstructed CLI string |

---

## 10. Backend Python Entities

### AgenticProcess Entity

**File**: `flow_sdk/builtin/agentic_processor.py`

#### Entity Fields

| Field | Type | Description |
|-------|------|-------------|
| `processor_id` | `str` | Parent AgenticProcessor ID |
| `worker_session_id` | `str \| None` | Claude session ID — JSONL filename, persistent across PTY restarts |
| `pty_pid` | `str \| None` | Active PTY session UUID — `None` when detached |
| `compute_node_id` | `str` | ComputeNode that hosts the PTY |
| `state` | `dict` | ProcessorState: status, error, debug, stack, variables |
| `context_data` | `dict` | `workdir`, `permission_mode`, `model`, `chrome`, `env_vars`, `agents_json` |
| `instruction_content` | `str` | Prompt text sent to Claude |
| `favorite_index` | `int \| None` | Tab ordering pin |

#### context_data Keys

| Key | Type | CLI mapping |
|-----|------|------------|
| `workdir` | `str` | `cd <workdir> &&` |
| `permission_mode` | `"bypassPermissions" \| "askUser"` | `--dangerously-skip-permissions` |
| `model` | `str` | `--model <model>` |
| `chrome` | `bool` | `--chrome` |
| `env_vars` | `dict` | Injected inline in shell command |
| `agents_json` | `dict` | `--agents '<json>'` |

#### Python Actions

| Action name | Method | Description |
|-------------|--------|-------------|
| `start-pty` | `start_pty(instruction?, worker_session_id?)` | Spawn PTY with new session |
| `resume-pty` | `resume_pty()` | New PTY on same session (`--resume`) |
| `kill-pty` | `kill_pty()` | SIGINT + close PTY, preserve session ID |
| `exit` | `exit_process()` | Terminate (AMD model) |
| `inject` | `inject_control(message)` | Inject instruction into queue |

### AgenticProcessor Entity

**File**: `flow_sdk/builtin/agentic_processor.py`

#### Python Actions

| Action name | Method | Description |
|-------------|--------|-------------|
| `createProcess` | `create_process(context, result?)` | Create idle AgenticProcess |
| `run` | `run(instruction_content, context)` | Create + run (AMD model) |
| `execute` | `execute(instruction_content, context)` | Execute via `initialize_from_prompt` |
| `runFile` | `run_file(vfs_path)` | Run from VFS path |
| `controlStart` | `control_start(mdo_content)` | Start with raw AMD content |
| `controlInput` | `control_input(input_data, input_id)` | Respond to blocking UI |
| `controlStep` | `control_step(step_mode)` | Debug step |

---

## 11. API Endpoints

All routes go through `/api/v1/graph/{type}/{id}/{action}`.

### AgenticProcessor

```
POST /api/v1/graph/agentic_processor/<id>/createProcess
POST /api/v1/graph/agentic_processor/<id>/run
POST /api/v1/graph/agentic_processor/<id>/execute
POST /api/v1/graph/agentic_processor/<id>/runFile
POST /api/v1/graph/agentic_processor/<id>/controlStart
POST /api/v1/graph/agentic_processor/<id>/controlInput
POST /api/v1/graph/agentic_processor/<id>/controlStep
```

### AgenticProcess

```
GET  /api/v1/graph/agentic_process/<id>          → read entity (status derived from transcript)
PUT  /api/v1/graph/agentic_process/<id>          → update fields (save context_data)
DELETE /api/v1/graph/agentic_process/<id>        → delete entity

POST /api/v1/graph/agentic_process/<id>/start-pty
POST /api/v1/graph/agentic_process/<id>/resume-pty
POST /api/v1/graph/agentic_process/<id>/kill-pty
POST /api/v1/graph/agentic_process/<id>/exit
POST /api/v1/graph/agentic_process/<id>/inject
POST /api/v1/graph/agentic_process/<id>/get-history
```

### Response Format

All responses use `ApiResponse`:

```json
{ "status": "OK", "data": { ... } }
{ "status": "FAIL", "message": "..." }
```

The `state.status` field in `data` always reflects the transcript-derived status (for PTY processes), not the DB value.

---

## 12. Key Files Reference

### Backend Python

| File | Role |
|------|------|
| `flow_sdk/builtin/agentic_processor.py` | `AgenticProcessor` + `AgenticProcess` entities (~1828 lines) |
| `flow_sdk/fs_records/agentic_process.py` | `AgenticProcess` Record (51 lines) |
| `flow_sdk/fs_records/claude/claude_session.py` | `ClaudeSessionFsRecord` — JSONL reader, status derivation |
| `flow_sdk/fs_records/claude/claude_active_session.py` | Active session discovery (mtime filter) |
| `flow_sdk/compute/providers/local_compute_provider.py` | PTY spawn, read loop, input/resize |
| `flow_sdk/builtin/faas/pty_session_manager.py` | WebSocket-to-PTY attachment registry |
| `flow_sdk/builtin/faas/pty_replay_buffer.py` | Circular output buffer (5000 chunks, 2 MB) |
| `flow_sdk/builtin/faas/compute_node.py` | PTY attach/detach, replay delivery |
| `server/routes/websocket.py` | WebSocket connection management |

### TypeScript SDK

| File | Role |
|------|------|
| `ts_sdk/src/agentic_processor/agentic-process.ts` | `AgenticProcess` entity class |
| `ts_sdk/src/agentic_processor/agentic-processor.ts` | `AgenticProcessor` entity class |
| `ts_sdk/src/agentic_processor/agentic-context.ts` | `AgenticContext` DTO + serializer |
| `ts_sdk/src/agentic_processor/agentic-types.ts` | `WorkerStatus`, `ProcessorState`, `StackFrame` |
| `ts_sdk/src/services/claude/claudeSessionManager.ts` | `ClaudeSessionManager` singleton |
| `ts_sdk/src/services/claude/claudeCliCommand.ts` | `ClaudeCliCommand` builder (parse / generate) |
| `ts_sdk/src/services/claude/claudeSessionEvents.ts` | `ClaudeSessionEvent` enum |
| `ts_sdk/src/services/shell/shellManager.ts` | `ShellManager` — WebSocket attach/detach orchestration |
| `ts_sdk/src/services/shell/shellSession.ts` | Per-tab xterm.js session wrapper |

### Frontend UI

| File | Role |
|------|------|
| `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` | Chrome/Trust toggles, Fork, Restart, Session Info |
| `ui/src/components/terminal/interactive-terminal/RestartRequiredOverlay.tsx` | Overlay when flags change |
| `ui/src/components/terminal/InteractiveTerminal.tsx` | xterm.js + WebSocket terminal |
| `ui/src/components/terminal/TabbedTerminal.tsx` | Tab management |

### Docs

| File | Contents |
|------|---------|
| `docs/agent-management-spec.md` | This file — complete agent management spec |
| `docs/agentic-process.md` | Deep dive: PTY layers, status derivation, data flow |
| `docs/pty-terminal-spec.md` | Terminal system: WebSocket protocol, replay, encoding |
| `docs/claude-session-manager.md` | ClaudeSessionManager API reference |
| `docs/fs_store.md` | Record system |
| `docs/record-entity-sync.md` | `vfs_record` entity-record sync |
