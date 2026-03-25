# AgenticProcess

`AgenticProcess` represents a single Claude Code execution session. It is a child entity of `AgenticProcessor` and is the primary unit of execution in the agent management system. One `AgenticProcess` corresponds to one Claude CLI invocation — either an interactive PTY session or an AMD streaming execution.

The entity exists in two representations:

- **SQLite-backed entity** (`flow_sdk/builtin/agentic_processor.py`) — survives server restarts, carries session IDs and execution context.
- **Filesystem record** (`flow_sdk/fs_records/agentic_process.py`) — lightweight snapshot used for status derivation.

---

## Table of Contents

1. [Entity Fields](#entity-fields)
2. [AgenticContext Configuration](#agenticcontext-configuration)
3. [ProcessorState Fields](#processorstate-fields)
4. [Execution Models](#execution-models)
5. [PTY Lifecycle](#pty-lifecycle)
6. [AMD Execution Blocks](#amd-execution-blocks)
7. [Status Derivation](#status-derivation)
8. [TypeScript API](#typescript-api)
9. [API Endpoints](#api-endpoints)
10. [Key Files Reference](#key-files-reference)

---

## Entity Fields

These are the persisted fields on the `AgenticProcess` SQLite entity. All fields are accessible in the TypeScript `IAgenticProcess` interface and returned by the API.

| Field | Type | Description |
|-------|------|-------------|
| `processor_id` | `str` | Parent `AgenticProcessor` entity ID |
| `worker_session_id` | `str \| None` | Claude Code session ID. Used as the JSONL filename (`~/.claude/projects/<encoded-cwd>/<sid>.jsonl`) and passed as `--session-id` on first start or `--resume` on restart. Persistent across PTY restarts — this is the key to resumability. |
| `pty_pid` | `str \| None` | UUID of the currently active OS-level PTY process. Changes on every `resumePty()` call. Set to `null` when no PTY is attached (detached, killed, or server restarted). |
| `compute_node_id` | `str` | The `ComputeNode` entity that hosts the PTY (format: `compute_node-<id>`). |
| `state` | `dict` | `ProcessorState` dict — contains `status`, `error`, `debug`, `stack`, `variables`, `index`, and related fields. See [ProcessorState Fields](#processorstate-fields). |
| `context_data` | `dict` | Persisted execution context. Contains `workdir`, `permission_mode`, `model`, `chrome`, `env_vars`, `agents_json`. Used on resume to reconstruct the same CLI flags. |
| `instruction_content` | `str` | The prompt text submitted to Claude. |
| `source_vfs_path` | `str \| None` | VFS path of the executed instruction file, if launched from a file. |
| `favorite_index` | `int \| None` | Optional tab ordering pin. Lower values appear first. |
| `use_worker_history` | `bool` | Whether the worker session manages its own conversation history. |

### context_data Keys

The `context_data` dict is stored on the entity and used to reconstruct the `claude` CLI command on every PTY start or resume.

| Key | Type | CLI mapping |
|-----|------|-------------|
| `workdir` | `str` | `cd <workdir> &&` |
| `permission_mode` | `"bypassPermissions" \| "askUser"` | `--dangerously-skip-permissions` when `bypassPermissions` |
| `model` | `str` | `--model <model>` |
| `chrome` | `bool` | `--chrome` |
| `env_vars` | `dict[str, str]` | Injected inline: `KEY=VALUE ...` before the `claude` invocation |
| `agents_json` | `dict` | `--agents '<json>'` |

---

## AgenticContext Configuration

`AgenticContext` is the TypeScript DTO used to configure a process at creation time. It is serialized to snake_case by `serializeAgenticContext()` before being sent to the Python backend, where it is stored as `context_data`.

**TypeScript interface** (`ts_sdk/src/agentic_processor/agentic-context.ts`):

```ts
interface AgenticContext {
  workdir?: string;               // Working directory for file operations
  model?: string;                 // Claude model (e.g. "claude-sonnet-4-20250514")
  permissionMode?: PermissionMode; // 'bypassPermissions' | 'askUser'
  chrome?: boolean;               // Pass --chrome flag to Claude CLI
  agentsJson?: Record<string, Record<string, unknown>>; // Sub-agent definitions
  envVars?: Record<string, string>; // Extra env vars injected into the shell
  instructions?: string;          // Additional instructions to prepend
  maxThinkingTokens?: number;     // Max tokens for extended reasoning
  projectId?: string;             // Project scope association
  resumeSessionId?: string;       // worker_session_id to resume
  forkSession?: boolean;          // Fork instead of resume in-place
}
```

**Serialization mapping** (camelCase to snake_case for Python):

| TS field | Python key |
|----------|-----------|
| `permissionMode` | `permission_mode` |
| `agentsJson` | `agents_json` |
| `envVars` | `env_vars` |
| `maxThinkingTokens` | `max_thinking_tokens` |
| `resumeSessionId` | `resume_session_id` |
| `forkSession` | `fork_session` |

---

## ProcessorState Fields

The `state` field on the entity is a `ProcessorState` dict. It carries runtime execution state for the AMD model; for the PTY model, only `status` and `error` are meaningful.

| Field | Type | Description |
|-------|------|-------------|
| `status` | `ProcessorStatus` | Current execution status. For PTY processes, this is derived from the transcript on every API read. |
| `index` | `int` | Index of the currently executing instruction (AMD model). |
| `totalInstructions` | `int` | Total instruction count in the loaded instruction file. |
| `currentInstructionId` | `str \| None` | ID of the currently executing `flow-do` block. |
| `variables` | `dict` | Execution context variables visible at the top level. |
| `waitingForInput` | `bool` | True when a blocking UI instruction is waiting for user response. |
| `inputId` | `str \| None` | ID of the pending input request. |
| `stack` | `StackFrame[]` | Call stack for nested execution (AMD `flow-call` blocks). |
| `debug` | `DebugState` | Debug configuration: `enabled`, `breakpoints`, `stepMode`. |
| `error` | `str \| None` | Error message if status is `error`. |
| `mdoContent` | `str \| None` | Raw AMD content currently loaded (AMD model only). |

### StackFrame Fields

| Field | Type | Description |
|-------|------|-------------|
| `frameId` | `str` | Unique frame identifier |
| `type` | `'call' \| 'block' \| 'if' \| 'each'` | Frame type |
| `instructionId` | `str` | Instruction that created this frame |
| `index` | `int` | Instruction index within this frame |
| `sourceVfsPath` | `str \| undefined` | VFS path of the called file |
| `localVariables` | `dict` | Variables local to this frame |
| `iteratorName` | `str \| undefined` | Loop variable name (for `each` frames) |
| `iteratorIndex` | `int \| undefined` | Current loop iteration |
| `iteratorTotal` | `int \| undefined` | Total loop iterations |

---

## Execution Models

Two fundamentally different execution models operate on the same `AgenticProcess` entity. They are mutually exclusive per process instance.

### Model A: PTY / Claude CLI (Interactive)

Used by `ProcessToolbar`, `InteractiveTerminal`, and all user-facing terminal tabs.

```
processor.createProcess(context)
  --> AgenticProcess entity (idle, no session yet)
  --> process.startPty({ instruction })
  --> Backend spawns PTY running: claude --session-id <sid> -p "..."
  --> xterm.js renders live output via WebSocket
  --> Session transcript saved at ~/.claude/projects/.../<worker_session_id>.jsonl
  --> Status derived on every API read by scanning JSONL transcript
```

The PTY model provides interactive streaming terminal output. The `worker_session_id` is the persistent anchor: it survives PTY death and server restarts, enabling resume via `claude --resume <sid>`.

### Model B: AMD / FlowData (Streaming SDK)

Used by scripts, automation, and the legacy processor run loop.

```
processor.run(instructionFile, context)
  --> Backend executes AMD instruction blocks
  --> FlowData events pushed to frontend via WebSocket entity notifications
  --> process.output() AsyncGenerator yields FlowData
  --> Status from entity state.status (no transcript)
```

The AMD model executes structured instruction files and streams structured `FlowData` events. Status transitions are managed by the backend executor and reflected in `state.status`.

---

## PTY Lifecycle

### Session ID Semantics

Two independent IDs track different aspects of a session:

| Field | Scope | Survives | Changes when |
|-------|-------|----------|-------------|
| `worker_session_id` | Claude Code session — JSONL transcript | PTY death, server restart | Never (only set once per new session) |
| `pty_pid` | OS-level PTY process | Tab switch, page refresh | Every `resumePty()` call; cleared on kill |

### 1. Create Process

```ts
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

Backend action: `POST /api/v1/graph/agentic_processor/<id>/createProcess`

### 2. Start PTY

```ts
const { ptyPid, workerSessionId } = await process.startPty({
  instruction: 'List all Python files in the project',
});
// process.worker_session_id == workerSessionId  (new UUID)
// process.pty_pid == ptyPid        (new UUID)
```

The backend generates both UUIDs, builds the full shell command, and spawns a PTY via `LocalComputeProvider.get_or_create_pty_session()`:

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

Environment is sanitized: `CLAUDECODE*` variables are stripped, `TERM=xterm-256color` is set, `FLOWPAD_PTY_SESSION_ID` is injected. On macOS/Linux the shell is spawned via `ptyprocess.PtyProcess.spawn()`; on Windows via `winpty.PtyProcess.spawn()`.

Backend action: `POST /api/v1/graph/agentic_process/<id>/start-pty`

### 3. Running State

A daemon thread reads PTY output in a blocking loop. Each `read(1024)` chunk is:
1. Broadcast to all attached WebSocket clients via an `on_output` callback.
2. Appended to the `PtyReplayBuffer` with a monotonic sequence number.

The replay buffer holds up to 5,000 chunks (2 MB max) per session. Clients reconnecting after a page refresh send a `since_seq` value to request only the chunks they missed.

### 4. Kill PTY

```ts
await process.killPty();
// process.pty_pid == null
// process.worker_session_id unchanged
```

Backend sequence:
1. Clear `pty_pid` in the DB **before** sending the signal — prevents a race with `_on_pty_exit`.
2. Send SIGINT to the PTY process.
3. Close the PTY session.

The `worker_session_id` is preserved so the process can be resumed later.

Backend action: `POST /api/v1/graph/agentic_process/<id>/kill-pty`

### 5. Resume PTY

```ts
const { ptyPid } = await process.resumePty();
// process.pty_pid == ptyPid  (new UUID)
// process.worker_session_id unchanged
```

Backend builds: `claude --resume <worker_session_id>`. Claude Code reads the existing JSONL transcript and continues the conversation from the last turn. The old `pty_pid` is replaced; the `worker_session_id` never changes.

Backend action: `POST /api/v1/graph/agentic_process/<id>/resume-pty`

### 6. PTY Exit Callback

When the PTY process dies (any cause):

```
_on_pty_exit(exit_code) fires from daemon thread
  --> asyncio.run_coroutine_threadsafe() schedules async cleanup
  --> Check: pty_pid already cleared? (kill_pty handled it --> skip)
  --> If exit_code != 0: _set_process_state(error="Exit code N")
  --> Clear pty_pid
  --> Save entity
  --> Status on next read: transcript-derived
```

### Survival Matrix

| Event | PTY process | Output history | DB entity | Recovery |
|-------|-------------|----------------|-----------|----------|
| Tab switch | Alive | In memory | Persisted | Instant reattach |
| Page refresh | Alive | In replay buffer | Persisted | Reattach + replay from `since_seq` |
| Detach > 15 min | Killed by TTL | Lost | Persisted | `resumePty()` |
| Server restart | Killed | Lost | Persisted | `resumePty()` |
| Entity deleted | Killed | Lost | Deleted | Not recoverable |

The TTL cleanup task runs every 2 minutes and kills sessions that have been fully detached for more than 15 minutes.

---

## AMD Execution Blocks

AMD (Agentic Message Display) instructions are structured HTML-comment blocks embedded in Markdown files. They describe what Claude should do and are parsed by the backend executor.

### Block Format

The basic `flow-do` block wraps a single instruction:

```markdown
<!-- <flow-do id="instr_001"> -->
List all Python files in the project directory.
<!-- </flow-do> -->
```

When `AgenticProcess.execute()` is called with plain text, it automatically wraps the text in a `flow-do` block:

```ts
private static _wrapInAmd(command: string): string {
  if (AgenticProcess._isAmdContent(command)) {
    return command;
  }
  const instrId = `instr_${Date.now().toString(36)}`;
  return `<!-- <flow-do id="${instrId}"> -->\n${command}\n<!-- </flow-do> -->`;
}
```

Content is already in AMD format if it matches `/<!--\s*<\/?flow-[a-z]+/i`.

### Run Modes

| Entry point | Method | Input type | Backend action |
|------------|--------|-----------|----------------|
| `processor.run(instructionFile, context)` | `run` | `InstructionFile` with AMD content | `run` |
| `processor.run('/path/to/file.md')` | `run` | VFS path string | `runFile` |
| `processor.run('<!-- <flow-do>... -->')` | `run` | Raw AMD content string | `controlStart` |
| `processor.execute(text, context)` | `execute` | Plain text (auto-wrapped) | `execute` |
| `process.executeInstruction(text)` | `executeInstruction` | Plain text | `execute` on process |

### FlowData Output

During AMD execution, the backend pushes `FlowData` events to the frontend via WebSocket entity notifications. The `process.output()` method exposes these as an `AsyncGenerator`:

```ts
const process = await processor.run(instructionFile, context);

for await (const flowData of process.output()) {
  console.log(`[${flowData.elementType}]`, flowData.data);
}
```

`FlowData` items have an `elementType` (e.g., `user-message`, `status`, `ui`) and a `data` payload. When a `status` FlowData with `complete="true"` attribute arrives, the process is marked complete.

### Multi-Turn Execution

An idle process can accept multiple sequential instructions without creating a new entity:

```ts
const process = await processor.createProcess({ workdir: '/path' });

await process.executeInstruction('Remember the number 42');
await process.executeInstruction("What's the number?");

await process.exit();
```

`executeInstruction()` resets `_completed = false` for each new instruction and waits for the `complete` event before resolving (when `sync: true`, which is the default).

### Injection

Additional instructions can be injected mid-execution. They are queued on the backend and executed after the current instruction completes:

```ts
const result = await process.inject('Also count the files');
console.log('Queue size:', result.injectedQueueSize);
```

### Debug Mode (AMD)

```ts
const process = await processor.run(instructionFile, context, {
  debug: true,
  breakpoints: ['instr_001', 'instr_003'],
});

await processor.step('over');   // Step over current instruction
await processor.step('into');   // Step into sub-call
await processor.step('out');    // Step out of current frame
```

---

## Status Derivation

### Status Enum

```ts
enum ProcessorStatus {
  IDLE       = 'idle',        // Created, no session started
  RUNNING    = 'running',     // Claude actively processing
  PAUSED     = 'paused',      // Debug breakpoint hit (AMD model)
  STEPPING   = 'stepping',    // Debug step mode (AMD model)
  COMPLETE   = 'complete',    // Turn finished (end_turn / stop_sequence)
  ERROR      = 'error',       // Non-zero exit / execution error
  TERMINATED = 'terminated',  // Explicitly killed via exit()
}
```

Python mirror: `ProcessorStatus` StrEnum in `flow_sdk/fs_records/agentic_process.py`.

### PTY Model: Transcript-Based Derivation

For PTY processes, status is **not stored** in the DB. On every API read, `_discover_status_from_transcript()` scans the JSONL file at `~/.claude/projects/<encoded-cwd>/<worker_session_id>.jsonl`.

```
_discover_status_from_transcript()
  |
  +-- worker_session_id not set?     --> None (use DB fallback: "idle")
  |
  +-- Transcript file not found?     --> None (use DB fallback)
  |
  +-- No assistant entries in JSONL? --> "idle"
  |
  +-- Last assistant entry's stop_reason:
       +-- "end_turn"                --> "complete"
       +-- "stop_sequence"           --> "complete"
       +-- "tool_use"                --> "running"
       +-- None                      --> "running"
```

The derived status is injected in two places in the Python entity:

1. `_get_process_state()` — used by internal callers:
   ```python
   state = copy.deepcopy(self.state)
   transcript_status = self._discover_status_from_transcript()
   if transcript_status is not None:
       state["status"] = transcript_status
   return state
   ```

2. `api_json_serializer()` — used during Pydantic serialization for API responses:
   ```python
   data = nxt(self)
   transcript_status = self._discover_status_from_transcript()
   if transcript_status is not None:
       data["state"]["status"] = transcript_status
   return data
   ```

The persisted `state.status` in the database is a fallback for when no transcript is available. `_set_process_state(error=...)` writes directly to `self.state` on non-zero exit, ensuring error messages persist, but the transcript-derived status always wins on the next read.

### JSONL stop_reason Mapping

Claude Code writes JSONL transcripts with streaming assistant entries. Only the last entry in each turn carries a non-`None` `stop_reason`:

```
assistant (stop=None, thinking)      <-- intermediate chunk
assistant (stop=None, text)          <-- intermediate chunk
assistant (stop=end_turn, text)      <-- FINAL: turn complete
```

| `stop_reason` | Meaning | Derived status |
|--------------|---------|----------------|
| `"end_turn"` | Claude finished its response | `complete` |
| `"stop_sequence"` | Hit stop sequence (used by `-p` flag) | `complete` |
| `"tool_use"` | Claude waiting for tool result | `running` |
| `None` | Streaming chunk or interrupted mid-stream | `running` |

### Status by Scenario (PTY)

| Scenario | `pty_pid` | Last `stop_reason` | Status |
|----------|-----------------|-------------------|--------|
| Just created | null | N/A | `idle` (DB fallback) |
| PTY started, no response yet | set | N/A | `idle` |
| Claude actively streaming | set | `None` | `running` |
| Claude calling a tool | set | `"tool_use"` | `running` |
| Claude finished turn | set | `"end_turn"` | `complete` |
| `-p` flag completed | set | `"stop_sequence"` | `complete` |
| User interrupted (Ctrl+C) | cleared | `None` | `running` |
| PTY killed after end_turn | cleared | `"end_turn"` | `complete` |

**Known limitation**: Interrupted and actively running sessions are indistinguishable from the transcript alone — both show `stop_reason=None`. Check `pty_pid != null` to confirm the PTY is still alive.

### AMD Model: State-Based Status

For AMD processes, status is managed by the backend executor and written to `state.status` directly. There is no transcript. Status transitions occur synchronously with instruction execution.

---

## TypeScript API

### Imports

```ts
import { AgenticProcess, IAgenticProcess, ExecuteOptions } from '@sdk';
import { AgenticProcessor } from '@sdk';
import { AgenticContext, serializeAgenticContext } from '@sdk';
import { ProcessorStatus, ProcessorState, StackFrame } from '@sdk';
```

### AgenticProcess Class

**File**: `ts_sdk/src/agentic_processor/agentic-process.ts`

Extends `APIEntity<AgenticProcess>` and receives entity notifications from the backend via WebSocket.

#### Static Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `execute` | `(command: string, options?: ExecuteOptions): Promise<AgenticProcess>` | One-shot execution. Creates a local `ComputeNode`, `AgenticProcessor`, and process internally. Wraps plain text in AMD if needed. |
| `getByIdWithHistory` | `(id: string): Promise<AgenticProcess \| null>` | Fetch a process by ID and auto-load its FlowData history. |

#### Instance Properties

| Property | Type | Description |
|----------|------|-------------|
| `state` | `ProcessorState` | Current execution state, synced from backend. |
| `worker_session_id` | `string \| null` | Persistent session ID for resumability. |
| `pty_pid` | `string \| null` | Active PTY UUID; null when detached. |
| `compute_node_id` | `string \| null` | ComputeNode hosting the PTY. |
| `context_data` | `Record<string, unknown>` | Persisted execution context. |
| `instruction_content` | `string` | Prompt text. |
| `processor_id` | `string` | Parent processor ID. |
| `favorite_index` | `number \| null` | Tab ordering pin. |
| `completed` | `boolean` (getter) | Whether the process has finished. |
| `error` | `Error \| null` (getter) | Error if execution failed. |
| `historyLoaded` | `boolean` (getter) | Whether history has been loaded from backend. |
| `workDirVfs` | `VFSPath \| null` (getter) | Working directory as a `VFSPath`, resolved from `context_data.workdir`. |
| `stackFrame` | `Record<string, unknown>` (getter) | Top-level variables merged with the top stack frame's local variables. |

#### PTY Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `startPty` | `(options?: { instruction?: string }): Promise<{ ptyPid: string; workerSessionId: string }>` | Spawn a new PTY. Generates both session IDs. |
| `resumePty` | `(): Promise<{ ptyPid: string; workerSessionId: string }>` | Spawn a new PTY on the existing `worker_session_id` using `--resume`. |
| `killPty` | `(): Promise<void>` | Send SIGINT, close PTY, clear `pty_pid`. |

#### AMD Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `executeInstruction` | `(instruction: string, options?: { sync?: boolean }): Promise<void>` | Execute an instruction on this process. Blocks until complete when `sync: true` (default). |
| `inject` | `(instruction: string): Promise<{ instructionId: string; injectedQueueSize: number }>` | Queue an additional instruction mid-execution. |
| `exit` | `(): Promise<void>` | Terminate the process. Sets status to `TERMINATED`. |
| `wait` | `(): Promise<void>` | Wait for process completion. Throws if the process errors. |
| `waitForIdle` | `(): Promise<void>` | Wait until status returns to `IDLE`. |
| `step` | `(): AsyncGenerator<FlowData>` | Yield FlowData for the current instruction only. |

#### Streaming Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `output` | `(): AsyncGenerator<FlowData, void, unknown>` | Yield all FlowData, including already-collected items, then wait for new ones. |
| `getOutputs` | `(): readonly FlowData[]` | Return all collected FlowData synchronously. |
| `loadHistory` | `(options?: { force?: boolean; onlyUserMessages?: boolean }): Promise<void>` | Load historical FlowData from the backend `get-history` action. Safe to call multiple times. |
| `appendUserMessage` | `(content: string): void` | Optimistically append a user message to the stream (prevents missing `USER_MESSAGE` events emitted before watchers connect). |

#### Events

`AgenticProcess` extends the event emitter pattern from `APIEntity`:

| Event | Payload | Fired when |
|-------|---------|------------|
| `flow_data` | `FlowData` | A new FlowData arrives from the backend. |
| `complete` | none | Process execution completes. |
| `error` | `Error` | Execution fails. |
| `state_change` | `ProcessorState` | The `state` object is updated. |

### AgenticProcessor Class

**File**: `ts_sdk/src/agentic_processor/agentic-processor.ts`

Extends `APIEntity<AgenticProcessor>`. Manages a pool of `AgenticProcess` instances and provides factory methods.

| Method | Signature | Description |
|--------|-----------|-------------|
| `run` | `(input: InstructionFile \| string, context?: AgenticContext, options?): Promise<AgenticProcess>` | Run an instruction file, VFS path, or raw AMD content. Returns a process for streaming. |
| `execute` | `(content: string, context: AgenticContext, options?): Promise<AgenticProcess>` | Execute plain text or AMD directly. Uses `execute` backend action. |
| `createProcess` | `(context: AgenticContext, options?): Promise<AgenticProcess>` | Create an idle process for multi-turn use via `executeInstruction()`. |
| `continueProcess` | `(processId: string, mdoContent: string, options?): Promise<AgenticProcess>` | Resume an existing process with new AMD content using its `worker_session_id`. |
| `sendInput` | `(data: unknown, inputId?: string): Promise<void>` | Respond to a blocking UI input request. |
| `step` | `(mode: 'over' \| 'into' \| 'out'): Promise<void>` | Debug step (AMD only). |
| `appendInstruction` | `(content: string, instructionId?: string): Promise<{ instructionId: string; totalInstructions: number }>` | Append an instruction to the running queue. |
| `abort` | `(): Promise<void>` | Abort execution. |
| `getProcess` | `(processId: string): AgenticProcess \| undefined` | Get a running process by ID from the in-memory registry. |
| `getRunningProcesses` | `(): Record<string, AgenticProcess>` | All processes currently tracked as running. |
| `dispose` | `(): void` | Mark all running processes complete and clear the registry. |

#### AgenticProcessor Events

| Event | Payload | Fired when |
|-------|---------|------------|
| `ui` | `UIComponentPayload` | A `flow-ui` instruction requests a UI component. |
| `waiting` | `string` (inputId) | A blocking UI input is waiting for user response. |
| `complete` | none | All instructions complete. |
| `error` | `string` | Execution fails. |
| `state_change` | `ProcessorState` | The `state` object is updated. |

### Usage Examples

#### PTY — Interactive Session

```ts
import { AgenticProcessor } from '@sdk';
import { claudeSessionManager } from '@sdk';

const processor = await AgenticProcessor.getById<AgenticProcessor>(processorId);
const process = await processor.createProcess({
  workdir: '/path/to/project',
  permissionMode: 'bypassPermissions',
  model: 'claude-sonnet-4-20250514',
});

// Start a PTY session
const { ptyPid, workerSessionId } = await process.startPty({
  instruction: 'List all Python files',
});

// xterm.js attaches to ptyPid via WebSocket
// ... user interacts in terminal ...

// Kill and resume later
await process.killPty();
const { ptyPid: newPtyId } = await process.resumePty();
```

#### AMD — Streaming Output

```ts
import { AgenticProcess } from '@sdk';

// Simple one-shot
const process = await AgenticProcess.execute('List all Python files', {
  workdir: '/path/to/project',
});

for await (const flowData of process.output()) {
  console.log(`[${flowData.elementType}]`, flowData.data);
}
```

#### AMD — Multi-Turn

```ts
const process = await processor.createProcess({ workdir: '/path' });

await process.executeInstruction('Remember the number 42');
await process.executeInstruction("What's the number?");

await process.exit();
```

#### AMD — With InstructionFile

```ts
import { InstructionFile } from '@sdk';

const amdContent = `
<!-- <flow-do id="step1"> -->
List the 5 largest files.
<!-- </flow-do> -->
<!-- <flow-do id="step2"> -->
Summarize what you found.
<!-- </flow-do> -->
`;

const instructionFile = InstructionFile.fromContent(amdContent);
const process = await processor.run(instructionFile, {
  workdir: '/path/to/project',
  permissionMode: 'bypassPermissions',
});

for await (const flowData of process.output()) {
  console.log(flowData.data);
}
```

---

## API Endpoints

All routes go through `/api/v1/graph/{type}/{id}/{action}`.

### AgenticProcess

```
GET    /api/v1/graph/agentic_process/<id>            # Read entity (status derived from transcript)
PUT    /api/v1/graph/agentic_process/<id>            # Update fields (save context_data)
DELETE /api/v1/graph/agentic_process/<id>            # Delete entity

POST   /api/v1/graph/agentic_process/<id>/start-pty  # Spawn new PTY
POST   /api/v1/graph/agentic_process/<id>/resume-pty # New PTY on same worker_session_id
POST   /api/v1/graph/agentic_process/<id>/kill-pty   # SIGINT + close PTY
POST   /api/v1/graph/agentic_process/<id>/exit       # Terminate (AMD model)
POST   /api/v1/graph/agentic_process/<id>/inject     # Inject instruction into queue
GET    /api/v1/graph/agentic_process/<id>/get-history # Fetch FlowData history
```

### AgenticProcessor

```
POST /api/v1/graph/agentic_processor/<id>/createProcess   # Create idle process
POST /api/v1/graph/agentic_processor/<id>/run             # Create + run (AMD)
POST /api/v1/graph/agentic_processor/<id>/execute         # Execute via initialize_from_prompt
POST /api/v1/graph/agentic_processor/<id>/runFile         # Run from VFS path
POST /api/v1/graph/agentic_processor/<id>/controlStart    # Start with raw AMD content
POST /api/v1/graph/agentic_processor/<id>/controlAppend   # Append instruction to queue
POST /api/v1/graph/agentic_processor/<id>/controlContinue # Continue existing process
POST /api/v1/graph/agentic_processor/<id>/controlInput    # Respond to blocking UI
POST /api/v1/graph/agentic_processor/<id>/controlStep     # Debug step
POST /api/v1/graph/agentic_processor/<id>/controlAbort    # Abort execution
```

### Response Format

All responses use `ApiResponse`:

```json
{ "status": "OK", "data": { ... } }
{ "status": "FAIL", "message": "..." }
```

The `state.status` field in `data` always reflects the transcript-derived status for PTY processes, not the DB value.

---

## Key Files Reference

### Backend Python

| File | Role |
|------|------|
| `flow_sdk/builtin/agentic_processor.py` | `AgenticProcessor` + `AgenticProcess` entity classes (~1828 lines) |
| `flow_sdk/fs_records/agentic_process.py` | `AgenticProcess` Record — `ProcessorStatus` enum, `discover_status()` |
| `flow_sdk/fs_records/claude/claude_session.py` | `ClaudeSessionFsRecord` — JSONL reader, `status` property, transcript entry parsing |
| `flow_sdk/fs_records/claude/claude_active_session.py` | Active session discovery by mtime filter |
| `flow_sdk/compute/providers/local_compute_provider.py` | PTY spawn, read loop, input/resize, close |
| `flow_sdk/builtin/faas/pty_session_manager.py` | Singleton registry of WebSocket-to-PTY attachments |
| `flow_sdk/builtin/faas/pty_replay_buffer.py` | Circular output buffer (5,000 chunks, 2 MB) with sequence numbers |
| `flow_sdk/builtin/faas/compute_node.py` | PTY attach/detach orchestration, replay delivery |
| `server/routes/websocket.py` | WebSocket connection management |

### TypeScript SDK

| File | Role |
|------|------|
| `ts_sdk/src/agentic_processor/agentic-process.ts` | `AgenticProcess` entity class — PTY API, AMD streaming, state, history |
| `ts_sdk/src/agentic_processor/agentic-processor.ts` | `AgenticProcessor` entity class — process creation, `run()`, `execute()` |
| `ts_sdk/src/agentic_processor/agentic-context.ts` | `AgenticContext` DTO and `serializeAgenticContext()` |
| `ts_sdk/src/agentic_processor/agentic-types.ts` | `ProcessorStatus`, `ProcessorState`, `StackFrame`, `DebugState` |
| `ts_sdk/src/agentic_processor/index.ts` | Public re-exports for the `agentic_processor` module |
| `ts_sdk/src/services/claude/claudeSessionManager.ts` | `ClaudeSessionManager` singleton — start, resume, restart, fork, kill |
| `ts_sdk/src/services/claude/claudeCliCommand.ts` | `ClaudeCliCommand` builder — parse and generate CLI invocation strings |
| `ts_sdk/src/services/shell/shellManager.ts` | Shell lifecycle orchestration — sync, attach, detach |
| `ts_sdk/src/services/shell/shellSession.ts` | Per-tab xterm.js session wrapper |

### Frontend UI

| File | Role |
|------|------|
| `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` | Chrome/Trust toggles, Fork, Restart, Session Info popover |
| `ui/src/components/terminal/interactive-terminal/RestartRequiredOverlay.tsx` | Overlay shown when flags change and restart is required |
| `ui/src/components/terminal/InteractiveTerminal.tsx` | xterm.js + WebSocket terminal component |
| `ui/src/components/terminal/TabbedTerminal.tsx` | Tab management for multiple terminal sessions |

### Related Documentation

| File | Contents |
|------|---------|
| `docs/agent-management-spec.md` | Complete agent management spec — entity hierarchy, all lifecycle sections, ClaudeSessionManager reference |
| `docs/agentic-process.md` | Deep dive: three-layer architecture, PTY mechanics, reconnection flow |
| `docs/claude-session-manager.md` | `ClaudeSessionManager` full API reference |
| `docs/pty-terminal-spec.md` | WebSocket protocol, replay buffer, encoding details |
