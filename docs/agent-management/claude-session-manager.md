# Claude Process Lifecycle, CLI Options & Restart Contract

> **Naming note.** This file keeps its historical path (`claude-session-manager.md`)
> because several docs deep-link into its sections. The `ClaudeSessionManager`
> service it was once named for **no longer exists** (`ts_sdk/src/services/claude/`
> was removed); everything here documents the live `AgenticProcess` lifecycle,
> the persisted CLI-options model, and the restart-required contract.

There is no manager/facade layer. All lifecycle operations live on
`AgenticProcess` (`ts_sdk/src/process/agentic-process.ts`) and the backend
entity (`flow_sdk/builtin/agentic_process/agentic_process.py`):

| Goal | Current API |
| --- | --- |
| Create an idle process on a compute node | `dataContext.computeNode.createProcess(context, options)` |
| Create a new process with explicit mode control | `AgenticProcess.spawn(options, workerOptions)` |
| Start or reconnect a visible terminal | `process.start(options?)` |
| Resume an existing Claude transcript | `AgenticProcess.fromClaudeSession(sessionId, cwd?)` / `AgenticProcess.open(sessionId)` |
| Continue an existing process turn (headless) | `process.executeInstruction(text, options?)` |
| Stream a print-mode prompt | `process.prompt(text, abortController?)` |
| Restart after CLI option changes | Save `process.cliOptions`, then `process.restart()` |
| Fork | `process.fork(true)` for a visible tab, or `AgenticProcess.spawn({ resumeSessionId, forkSession: true }, ...)` |
| Stop but preserve the process/session | `process.stop()` / `process.exit()` |
| Close/remove a visible process tab | `process.close()` |
| Switch chat/headless ⇄ interactive PTY | `process.switchMode(...)` — see [mode-switching.md](./mode-switching.md) |

---

## Process Creation Flows

### ComputeNode.createProcess

`ComputeNode.createProcess(context, options?)` creates an idle
`AgenticProcess` on the current compute node by POSTing the `createProcess`
action. It serializes `AgenticContext`, forwards optional process-result
metadata and `visible`, updates the entity cache, assigns the local `_context`,
and calls `process.watch()` unless `watchProcess === false`. It does not start
a PTY by itself.

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

### Opening Existing Claude Sessions

| API | Behavior |
| --- | --- |
| `AgenticProcess.open(sessionId)` | Uses `ComputeNode.upsertSessionProcess(sessionId)` and returns the linked process without starting a PTY. |
| `AgenticProcess.fromWorkerSessionId('claude', sessionId)` | Alias for `open(sessionId)`. |
| `AgenticProcess.fromClaudeSession(sessionId, cwd?)` | Resolves the workdir from the Claude session record when needed, then upserts and returns the process. |
| `AgenticProcess.openRecordInTerminal(record)` | Finds or creates a process from a record and calls `start()` so it has an active terminal. |

Navigation code then opens the process dock pointer; the shell route calls
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

`Shell.attachPty()` then delegates to `PtyConnection.attach()`
(`ts_sdk/src/services/shell/ptyConnection.ts`), which owns browser-side
replay, attach deduping, live output gating, input, resize, and WebSocket
reconnect state.

### Headless CLI Lifecycle

Headless runs do not create a `Shell` and do not attach a PTY:

```ts
const { process } = await AgenticProcess.spawn(
  { workdir, resumeSessionId, forkSession: true },
  { headless: true },
);

await process.executeInstruction('Analyze this session', { sync: false });
```

`executeInstruction()` posts the backend `execute` action (a thin wrapper over
`prompt()`). It optimistically adds a user message to the local flow stream,
prevents concurrent worker turns, and optionally waits for completion.

For stream-json print mode, `process.prompt(text)` posts the backend `prompt`
action and streams XML/FlowData into the same frontend `flowDataStream`.

### Stop, Restart, Fork, Close

