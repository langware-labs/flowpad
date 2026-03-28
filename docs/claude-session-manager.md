# ClaudeSessionManager

Singleton SDK service for Claude session lifecycle management.
Located at `ts_sdk/src/services/claude/`.

---

## Overview

`ClaudeSessionManager` is the canonical coordinator for all Claude PTY session operations — start, resume, restart, fork, and kill. It mirrors the `ShellManager` pattern but is focused on `AgenticProcess` entities rather than raw shell sessions.

It is usable anywhere: UI components, scripts, or SDK consumers.

---

## Files

| File | Purpose |
|------|---------|
| `claudeSessionManager.ts` | Singleton class + exported instance |
| `claudeCliCommand.ts` | Typed CLI command — parse / modify / generate |
| `claudeSessionEvents.ts` | Event enum |
| `index.ts` | Module exports |

---

## ClaudeSessionManager

```ts
import { claudeSessionManager } from '@sdk';
```

### Methods

#### `startSession(process, options?)`
Start a brand-new Claude session (new `worker_session_id`).

```ts
await claudeSessionManager.startSession(process, { instruction: 'Hello' });
```

#### `resumeSession(process)`
Resume an existing session in a new PTY (`claude --resume`, same `worker_session_id`).

```ts
await claudeSessionManager.resumeSession(process);
```

#### `restartSession(process)`
Kill the current PTY then resume — the canonical "restart".
Use this after saving updated `context_data` so the new PTY picks up the latest flags.

```ts
process.context_data = { ...process.context_data, chrome: true };
await process.save();
await claudeSessionManager.restartSession(process);
```

Internally:
1. If `process.pty_pid` is set → `process.killPty()`
2. `process.resumePty()`
3. Emits `SESSION_RESTARTED`

#### `forkSession(process)`
Create a sibling `AgenticProcess` with the same `context_data`, then start a fresh PTY (new `worker_session_id`). Does **not** copy JSONL session history.

```ts
const newProcess = await claudeSessionManager.forkSession(process);
navigation.openShellProcess(newProcess.id);
```

Internally:
1. Reads `context_data` → builds `AgenticContext`
2. Looks up `AgenticProcessor` via `process.processor_id`
3. `processor.createProcess(context)` → new entity
4. `newProcess.startPty()`
5. Emits `SESSION_FORKED`

#### `killSession(process)`
Kill PTY only. Preserves `worker_session_id` for a future resume.

```ts
await claudeSessionManager.killSession(process);
```

---

## ClaudeCliCommand

Typed representation of a `claude …` CLI invocation. Replaces ad-hoc string concatenation.

```ts
import { ClaudeCliCommand } from '@sdk';
```

### Factory methods

```ts
// From an AgenticProcess entity
const cmd = ClaudeCliCommand.fromProcess(process);
// → reads worker_session_id, context_data.model, permission_mode, chrome, workdir

// From an AgenticContext DTO
const cmd = ClaudeCliCommand.fromContext(ctx, sessionId, resume: true);

// Parse an existing shell string
const cmd = ClaudeCliCommand.parse('cd /foo && claude --chrome --session-id abc');
```

### Generation

```ts
cmd.toString();  // "cd /foo && claude --chrome --session-id abc"
cmd.toArgs();    // ['--chrome', '--session-id', 'abc']
```

### Immutable update

```ts
const forked = cmd.with({ sessionId: undefined, resume: newId });
```

---

## ClaudeSessionEvent

```ts
import { ClaudeSessionEvent } from '@sdk';

claudeSessionManager.on(ClaudeSessionEvent.SESSION_RESTARTED, ({ process }) => {
  console.log('Restarted:', process.id);
});
```

| Event | Payload |
|-------|---------|
| `SESSION_STARTED` | `{ process, result }` |
| `SESSION_RESUMED` | `{ process, result }` |
| `SESSION_RESTARTED` | `{ process, result }` |
| `SESSION_FORKED` | `{ sourceProcess, newProcess }` |
| `SESSION_KILLED` | `{ process }` |
| `SESSION_ERROR` | `{ process, error }` |

---

## ProcessToolbar integration

`ProcessToolbar.tsx` uses `claudeSessionManager` for its Fork and Restart buttons:

```tsx
// Fork — creates sibling process, navigates to it
const newProcess = await claudeSessionManager.forkSession(process);
navigation.openShellProcess(newProcess.id);

// Restart — used by RestartRequiredOverlay after saving context_data
await claudeSessionManager.restartSession(process);
```

### Toggle availability

Flag toggles (Chrome, Full Trust) are enabled whenever `process.worker_session_id` is set, regardless of `state.status`. For PTY-based processes, `status: 'running'` is the expected state while the PTY is alive (including when Claude is idle at the prompt) — it does not mean Claude is actively processing.

When flags change, `RestartRequiredOverlay` appears and calls `restartSession` on confirm.

---

## Shell Session Elevation

The `elevate-shell-session` action promotes a running plain shell tab into a Claude session by creating an `AgenticProcess` bound to the existing shell and calling `open()` on it.

### elevate-shell-session Flow

1. Frontend calls `POST /api/v1/graph/compute_node/{id}/elevate-shell-session` with `{shell_id, model?, permission_mode?, resume_session_id?}`
2. Backend creates an `AgenticProcess` with `shell_id` pre-set and `ClaudeCliOptions` built from the request params
3. Calls `AgenticProcess.open()` — detects the PTY is already alive, worker is not running, and injects the `claude` CLI command into the existing terminal
4. `open()` writes `agentic_process_id` back to the `ShellRecord` so the shell knows its owning process
5. Returns standard `AgenticProcess.open()` response: `{id, status, shell_id, worker_session_id, ...}`

`ShellStatus` has three values: `IDLE`, `RUNNING`, `CLOSED`. There is no `ELEVATED` state — a shell with `agentic_process_id` set on its `ShellRecord` is considered owned by a process.

---

## Related

- `AgenticProcess.startPty()` — `ts_sdk/src/agentic_processor/agentic-process.ts`
- `AgenticProcess.resumePty()` — same file
- `AgenticProcess.killPty()` — same file
- `AgenticProcessor.createProcess()` — `ts_sdk/src/agentic_processor/agentic-processor.ts`
- `ShellManager` pattern — `ts_sdk/src/services/shell/shellManager.ts`
