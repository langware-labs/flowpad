# ClaudeSessionManager

Small singleton convenience service for creating a new Claude `AgenticProcess`
and opening it in an interactive PTY.

Located at `ts_sdk/src/services/claude/claudeSessionManager.ts`.

---

## Current Status

`ClaudeSessionManager` is **not** the process lifecycle API. The current
service exposes one operational method:

```ts
async createAndStartSession(
  context: AgenticContext,
  options?: { instruction?: string },
): Promise<AgenticProcess>
```

It also exposes the singleton helpers inherited from the current implementation:

| API | Purpose |
| --- | --- |
| `ClaudeSessionManager.getInstance()` | Returns the singleton instance. |
| `ClaudeSessionManager.resetInstance()` | Test helper: removes listeners, clears the singleton, and deletes `window.claudeSessionManager`. |
| `claudeSessionManager` | Module-level singleton created by `getInstance()`. |

The manager extends `EventEmitter`, but the current implementation does not emit
session lifecycle events.

Do not document or call these older manager APIs:

| Non-existent manager API | Current owner |
| --- | --- |
| `startSession(process, options?)` | `AgenticProcess.start(options?)` |
| `resumeSession(process)` | `AgenticProcess.fromClaudeSession(...)`, `AgenticProcess.open(...)`, or `AgenticProcess.spawn({ resumeSessionId })` |
| `restartSession(process)` | `AgenticProcess.restart()` |
| `forkSession(process)` | `AgenticProcess.fork(visible?)` or `AgenticProcess.spawn({ resumeSessionId, forkSession: true }, ...)` |
| `killSession(process)` | `AgenticProcess.stop()`, `AgenticProcess.exit()`, `AgenticProcess.close()`, or `Shell.close()` depending on intent |

---

## What The Manager Does

`createAndStartSession` is a narrow UI-oriented helper:

1. Lazily imports `dataContext`.
2. Reads `dataContext.computeNode`.
3. Throws if no compute node is available.
4. Calls `computeNode.createProcess(context)`.
5. Calls `process.start(options)`.
6. Returns the started `AgenticProcess`.

Example:

```ts
import { claudeSessionManager } from '@sdk';

const process = await claudeSessionManager.createAndStartSession(
  { workdir: '/repo' },
  { instruction: 'Summarize this project' },
);

navigation.openShellProcess(process.id);
```

The manager does not:

| Responsibility | Actual owner |
| --- | --- |
| Build the Claude CLI command | `AgenticProcess.spawn()` creates `ClaudeCliOptions`; backend `open`/`execute` actions finalize execution. |
| Attach a browser terminal to a PTY | `AgenticProcess.start()` loads a `Shell`; `Shell.attachPty()` delegates to `PtyConnection.attach()`. |
| Resume an existing transcript | `AgenticProcess.fromClaudeSession()`, `AgenticProcess.open()`, or `AgenticProcess.spawn({ resumeSessionId })`. |
| Restart a visible process | `AgenticProcess.restart()`. |
| Fork a process | `AgenticProcess.fork()` or `AgenticProcess.spawn(... forkSession: true ...)`. |
| Kill/close a process | `AgenticProcess.stop()`, `exit()`, `close()`, or `Shell.close()`. |
| Maintain frontend PTY session cache | `ComputeNode` for machine sessions; `Shell`/`PtyConnection` for active shell connections. |

---

## Related Files

| File | Current role |
| --- | --- |
| `ts_sdk/src/services/claude/claudeSessionManager.ts` | Singleton helper with `createAndStartSession`. |
| `ts_sdk/src/services/claude/claudeSessionEvents.ts` | Exports a `ClaudeSessionEvent` enum, but the current manager does not emit these events. |
| `ts_sdk/src/entities/compute-node/compute-node.ts` | Creates/upserts `AgenticProcess` entities and maintains frontend-only shell session cache. |
| `ts_sdk/src/process/agentic-process.ts` | Main Claude process lifecycle API: spawn, start, execute, prompt, fork, stop, restart, close. |
| `ts_sdk/src/entities/shell.ts` | Plain shell entity and PTY attach/start/close facade. |
| `ts_sdk/src/services/shell/ptyConnection.ts` | Browser-side PTY attach, replay, input, resize, and reconnect state. |

---

## Process Creation Flows

