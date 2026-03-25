# ClaudeSessionManager

Singleton TypeScript service for Claude PTY session lifecycle management.

Located at `ts_sdk/src/services/claude/`.

---

## Overview

`ClaudeSessionManager` is the canonical coordinator for all Claude PTY session operations: start, resume, restart, fork, and kill. It mirrors the `ShellManager` pattern but is focused on `AgenticProcess` entities rather than raw shell sessions.

The class extends Node.js `EventEmitter`. A pre-constructed singleton instance is exported as `claudeSessionManager` for use throughout the UI and SDK.

### Responsibilities

- Wrapping `AgenticProcess` PTY lifecycle calls (`startPty`, `resumePty`, `killPty`) in a single orchestrated service.
- Emitting typed `ClaudeSessionEvent` events after each operation so subscribers can react consistently (e.g., updating UI state, navigation).
- Implementing compound patterns — restart (kill + resume) and fork (create sibling process + start new PTY) — so callers do not have to coordinate these steps manually.
- Exposing the singleton on `window.claudeSessionManager` in browser environments for debugging.

### Files

| File | Purpose |
|------|---------|
| `ts_sdk/src/services/claude/claudeSessionManager.ts` | Singleton class and exported instance |
| `ts_sdk/src/services/claude/claudeCliCommand.ts` | Typed CLI command builder: parse, modify, generate |
| `ts_sdk/src/services/claude/claudeSessionEvents.ts` | `ClaudeSessionEvent` enum |
| `ts_sdk/src/services/claude/index.ts` | Module re-exports |

### Importing

```ts
import { claudeSessionManager } from '@sdk';
// or directly:
import { claudeSessionManager } from 'ts_sdk/src/services/claude';
```

---

## ClaudeSessionManager

### Singleton Pattern

`ClaudeSessionManager` uses a private constructor with a static `getInstance()` factory. The module-level export `claudeSessionManager` calls `getInstance()` at import time, so all consumers share the same instance.

```ts
export class ClaudeSessionManager extends EventEmitter {
  private static instance: ClaudeSessionManager | null = null;

  private constructor() { super(); }

  static getInstance(): ClaudeSessionManager {
    if (!ClaudeSessionManager.instance) {
      ClaudeSessionManager.instance = new ClaudeSessionManager();
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).claudeSessionManager =
          ClaudeSessionManager.instance;
      }
    }
    return ClaudeSessionManager.instance;
  }
}

export const claudeSessionManager = ClaudeSessionManager.getInstance();
```

`resetInstance()` is provided for tests — it removes all listeners and clears the `window` reference:

```ts
ClaudeSessionManager.resetInstance();
```

### Result Types

```ts
interface StartResult {
  ptyPid: string;
  workerSessionId: string;
}

type ResumeResult = StartResult;
```