| API | Current behavior |
| --- | --- |
| `process.stop()` | Calls `exit()`. Stops the current shell session while preserving the process and session history. |
| `process.exit()` | POSTs backend `exit`. Marks the cached shell as closing optimistically. The shell entity is kept for reuse. |
| `process.restart()` | Calls `stop()` when a shell exists, then `start()`, then emits a process-local `restarted` event. |
| `process.fork(visible = false)` | POSTs backend `fork`, registers the returned process, calls `newProcess.start()`, and returns the new process. |
| `process.close()` | Permanent teardown for closing a tab: POSTs backend `close`, then closes the frontend `Shell` if present. |

Plain shell tabs use `Shell.start()` and `Shell.close()` directly.

---

## CLI Options Management

The CLI launch config (model, permission mode, flags, env, add-dirs) lives on
the `AgenticProcess` entity and is finalized into an actual command
**server-side** at launch — the frontend never assembles a `claude …` string.

### Where options are stored

| Field | Location | Meaning |
| --- | --- | --- |
| `cli_config` | `AgenticProcess` entity (frontend accessor in `agentic-process.ts`, backend field) | Serialized `ClaudeCliOptions`/`WorkerCLIOptions`: `model`, `permission_mode`, `chrome`, `debug`, `env_vars`, etc. The persisted worker launch config. |
| `workdir` | entity field | Injected into the CLI options at read time; **not** stored inside `cli_config`. |
| `session_id` | entity field | Injected at read time; drives `--resume`. Not stored in `cli_config`. |
| `additional_dirs` | entity field | Becomes `--add-dir`; injected into `cliOptions.addDirs`. |
| `load_flowpad_assistant` | entity field | Adds the assistant mount to the resolved `--add-dir` set. |
| `embedded_asset_refs` / `embedded_agent_ids` | entity fields | Materialized skills/agents mounted for the worker. |

Frontend read/write is through the `cliOptions` accessor: the getter
deserializes `cli_config` and injects `workdir` + `session_id` +
`additional_dirs`; the setter re-serializes back into `cli_config`. It mirrors
the Python `AgenticProcess.cli_options` property exactly.

### Changing an option

The only supported pattern is **mutate → persist → let the backend recompute**:

```ts
const cli = process.cliOptions;
cli.chrome = true;                       // or cli.permission_mode = 'bypassPermissions'
process.cliOptions = cli;                // re-serializes into cli_config
await process.save();                    // backend save-hook recomputes restart_required
```

This is exactly what the toolbar's `persistCliFlags` does for the Chrome / Full
Trust / Debug toggles (`ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx`).
`additional_dirs` and the assistant mount have dedicated action wrappers
(`process.addDir` / `process.removeDir` / `process.setAssistantEnabled`) but the
effect on restart-required is identical.

Per-turn overrides for **headless / print mode** (e.g. `permissionMode: 'plan'`
passed to `process.prompt(...)`) do not mutate `cli_config` and do not trip
restart-required — they apply only to that turn.

---

## Restart-Required Detection

Restart awareness is entirely **backend-driven** and surfaced as a glowing
toolbar button.

### The flag

`AgenticProcess.restart_required: boolean` means: *a worker-relevant field
changed since the last successful start while the worker is RUNNING, so the
live worker is running with stale config.*

### How it flips

The backend maintains it in the `AgenticProcess.save()` override
(`flow_sdk/builtin/agentic_process/agentic_process.py`):

1. On every `save()`, if the process is `RUNNING`, `last_started_hash` is set,
   and the current worker snapshot hash **differs** from it, set
   `restart_required = True`.
2. The hook only ever flips it **ON**. It is cleared **only** on a successful
   `start_pty()`, which captures a fresh `last_started_snapshot` +
   `last_started_hash` and resets the flag.
3. Skipped while `start_pty()` itself is mutating the entity
   (`_set_start_lifecycle`) so intermediate bookkeeping saves (status,
   session_id) don't self-trip.

### What counts as "worker-relevant"

The snapshot (`_restart_snapshot_payload`) is a `{generic, worker}` pair,
MD5-hashed:

- **generic** (`_generic_restart_snapshot_payload`): `worker_type`,
  `shell_mode`, `workdir`, `session_id`, `additional_dirs`,
  `embedded_asset_refs`, `embedded_agent_ids`.
- **worker** (driver `restart_snapshot`): the finalized `WorkerCLIOptions` JSON —
  `model`, `permission_mode`, `chrome`, `debug`, `env_vars`, etc.

**Deliberately excluded** (`restart_payload_from_cli_options`,
`cli_worker_base_driver.py`): `resume`, `fork_session_id`, and the
`FLOWPAD_EXECUTION_SCOPE` env var. These are derived/transient — they flip as a
side effect of the worker writing its first transcript line or of a fork
materializing, and hashing them would light up a phantom restart glow on fresh
processes.

### Debug surface

`process` exposes a read-only `restart-info` action returning
`{restart_required, running, worker_type, loaded, current, changed}` — a
per-field diff between the live worker's launch payload and the current entity
snapshot. It powers the "Command Status" viewer (`CommandStatusViewer.tsx`).

---

## Restart Flow (end-to-end)

### User-initiated (toolbar)

```
toggle CLI flag → process.save() → backend save-hook flips restart_required
  → toolbar Restart button glows (ProcessToolbar.tsx, data-restart-required)
  → user clicks → process.restart()
       → process.stop()  (→ exit → backend kills worker+PTY, keeps shell entity)
       → process.start() (→ backend `open`/start_pty rebuilds the command from
                            the persisted cli_config + workdir + session_id,
                            resumes via --resume, attaches the PTY)
       → captures fresh last_started_hash, clears restart_required
       → emits local 'restarted' → InteractiveTerminal clears + re-attaches
```

The rebuilt command is authored **entirely server-side** in the `open` action.
`start()` is the single oracle for reattach-vs-recover-vs-fresh.

### Server-initiated (`self-restart`)

When the agent itself runs `flow process restart` (e.g. after installing an MCP),
it calls the backend `self-restart` action. Because the calling CLI is a
**child** of the worker about to be killed, the restart cannot run inline — it
is scheduled on the server loop after a short grace, returns
`{"scheduled": true}` immediately, and once the fresh PTY is up emits a
**`worker.restarted`** entity event over the WS watcher channel. The frontend
bridges that event back to the same `'restarted'` terminal re-attach path via
`AgenticProcess.onEntityEvent`.

### Mode switch is a distinct path

Flipping between the interactive PTY and headless/CLI transport is
`process.switchMode(...)`, not `restart()`. It is documented with the
headless⇄PTY toggle design in [mode-switching.md](./mode-switching.md).

---

## Per-CLI Differences (claude / codex / copilot)

Restart-required detection is **uniform** across drivers: all three
(`cli_drivers/{claude,codex,copilot}/driver.py`) implement `restart_snapshot`
identically as `restart_payload_from_cli_options(options)`, so any option change
trips the same flag.

The vendor-specific part is **whether a restart resumes** the prior transcript,
decided by each driver's `has_resumable_session`:

| Driver | Resumable check | Plan mode |
| --- | --- | --- |
| claude | `get_claude_session(session_id)` present | yes |
| codex | `find_codex_session_jsonl(session_id)` present | no |
| copilot | `_has_session(process)` | no |

If the vendor has no resumable transcript for the process's `session_id`, restart
recovery relaunches fresh instead of resuming.

---

## Session And PTY IDs

| Field | Owner | Meaning |
| --- | --- | --- |
| `AgenticProcess.session_id` | Claude process | Claude CLI session/transcript ID. Used for resume/history. |
| `AgenticProcess.shell_id` | Claude process | Linked `Shell` entity ID for interactive mode. |
| `Shell.pty_pid` | Shell | Backend PTY handle returned by shell/process `open`. |
| `PtyConnection` attached PTY ID | Browser PTY client | The PTY handle this browser client is currently attached to. |

`workerSessionId` still appears in `AgenticProcess.spawn()` /
`executeInstruction()` options for headless execution compatibility, but the
persisted Claude session ID on the process is `session_id`.