### Manager Convenience Flow

Use this when the UI needs a new interactive Claude process from a context and
an optional initial instruction:

```ts
const process = await claudeSessionManager.createAndStartSession(
  { workdir, model, permissionMode },
  { instruction },
);
```

Flow:

```text
claudeSessionManager.createAndStartSession
  -> dataContext.computeNode
  -> ComputeNode.createProcess(context)
  -> AgenticProcess.start({ instruction })
  -> backend agentic_process/open
  -> Shell entity returned/updated
  -> Shell.attachPty()
  -> PtyConnection.attach()
```

This is the flow used by `ui/src/pages/home-landing/HomeLanding.tsx`.

### ComputeNode.createProcess

`ComputeNode.createProcess(context, options?)` creates an idle
`AgenticProcess` on the current compute node by POSTing the `createProcess`
action. It serializes `AgenticContext`, forwards optional process-result
metadata and `visible`, updates the entity cache, assigns the local `_context`,
and calls `process.watch()` unless `watchProcess === false`.

It does not start a PTY by itself.

### AgenticProcess.spawn

`AgenticProcess.spawn(options, workerOptions?)` is the richer process creation
entry point. It builds `ClaudeCliOptions`, saves a new `AgenticProcess`, then
chooses activation mode:

| Mode | Trigger | Behavior |
| --- | --- | --- |
| PTY/interactive | `workerOptions?.headless` is false or omitted | Calls `process.start({ instruction, ptyTimeout })`, returns `{ process, shell, workerSessionId: process.session_id }`. |
| Headless/CLI | `workerOptions.headless === true` | Calls `process.watch()`, optionally calls `process.executeInstruction(...)`, returns `{ process, workerSessionId }` without creating or attaching a `Shell`. |

`workerOptions.headless` is the branch that decides whether `spawn()` avoids a
PTY. `workerOptions.visible` is persisted on the process and is used by
UI/status helpers: `agentic-types.ts` derives `Interactive` when `visible` is
truthy and `CLI` otherwise. For a visible terminal tab, pass `{ visible: true }`
and leave `headless` unset.

### AgenticProcess.execute

`AgenticProcess.execute(command, options?)` is a simple one-shot helper. It uses
the active compute node, creates a process, watches it, wraps plain text in AMD
`flow-do` syntax, and calls `executeInstruction(..., { sync: false })`.

### Opening Existing Claude Sessions

Existing Claude CLI sessions are opened through `AgenticProcess`, not
`ClaudeSessionManager`:

| API | Behavior |
| --- | --- |
| `AgenticProcess.open(sessionId)` | Uses `ComputeNode.upsertSessionProcess(sessionId)` and returns the linked process without starting a PTY. |
| `AgenticProcess.fromWorkerSessionId('claude', sessionId)` | Alias for `open(sessionId)`. |
| `AgenticProcess.fromClaudeSession(sessionId, cwd?)` | Resolves the workdir from the Claude session record when needed, then upserts and returns the process. |
| `AgenticProcess.openRecordInTerminal(record)` | Finds or creates a process from a record and calls `start()` so it has an active terminal. |

Navigation code can then open the process dock pointer; the shell route calls
`process.start()` as needed to connect or reconnect the PTY.

---

## Lifecycle Ownership

### Interactive PTY Lifecycle

`AgenticProcess.start(options?)` is the main interactive lifecycle method. It:

1. Rejects if the process is stopping.
2. Fast-paths when the process is already running and the cached shell is
   attached to the current PTY.
3. POSTs the backend `agentic_process/open` action.
4. Updates `status`, `shell_id`, and `session_id` from the response.
5. Registers/updates the returned `Shell` entity.
6. Copies the backend PTY ID to `shell.pty_pid`.
7. Calls `shell.attachPty({ ptyId, cols: 80, rows: 24, timeout })`.

`Shell.attachPty()` then delegates to `PtyConnection.attach()`, which owns
browser-side replay, attach deduping, live output gating, input, resize, and
WebSocket reconnect state.

### Headless CLI Lifecycle

Headless runs do not create a `Shell` and do not attach a PTY. They use:

```ts
const { process } = await AgenticProcess.spawn(
  { workdir, resumeSessionId, forkSession: true },
  { headless: true },
);

await process.executeInstruction('Analyze this session', { sync: false });
```