Both types carry the two session IDs returned by the backend after a PTY starts or resumes. See the [Session IDs](#session-ids) section for the distinction between the two.

---

## Public Methods

### Method Summary

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `startSession` | `(process, options?)` | `Promise<StartResult>` | Brand-new session with a new `worker_session_id` |
| `resumeSession` | `(process)` | `Promise<ResumeResult>` | New PTY on the same session history (`--resume`) |
| `restartSession` | `(process)` | `Promise<ResumeResult>` | Kill existing PTY then resume (canonical restart) |
| `forkSession` | `(process)` | `Promise<AgenticProcess>` | Create sibling process with same `context_data`, fresh session |
| `killSession` | `(process)` | `Promise<void>` | Kill PTY only, preserve `worker_session_id` |

### `startSession(process, options?)`

Start a brand-new Claude session. Calls `process.startPty()` on the backend, which generates a new `worker_session_id` and a new `pty_pid`.

```ts
async startSession(
  process: AgenticProcess,
  options?: { instruction?: string }
): Promise<StartResult>
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process` | `AgenticProcess` | Yes | The process entity to start |
| `options.instruction` | `string` | No | Initial prompt text passed to Claude via `-p "..."` |

**Returns:** `StartResult` with the new `ptyPid` and `workerSessionId`.

**Emits:** `SESSION_STARTED` on success, `SESSION_ERROR` on failure.

```ts
const result = await claudeSessionManager.startSession(process, {
  instruction: 'List all TypeScript files in the project',
});
console.log(result.workerSessionId); // new UUID persisted to process entity
```

---

### `resumeSession(process)`

Resume an existing session in a new PTY. The old `pty_pid` is replaced; `worker_session_id` remains the same. Calls `process.resumePty()` on the backend, which runs `claude --resume <worker_session_id>`.

```ts
async resumeSession(process: AgenticProcess): Promise<ResumeResult>
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process` | `AgenticProcess` | Yes | The process entity to resume. Must have `worker_session_id` set. |

**Returns:** `ResumeResult` with the new `ptyPid` and the unchanged `workerSessionId`.

**Emits:** `SESSION_RESUMED` on success, `SESSION_ERROR` on failure.

```ts
const result = await claudeSessionManager.resumeSession(process);
// process.worker_session_id unchanged
// process.pty_pid == result.ptyPid (new)
```

---

### `restartSession(process)`

Kill the current PTY then resume — the canonical "restart" operation used by `ProcessToolbar` after flag changes. If `process.pty_pid` is set, `killPty()` is called first; then `resumePty()` is called.

```ts
async restartSession(process: AgenticProcess): Promise<ResumeResult>
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process` | `AgenticProcess` | Yes | The process entity to restart |

**Returns:** `ResumeResult` from the subsequent `resumePty()` call.

**Emits:** `SESSION_RESTARTED` on success, `SESSION_ERROR` on failure.

**Typical usage** — save updated `context_data` before calling, so the resumed PTY picks up the new flags:

```ts
process.context_data = { ...process.context_data, chrome: true };
await process.save();
await claudeSessionManager.restartSession(process);
```

**State preserved:** `worker_session_id` and the JSONL session transcript — Claude resumes the same conversation.

**State cleared:** `pty_pid` (cleared by `killPty()`, then set to a new value by `resumePty()`).

---

### `forkSession(process)`

Create a sibling `AgenticProcess` with the same `context_data`, then start a fresh PTY with a new `worker_session_id`. The fork shares no session history with the source process.

```ts
async forkSession(process: AgenticProcess): Promise<AgenticProcess>
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process` | `AgenticProcess` | Yes | The source process to fork from. Must have `processor_id` set. |

**Returns:** The newly created `AgenticProcess` entity. The caller is responsible for navigating to it.

**Emits:** `SESSION_FORKED` on success, `SESSION_ERROR` on failure.

**Throws:** `Error` if `process.processor_id` is not set or the parent processor is not found.

```ts
const newProcess = await claudeSessionManager.forkSession(process);
navigation.openShellProcess(newProcess.id);
```

---

### `killSession(process)`

Kill the PTY process only. Preserves `worker_session_id` so the session can be resumed later via `resumeSession()`.

```ts
async killSession(process: AgenticProcess): Promise<void>
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `process` | `AgenticProcess` | Yes | The process entity whose PTY should be killed |

**Emits:** `SESSION_KILLED` on success, `SESSION_ERROR` on failure.

```ts
await claudeSessionManager.killSession(process);
// process.pty_pid == null
// process.worker_session_id unchanged — resume is still possible
```

---

## Events

`ClaudeSessionManager` extends `EventEmitter`. Subscribe with `.on()` and unsubscribe with `.off()`.

### Event Enum

```ts
// ts_sdk/src/services/claude/claudeSessionEvents.ts
export enum ClaudeSessionEvent {
  SESSION_STARTED   = 'session_started',
  SESSION_RESUMED   = 'session_resumed',
  SESSION_RESTARTED = 'session_restarted',
  SESSION_FORKED    = 'session_forked',
  SESSION_KILLED    = 'session_killed',
  SESSION_ERROR     = 'session_error',
}
```

### Event Payloads

| Event | Enum value | Payload type | Description |
|-------|------------|--------------|-------------|
| `SESSION_STARTED` | `'session_started'` | `{ process: AgenticProcess, result: StartResult }` | New session started |
| `SESSION_RESUMED` | `'session_resumed'` | `{ process: AgenticProcess, result: ResumeResult }` | Existing session resumed in new PTY |
| `SESSION_RESTARTED` | `'session_restarted'` | `{ process: AgenticProcess, result: ResumeResult }` | PTY killed and resumed |
| `SESSION_FORKED` | `'session_forked'` | `{ sourceProcess: AgenticProcess, newProcess: AgenticProcess }` | New sibling process created and started |
| `SESSION_KILLED` | `'session_killed'` | `{ process: AgenticProcess }` | PTY killed, session preserved |
| `SESSION_ERROR` | `'session_error'` | `{ process: AgenticProcess, error: unknown }` | Any method threw an error |

### Subscribing

```ts
import { claudeSessionManager, ClaudeSessionEvent } from '@sdk';

claudeSessionManager.on(ClaudeSessionEvent.SESSION_RESTARTED, ({ process, result }) => {
  console.log('Restarted process', process.id, 'new PTY:', result.ptyPid);
});

claudeSessionManager.on(ClaudeSessionEvent.SESSION_FORKED, ({ sourceProcess, newProcess }) => {
  console.log('Forked', sourceProcess.id, '→', newProcess.id);
});

claudeSessionManager.on(ClaudeSessionEvent.SESSION_ERROR, ({ process, error }) => {
  console.error('Session error on', process.id, error);
});
```

Note: All methods re-throw errors after emitting `SESSION_ERROR`. Callers should handle rejections independently of the event listener.

---

## ClaudeCliCommand

`ClaudeCliCommand` is a typed representation of a `claude ...` CLI invocation. It replaces ad-hoc string concatenation when building or displaying shell commands.

Used by `ClaudeSessionManager`, `SessionInfoPopover`, and any code that needs to reconstruct or display the exact command Claude was launched with.

### Class Fields

| Field | Type | CLI mapping |
|-------|------|-------------|
| `sessionId` | `string \| undefined` | `--session-id <value>` |
| `resume` | `string \| undefined` | `--resume <value>` (mutually exclusive with `sessionId`) |
| `model` | `string \| undefined` | `--model <value>` |
| `permissionMode` | `PermissionMode \| undefined` | `--dangerously-skip-permissions` when `'bypassPermissions'` |
| `chrome` | `boolean \| undefined` | `--chrome` |
| `agentsJson` | `Record<string, unknown> \| undefined` | `--agents '<json>'` |
| `prompt` | `string \| undefined` | `-p "<value>"` |
| `cwd` | `string \| undefined` | `cd <cwd> &&` prefix |

### Factory Methods

#### `ClaudeCliCommand.fromProcess(process)`

Derive a command from an `AgenticProcess` entity's `context_data` and session fields.

```ts
static fromProcess(process: AgenticProcess): ClaudeCliCommand
```

Reads: `worker_session_id` → `sessionId`, `context_data.model`, `context_data.permission_mode`, `context_data.chrome`, `context_data.workdir`.

```ts
const cmd = ClaudeCliCommand.fromProcess(process);
cmd.toString();
// "cd /my/project && claude --dangerously-skip-permissions --session-id abc123"
```

#### `ClaudeCliCommand.fromContext(ctx, sessionId, resume?)`

Derive a command from an `AgenticContext` DTO and a session ID.

```ts
static fromContext(
  ctx: AgenticContext,
  sessionId: string,
  resume?: boolean   // default: false
): ClaudeCliCommand
```

When `resume` is `true`, the session ID is placed in `cmd.resume` (generates `--resume`) rather than `cmd.sessionId` (generates `--session-id`).

```ts
const cmd = ClaudeCliCommand.fromContext(ctx, workerSessionId, true);
cmd.toString();
// "cd /my/project && claude --resume abc123 --model claude-sonnet-4-20250514"
```

#### `ClaudeCliCommand.parse(cmdString)`

Parse an existing shell string into typed fields. Extracts an optional `cd <cwd> &&` prefix, then tokenises the remaining `claude ...` arguments.

```ts
static parse(cmdString: string): ClaudeCliCommand
```

```ts
const cmd = ClaudeCliCommand.parse(
  'cd /foo && claude --chrome --session-id abc123 --model claude-sonnet-4-20250514'
);
console.log(cmd.chrome);    // true
console.log(cmd.sessionId); // "abc123"
console.log(cmd.cwd);       // "/foo"
```

Note: The parser splits on whitespace; quoted arguments with embedded spaces are not supported.

### Generation Methods

#### `toArgs(): string[]`

Generate an args array suitable for passing to a subprocess. The `cwd` prefix is not included — it applies only to the full shell string.

```ts
cmd.toArgs();
// ['--dangerously-skip-permissions', '--chrome', '--session-id', 'abc', '--model', 'claude-sonnet-4-20250514']
```

Argument ordering: flags (`--dangerously-skip-permissions`, `--chrome`) precede session ID flags, then `--model`, `--agents`, and `-p`.

#### `toString(): string`

Generate a shell-ready command string including the `cd <cwd> &&` prefix if `cwd` is set.

```ts
cmd.toString();
// "cd /foo && claude --chrome --session-id abc --model claude-sonnet-4-20250514"
```

### Immutable Update

#### `with(patch): ClaudeCliCommand`

Return a new `ClaudeCliCommand` with specified fields overridden. Does not mutate the original.

```ts
with(patch: Partial<ClaudeCliCommand>): ClaudeCliCommand
```

```ts
// Strip the session ID for a fresh start
const freshCmd = existingCmd.with({ sessionId: undefined, resume: undefined });

// Switch to resume mode
const resumeCmd = existingCmd.with({ sessionId: undefined, resume: existingCmd.sessionId });
```

---

## Session IDs

Two independent UUIDs track different aspects of a session. Understanding the distinction is necessary when reasoning about fork and restart behaviour.

| Field | Scope | Survives | Changes when |
|-------|-------|----------|-------------|
| `worker_session_id` | Claude Code session (JSONL transcript) | PTY death, server restart, tab switch | Only on `startPty()` for a brand-new session |
| `pty_pid` | OS-level PTY process | Tab switch only | Every `resumePty()` call; cleared to `null` on `kill_pty()` |

`worker_session_id` is passed to Claude CLI as `--session-id` on first start and as `--resume` on subsequent resumes. Claude Code uses it as the JSONL filename:

```
~/.claude/projects/<encoded-workdir>/<worker_session_id>.jsonl
```

`pty_pid` is used by the WebSocket layer to route terminal I/O to the correct PTY subprocess. The UI checks for a non-null `pty_pid` to determine whether a live PTY is currently attached.

---

## Fork Pattern

`forkSession(process)` creates a sibling `AgenticProcess` with identical configuration settings but a completely new session history.

### Step-by-Step

1. Read `context_data` from the source process and build an `AgenticContext` object, mapping snake_case keys back to camelCase fields:
   - `context_data.workdir` → `context.workdir`
   - `context_data.model` → `context.model`
   - `context_data.permission_mode` → `context.permissionMode`
   - `context_data.chrome` → `context.chrome`
   - `context_data.agents_json` → `context.agentsJson`

2. Dynamically import `AgenticProcessor` (avoids circular imports at module load time).

3. Call `AgenticProcessor.getById<AgenticProcessor>(process.processor_id)` to retrieve the parent processor. Throws if `processor_id` is unset or the processor is not found.

4. Call `processor.createProcess(context)` to create a new `AgenticProcess` entity in the database. The new entity starts with `worker_session_id = null` and `pty_pid = null`.

5. Call `newProcess.startPty()` to spawn a PTY with a fresh `worker_session_id`. The backend generates this UUID — it has no relation to the source process's session.

6. Emit `SESSION_FORKED` with `{ sourceProcess, newProcess }`.

7. Return `newProcess` to the caller.

### What is and is not copied

| Item | Copied to fork |
|------|---------------|
| `workdir` | Yes |
| `model` | Yes |
| `permission_mode` | Yes |
| `chrome` | Yes |
| `agents_json` | Yes |
| `env_vars` | No (not mapped in `forkSession`) |
| `worker_session_id` | No — new UUID generated |
| JSONL transcript history | No |
| `instruction_content` | No |
| `favorite_index` | No |

### Usage Example

```ts
// In a React component:
const handleFork = async () => {
  const newProcess = await claudeSessionManager.forkSession(process);
  navigation.openShellProcess(newProcess.id);
};
```

---

## Restart Pattern

`restartSession(process)` is the canonical flow when session flags change (Chrome toggle, Full Trust toggle). It preserves session history while applying the updated configuration.

### Step-by-Step

1. Check if `process.pty_pid` is set (a live PTY exists).
2. If yes: call `process.killPty()`. The backend sends SIGINT to the PTY subprocess and clears `pty_pid` in the DB.
3. Call `process.resumePty()`. The backend spawns a new PTY with `claude --resume <worker_session_id>`, reading `context_data` from the DB to build the command. The new `context_data` (saved by the caller before this method) is used here.
4. Emit `SESSION_RESTARTED` with `{ process, result }`.

### State Changes

| Field | Before restart | After restart |
|-------|---------------|--------------|
| `worker_session_id` | Set | Unchanged |
| `pty_pid` | Set (or null if already dead) | New UUID from `resumePty()` |
| `context_data` | Old values | As last saved by caller |
| JSONL transcript | Existing history | Same file, unchanged |

### Caller Responsibility

The caller must save `context_data` before calling `restartSession`. The resumed PTY is built from the DB record — if `save()` was not called, the old flags take effect.

```ts
// RestartRequiredOverlay.tsx — save first, then restart
process.context_data = {
  ...process.context_data,
  chrome: pendingChrome,
  permission_mode: pendingDanger ? 'bypassPermissions' : 'askUser',
};
await process.save();
await claudeSessionManager.restartSession(process);
```

### Restart vs Resume

| | `restartSession` | `resumeSession` |
|-|-----------------|----------------|
| Kills existing PTY first | Yes (if alive) | No |
| Worker session ID | Unchanged | Unchanged |
| Picks up new `context_data` | Yes | Yes |
| Typical trigger | Flag toggle | Page reload / reattach after detach |

---

## Integration with AgenticProcess and PTY Layers

`ClaudeSessionManager` is a thin orchestration layer over three `AgenticProcess` methods that map to backend Python actions:

| `AgenticProcess` method | Backend action | HTTP endpoint |
|------------------------|---------------|---------------|
| `process.startPty(opts)` | `start_pty` | `POST /api/v1/graph/agentic_process/<id>/start-pty` |
| `process.resumePty()` | `resume_pty` | `POST /api/v1/graph/agentic_process/<id>/resume-pty` |
| `process.killPty()` | `kill_pty` | `POST /api/v1/graph/agentic_process/<id>/kill-pty` |

The `forkSession` flow additionally calls `processor.createProcess(context)`:

| `AgenticProcessor` method | Backend action | HTTP endpoint |
|--------------------------|---------------|---------------|
| `processor.createProcess(ctx)` | `createProcess` | `POST /api/v1/graph/agentic_processor/<id>/createProcess` |

### PTY Lifecycle Summary

```
startSession  → startPty   → new worker_session_id + new pty_pid
resumeSession → resumePty  → same worker_session_id + new pty_pid
restartSession→ killPty (if alive) → resumePty → same worker_session_id + new pty_pid
forkSession   → createProcess → startPty → new worker_session_id + new pty_pid
killSession   → killPty    → pty_pid = null, worker_session_id unchanged
```

### Backend PTY Command

When `startPty` is called, the backend builds the following shell command:

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

When `resumePty` is called, `--session-id <sid>` is replaced with `--resume <sid>`. The rest of the flags are re-read from `context_data` at resume time.

### Frontend Integration (ProcessToolbar)

`ProcessToolbar.tsx` uses `claudeSessionManager` for its Fork and Restart buttons:

```tsx
// Fork button
const handleFork = async () => {
  const newProcess = await claudeSessionManager.forkSession(process);
  navigation.openShellProcess(newProcess.id);
};

// Restart button (via RestartRequiredOverlay)
const handleRestart = async () => {
  process.context_data = { ...process.context_data, chrome: pendingChrome };
  await process.save();
  await claudeSessionManager.restartSession(process);
};
```

Toggle availability (Chrome, Full Trust) is enabled whenever `process.worker_session_id` is set. This is independent of `process.state.status`: a `status: 'running'` PTY process is Claude idle at the interactive prompt, not necessarily actively processing.

When a toggle changes, `RestartRequiredOverlay` is shown, which calls `restartSession` on confirmation or resets pending state on cancel.

---

## Related Files

| File | Role |
|------|------|
| `ts_sdk/src/services/claude/claudeSessionManager.ts` | Source of truth for this document |
| `ts_sdk/src/services/claude/claudeCliCommand.ts` | CLI command builder |
| `ts_sdk/src/services/claude/claudeSessionEvents.ts` | Event enum |
| `ts_sdk/src/agentic_processor/agentic-process.ts` | `AgenticProcess.startPty()`, `resumePty()`, `killPty()` |
| `ts_sdk/src/agentic_processor/agentic-processor.ts` | `AgenticProcessor.createProcess()` |
| `ts_sdk/src/agentic_processor/agentic-context.ts` | `AgenticContext` DTO and serializer |
| `ts_sdk/src/agentic_processor/agentic-types.ts` | `ProcessorStatus`, `ProcessorState` |
| `ts_sdk/src/services/shell/shellManager.ts` | `ShellManager` — the pattern this mirrors |
| `ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` | Fork and Restart buttons |
| `ui/src/components/terminal/interactive-terminal/RestartRequiredOverlay.tsx` | Restart confirmation overlay |
| `flow_sdk/builtin/agentic_processor.py` | Python backend entity (~1828 lines) |
| `docs/agent-management-spec.md` | Full agent management spec (§8 covers this module) |
| `docs/agentic-process.md` | Deep dive: PTY layers, status derivation, data flow |