`executeInstruction()` posts the backend `execute` action. It optimistically
adds a user message to the local flow stream, prevents concurrent worker turns,
and optionally waits for completion.

For stream-json print mode, `process.prompt(text)` posts the backend `prompt`
action and streams XML/FlowData into the same frontend `flowDataStream`.

### Stop, Restart, Fork, Close

These operations live on `AgenticProcess`:

| API | Current behavior |
| --- | --- |
| `process.stop()` | Calls `exit()`. Stops the current shell session while preserving the process and session history. |
| `process.exit()` | POSTs backend `exit`. Marks the cached shell as closing optimistically. The shell entity is kept for reuse. |
| `process.restart()` | Calls `stop()` when a shell exists, then `start()`, then emits a process-local `restarted` event. |
| `process.fork(visible = false)` | POSTs backend `fork`, registers the returned process, calls `newProcess.start()`, and returns the new process. |
| `process.close()` | Permanent teardown for closing a tab: POSTs backend `close`, then closes the frontend `Shell` if present. |

Plain shell tabs use `Shell.start()` and `Shell.close()` directly.

---

## Session And PTY IDs

Current TypeScript uses these fields:

| Field | Owner | Meaning |
| --- | --- | --- |
| `AgenticProcess.session_id` | Claude process | Claude CLI session/transcript ID. Used for resume/history. |
| `AgenticProcess.shell_id` | Claude process | Linked `Shell` entity ID for interactive mode. |
| `Shell.pty_pid` | Shell | Backend PTY handle returned by shell/process `open`. |
| `PtyConnection` attached PTY ID | Browser PTY client | The PTY handle this browser client is currently attached to. |

Older docs may refer to `worker_session_id` and `pty_pid` as fields returned by
manager methods. The current `ClaudeSessionManager` has no such result type.
`workerSessionId` still appears in `AgenticProcess.spawn()`/`executeInstruction()`
options for headless execution compatibility, but the persisted Claude session
ID on the process is `session_id`.

---

## Events

Although `ClaudeSessionManager` extends `EventEmitter`, the current manager
does not call `emit()`.

`ts_sdk/src/services/claude/claudeSessionEvents.ts` still exports:

```ts
export enum ClaudeSessionEvent {
  SESSION_STARTED = 'session_started',
  SESSION_RESUMED = 'session_resumed',
  SESSION_RESTARTED = 'session_restarted',
  SESSION_FORKED = 'session_forked',
  SESSION_KILLED = 'session_killed',
  SESSION_ERROR = 'session_error',
}
```

Those enum values are not currently wired to the manager. For current lifecycle
updates, rely on `AgenticProcess` entity updates, `Shell`/`PtyConnection`
status, and the process-local `restarted` event from `process.restart()`.

---

## Practical API Map

Use these APIs for new code:

| Goal | Current API |
| --- | --- |
| Create a new interactive Claude session from landing UI | `claudeSessionManager.createAndStartSession(context, { instruction })` |
| Create a new process with explicit mode control | `AgenticProcess.spawn(options, workerOptions)` |
| Create an idle process on a compute node | `dataContext.computeNode.createProcess(context, options)` |
| Start or reconnect a visible terminal | `process.start(options?)` |
| Resume an existing Claude transcript in Flowpad | `AgenticProcess.fromClaudeSession(sessionId, cwd?)` |
| Continue an existing process turn | `process.executeInstruction(text, options?)` |
| Stream a print-mode prompt | `process.prompt(text, abortController?)` |
| Restart after CLI option changes | Save `process.cliOptions`, then `process.restart()` |
| Fork from an existing process | `process.fork(true)` for a visible tab, or `AgenticProcess.spawn({ resumeSessionId, forkSession: true }, ...)` for programmatic/headless work |
| Stop but preserve the process/session | `process.stop()` or `process.exit()` |
| Close/remove a visible process tab | `process.close()` |

---

## Notes For Maintainers

- Keep this document aligned with `claudeSessionManager.ts`; it currently
  documents a small facade, not a lifecycle coordinator.
- Do not reintroduce manager-level start/resume/restart/fork/kill docs unless
  those methods are restored in the TypeScript source.
- If `ClaudeSessionEvent` becomes wired again, document the exact emitter,
  payloads, and call sites at that time.
