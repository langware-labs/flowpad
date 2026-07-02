---
id: 9c2406fc-f5c9-5f32-8932-f6d36f8fa3f9
---

# AgenticProcess

`AgenticProcess` is the backend/frontend entity that represents one worker-backed agent session. It is implemented in `flow_sdk/builtin/agentic_process/agentic_process.py` and exposed in TypeScript from `ts_sdk/src/process/agentic-process.ts`.

The current implementation is not an `AgenticProcessor` child model. Processes are created from a `ComputeNode` action or directly as entities, and worker-specific behavior is delegated to `WorkerDriver` implementations under `flow_sdk/builtin/agentic_process/cli_drivers/`.

### Two independent axes: transport vs visibility

A process is described by **two orthogonal booleans**, not one mode selector. Older text in this file (and some field docstrings) treated `visible` as *the* mode selector and said "routing stays `headless == !visible`" — that is stale. The **transport** the worker runs over is chosen by `pty_mode`; `visible` only answers "is this shown as a terminal tab." Every execution router in the code keys on `pty_mode`, never on `visible` (`agentic_process.py:1824`, `:2210`, `:1843`, `:3843`; `load-process.ts:199`; `InteractiveTerminal.tsx:166`).

| Axis                     | Field       | `true`                                                     | `false`                                                                 |
| ------------------------ | ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Transport** (worker)   | `pty_mode`  | Interactive PTY: long-lived worker in a `Shell`-owned PTY  | Headless JSON-stream: `-p --output-format stream-json`, one subprocess per turn, no `Shell`/PTY |
| **Visibility** (UI)      | `visible`   | Shown as a terminal tab / loader attaches an xterm         | Not attached as a terminal tab (chat surface, or backgrounded)         |

In this codebase **"headless" is a synonym for `pty_mode === false`** (the JSON-stream transport). It is *not* a separate axis from `pty_mode` — it is the name for one pole of it. The genuine orthogonality is `pty_mode` (transport) ⟂ `visible` (tab shown), enforced deliberately: `set-visible` (`agentic_process.py:1783`) flips the tab without ever touching transport, and `prompt()`'s docstring is explicit that routing is "on the transport intent `pty_mode` (NOT tab-visibility)".

**Reachable quadrants** (the two axes are seeded in lock-step at launch, so the diagonal is the common case, but they can be pulled apart):

| `visible` | `pty_mode` | State                                                                                       |
| --------- | ---------- | ------------------------------------------------------------------------------------------- |
| `true`    | `true`     | Interactive PTY terminal tab (normal terminal).                                             |
| `false`   | `true`     | Backgrounded/hidden PTY — worker still alive, no tab. Dead-PTY detection still applies (`agentic_process.py:3840`). |
| `false`   | `false`    | Headless JSON-stream (server-side automation, or a chat tab whose strip membership is the `Tab` entity). |
| `true`    | `false`    | Not produced by any launch path — `_perform_open` forces `pty_mode=True` whenever `visible=True` (`agentic_process.py:991`). Only constructible by calling `set-visible` on an already-headless process. |

The asymmetry is deliberate: `visible=True ⟹ pty_mode=True` is enforced (you cannot show an interactive terminal with no PTY), but `visible=False` does **not** imply headless (a PTY session can be hidden). Note also that `visible` is no longer the tab-strip membership flag — the `Tab` entity owns that (see `docs/tab-management.md`); `visible` now only gates the PTY/xterm runtime.

`session_id` is the persistent conversation/session identifier. `status` is the stored process lifecycle. `worker_status` is a computed projection from the worker transcript.

***

## Table of Contents

1. [Current Entity Model](#current-entity-model)
2. [The Two Transports](#the-two-transports)
3. [Lifecycle and Status](#lifecycle-and-status)
4. [Configuration](#configuration)
5. [Backend API](#backend-api)
6. [TypeScript API](#typescript-api)
7. [Stale Names](#stale-names)
8. [Key Files Reference](#key-files-reference)

> **Related docs (owned elsewhere — cross-referenced, not duplicated here):**
> `visible` / tab-strip membership and the `Tab` entity → `docs/tab-management.md`.
> PTY lifecycle, replay buffer, and attach → `docs/pty-terminal-spec.md`, `docs/agent-management/pty-websocket.md`.
> The chat⇄terminal mode-switch UX → `switch-mode` action below and `docs/agent-management/claude-session-manager.md`.
> This doc is the reference for the **transport axis (`pty_mode`) and its relation to `visible`/headless**.

***

## Current Entity Model

### Backend Fields

`AgenticProcess` is a SQLite/API entity. Important fields are:

| Field                                                          | Type                   | Description                                                                                                                  |
| -------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `status`                                                       | `ProcessStatus` string | Stored container lifecycle: `new`, `starting`, `running`, `stopping`, `stopped`, `failed`.                                   |
| `worker_status`                                                | `WorkerStatus` string  | Computed on serialization from the worker transcript; not stored as an entity field.                                         |
| `ready_for_input`                                              | `bool`                 | Computed on serialization by `is_ready_for_input()`.                                                                         |
| `session_id`                                                   | `str \| None`          | Persistent worker session/conversation ID. For Claude this is the Claude session UUID and JSONL transcript ID.               |
| `pty_mode`                                                     | `bool`                 | **Transport intent** (persisted, default `true`). `true` → interactive PTY; `false` → headless JSON-stream. This — not `visible` — is what every execution router keys on. Seeds `visible` at launch and is kept durable across reload so a chat vs terminal choice survives. |
| `visible`                                                      | `bool`                 | **Tab-visibility only** (default `false`). Whether the loader attaches a PTY/xterm. Decoupled from transport via `set-visible`; does not route prompts. No longer the tab-strip membership flag (that is the `Tab` entity).                        |
| `shell_id`                                                     | `str \| None`          | Linked `Shell` entity ID for visible PTY mode. `None` in headless print mode.                                                |
| `sidecar_shell_id`                                             | `str \| None`          | Optional sidecar shell link; cleared on process exit/close paths.                                                            |
| `cli_config`                                                   | `dict`                 | Serialized worker CLI options. Built by the frontend or `ComputeNode.createProcess`; deserialized through the driver.        |
| `workdir`                                                      | `str \| None`          | Working directory for the worker. Also used to set Claude `CLAUDE_PROJECT_DIR`.                                              |
| `context_data`                                                 | `dict`                 | Extra persisted context such as `instructions`, `project_id`, `max_thinking_tokens`, resume bookkeeping, and internal flags. |
| `instruction_content`                                          | `str \| None`          | Stored prompt/instruction content when supplied by callers.                                                                  |
| `asset_ref`                                                    | `str \| None`          | Source asset reference when the process is attached to a file-backed record.                                                 |
| `favorite_index`                                               | `int \| None`          | Optional UI ordering/pin value.                                                                                              |
| `use_worker_history`                                           | `bool`                 | Whether history should be loaded from the worker transcript.                                                                 |
| `shell_mode`                                                   | `bool`                 | `false` by default: direct PTY spawn. `true`: legacy shell intermediary path.                                                |
| `project_id`                                                   | `str \| None`          | Owning project. Resolved from context, ancestry, or `@local`.                                                                |
| `project_encoded_name`                                         | `str \| None`          | Encoded project name used for transcript navigation.                                                                         |
| `collaboration_room_id`                                        | `str \| None`          | Collaboration room this process belongs to, if any.                                                                          |
| `target_typeid_str`                                            | `str \| None`          | Serialized TypeId of the entity this process is attached to.                                                                 |
| `exe_folder`, `input_folder`, `output_folder`, `assets_folder` | `FSRef \| None`        | Per-process execution folders under the process record directory.                                                            |
| `additional_dirs`                                              | `list[str]`            | Extra directories exposed to the worker, passed as `--add-dir` where supported.                                              |
| `embedded_agent_ids`                                           | `list[str]`            | Names of embedded agents loaded into the process.                                                                            |
| `embedded_asset_refs`                                          | `list[TypeId]`         | Agent/skill refs materialized under the process assets folder.                                                               |
| `worker_type`                                                  | `WorkerType \| None`   | Optional worker selector. `None` resolves via `FLOWPAD_DEFAULT_WORKER`, defaulting to `claude`.                              |

### Related Shell Fields

PTY state belongs to `Shell`, not `AgenticProcess`.

| Shell field                                    | Description                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `Shell.id`                                     | Shell session ID. In practice this is also the PTY session key.  |
| `Shell.pty_pid`                                | PTY session ID owned by the shell. Set by `Shell.start()`.       |
| `Shell.worker_pid`                             | OS PID of the worker process, used for liveness and termination. |
| `Shell.worker_name`                            | Worker executable name such as `claude`.                         |
| `Shell.last_launch_cmd`                        | Serialized CLI options from the last launch.                     |
| `Shell.compute_node_id` / `compute_node_uname` | Compute node hosting the PTY.                                    |

There is no process-level `pty_pid` in the current `AgenticProcess` entity.

### Driver Layer

`AgenticProcess.driver` resolves a `WorkerDriver` through `get_driver(worker_type)` from `flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py`.

Drivers own:

| Driver method                              | Purpose                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `cli_options(process)`                     | Build worker-specific CLI options from the process. |
| `headless_prompt(process, instruction)`     | Run one headless turn.                              |
| `transcript_path(process)`                 | Locate this process's transcript/event log.         |
| `tail_status(path)`                        | Map transcript tail to `WorkerStatus`.              |
| `load_history(process)`                    | Convert transcript history into `FlowData`.         |
| `compose_prompt(instruction, agents_json)` | Inline embedded agent specs when needed.            |

Current drivers:

| Driver | Files                 | Runtime                                                                        |
| ------ | --------------------- | ------------------------------------------------------------------------------ |
| Claude | `cli_drivers/claude/` | Interactive `claude` PTY and headless `claude -p --output-format stream-json`. |
| Codex  | `cli_drivers/codex/`  | Headless `codex exec --json --ephemeral` with a process-local transcript.      |

***

## The Two Transports

The rest of this section describes the two ends of the `pty_mode` axis. Where the columns below say a transport is "selected by `visible=…`" that is shorthand for the common lock-stepped case — the authoritative selector is `pty_mode`.

### CLI / Headless Print Mode (`pty_mode=false`)

Headless print mode is selected by `pty_mode=false` (in the default lock-stepped launch it coincides with `visible=false`).

Characteristics:

| Aspect             | Current behavior                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTY                | None. No `Shell` is required.                                                                                                                         |
| Worker lifetime    | One subprocess per prompt turn.                                                                                                                       |
| Output             | Worker events are converted to `FlowData`.                                                                                                            |
| Session continuity | `session_id` is persisted on the process and reused by later turns where supported.                                                                   |
| Status             | `status` usually remains `running` after a successful turn so the process can accept another prompt; `worker_status` is derived from transcript tail. |
| Concurrency        | One in-flight prompt per process, guarded by `_PROMPT_LOCKS`.                                                                                         |
| Cancel             | `cancel-prompt` terminates the in-flight print-mode worker.                                                                                           |

Backend routing:

```text
POST /api/v1/graph/agentic_process/<id>/execute
  -> AgenticProcess._http_execute()
  -> AgenticProcess.prompt()
  -> pty_mode is false        # NOT `visible` — see prompt() docstring, agentic_process.py:1806
  -> process.driver.headless_prompt(process, instruction)
```

There is also a streaming HTTP prompt action:

```text
POST /api/v1/graph/agentic_process/<id>/prompt
  body: { "message": "..." }
  -> print-mode path routes on pty_mode=false (agentic_process.py:2210)
  -> streams FlowData XML over text/event-stream
```

In TypeScript this is exposed as:

```ts
await process.prompt('Implement the change');
await process.cancelPrompt();
```

`AgenticProcess.spawn(..., { headless: true })` creates a process, watches it, and optionally calls `executeInstruction()`:

```ts
const { process } = await AgenticProcess.spawn(
  {
    workdir: '/path/to/project',
    permissionMode: 'bypassPermissions',
    outputFormat: 'stream-json',
  },
  {
    headless: true,
    instruction: 'Summarize this project',
    sync: false,
  },
);
```

Claude print mode uses `ClaudeCLIStreamWorker`:

```text
claude -p --output-format stream-json --verbose [--session-id <session_id> | --resume <session_id>] ...
```

Codex print mode uses `CodexCLIStreamWorker`:

```text
codex exec --json --ephemeral --skip-git-repo-check ...
```

### PTY Interactive Mode (`pty_mode=true`)

Interactive mode is the `pty_mode=true` transport, opened through `AgenticProcess.start()` / the backend `open` action. Opening a PTY sets `visible=true`, and `_perform_open` then forces `pty_mode=true` in the same tail (`agentic_process.py:991`) — this is the one enforced coupling between the axes (`visible=true ⟹ pty_mode=true`). A `pty_mode=true` process can still be hidden (`visible=false`) via `set-visible`; its worker stays alive and dead-PTY detection still runs.
For UI terminal tabs, callers should set `visible=true`; `start()` is the PTY-open action and can also accept a `visible` override in the backend `open` body.

Characteristics:

| Aspect             | Current behavior                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| PTY                | Owned by a linked `Shell` entity.                                                                         |
| Worker lifetime    | Long-lived process in the PTY until exit/close/restart or worker death.                                   |
| UI                 | xterm attaches to the `Shell` PTY connection.                                                             |
| Session continuity | `session_id` is generated before launch if missing and passed to the worker.                              |
| Resume             | `start()` reuses live PTYs and can relaunch with resume semantics after stale shell/server restart cases. |
| Direct spawn       | Default `shell_mode=false`: worker is the PTY process.                                                    |
| Legacy spawn       | `shell_mode=true`: open shell first, then inject CLI command through `Shell.launch()`.                    |

Backend routing:

```text
POST /api/v1/graph/agentic_process/<id>/open
  body: { instruction?, visible?, session_id? }
  -> AgenticProcess.start()
  -> create/reuse Shell
  -> Shell.start(spawn_args=..., extra_env=...)
  -> Shell.attachPty() from frontend
```

TypeScript:

```ts
const { process, shell } = await AgenticProcess.spawn(
  {
    workdir: '/path/to/project',
    permissionMode: 'bypassPermissions',
    model: 'claude-sonnet-4-20250514',
  },
  {
    visible: true,
    instruction: 'Inspect the repository',
  },
);

await process.start();      // idempotent open/reopen
await process.sendInput('/help');
await process.exit();       // stop worker + PTY, keep Shell entity
await process.restart();    // exit() + start()
await process.close();      // permanent teardown: delete linked Shell
```

`start()` returns data containing `shell_id`, `pty_id`, `session_id`, `worker_pid`, and serialized shell data. The frontend then loads the shell and attaches to `pty_id`.

`exit()` and `close()` are different:

| Method              | Backend action | Result                                                                                 |
| ------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `exit()` / `stop()` | `exit`         | Terminates worker and PTY but preserves the `Shell` entity and `session_id`.           |
| `restart()`         | `restart`      | Calls `exit()` then `start()`.                                                         |
| `close()`           | `close`        | Kills worker/PTY, deletes the linked `Shell`, clears shell links, sets status stopped. |

***

## Lifecycle and Status

### ProcessStatus

`ProcessStatus` is the stored lifecycle of the process container. It lives in `flow_sdk/fs_records/agentic_process_lifecycle.py` and `ts_sdk/src/process/agentic-types.ts`.

```ts
enum ProcessStatus {
  NEW = 'new',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  FAILED = 'failed',
}
```

Common transitions:

```text
new -> starting -> running -> stopping -> stopped
any -> failed
```

`isProcessRunning()` treats `starting`, `running`, and `stopping` as running container states. `isProcessStartable()` treats `new`, `stopped`, and `failed` as startable.

### WorkerStatus

`WorkerStatus` is the expert-level state of the worker. It is derived from the transcript/event log by the active driver and sent on the wire as `worker_status`.

```ts
enum WorkerStatus {
  INITIALIZING = 'initializing',
  IDLE = 'idle',
  COMPLETE = 'complete',
  ERROR = 'error',
  INTERRUPTED = 'interrupted',
  INACTIVE = 'inactive',
  WAITING = 'waiting',
  THINKING = 'thinking',
  TOOL_CALL = 'tool_call',
  TOOL_RUNNING = 'tool_running',
  API_ERROR = 'api_error',
  API_TIMEOUT = 'api_timeout',
  UNKNOWN = 'unknown',
}
```

Worker status sets are mirrored between Python and TypeScript:

| Helper                | Values                                                          |
| --------------------- | --------------------------------------------------------------- |
| `isWorkerRunning()`   | `waiting`, `thinking`, `tool_call`, `tool_running`, `api_error` |
| `isWorkerTerminal()`  | `complete`, `error`, `interrupted`, `inactive`, `api_timeout`   |
| Ready worker statuses | `idle`, `complete`, `interrupted`                               |

### Ready For Input

`ready_for_input` is computed by `flow_sdk/builtin/agentic_process/status_predicates.py`:

```text
process.status == "running"
AND worker_status in {"idle", "complete", "interrupted"}
```

If no worker status can be discovered and `session_id` is empty, the process is treated as ready. If `session_id` exists but no transcript is available yet, it is treated as busy/initializing.

### WorkerMode

`WorkerMode` is not stored. `get_worker_mode()` derives it from **`visible`** (`status_predicates.py:60`):

```text
visible=true  -> INTERACTIVE
visible=false -> CLI
```

> ⚠️ **`WorkerMode` is a display projection, not the transport.** It is derived from `visible`, whereas the actual execution transport is `pty_mode`. In the lock-stepped common case they agree, but in the decoupled quadrants they can disagree — e.g. a hidden PTY session (`visible=false`, `pty_mode=true`) reports `WorkerMode.CLI` while its worker is still a live PTY. Never route execution on `WorkerMode`; route on `pty_mode`. This visible-vs-pty_mode split is a candidate for consolidation (see the arch note in the return report).

Python: `flow_sdk/builtin/agentic_process/status_predicates.py`
TypeScript: `ts_sdk/src/process/agentic-types.ts`

### Transcript Status

`AgenticProcess._discover_status_from_transcript()` delegates to the driver:

```text
path = process.driver.transcript_path(process)
worker_status = process.driver.tail_status(path)
```

Serialization injects:

```python
d["worker_status"] = str(computed) if computed else WorkerStatus.IDLE.value
d["ready_for_input"] = is_ready_for_input(self, computed)
```

Claude status comes from `flow_sdk/fs_records/agent_status.py` and the Claude JSONL tail. Examples:

| Transcript signal                        | WorkerStatus                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Missing transcript                       | `initializing` when a path is known; otherwise no computed status and API falls back to `idle`. |
| `last-prompt` after assistant completion | `complete`                                                                                      |
| assistant `stop_reason=end_turn`         | `complete`                                                                                      |
| assistant `stop_reason=stop_sequence`    | `error`                                                                                         |
| assistant `stop_reason=tool_use`         | `tool_call`                                                                                     |
| recent `progress` entry                  | `tool_running`                                                                                  |
| recent user entry                        | `waiting` or `api_timeout` after 30 seconds                                                     |
| system `api_error`                       | `api_error`                                                                                     |
| stale non-terminal transcript            | `inactive`                                                                                      |

Codex status comes from `flow_sdk/builtin/agentic_process/cli_drivers/codex/status.py` over the process-local Codex transcript.

***

## Configuration

### AgenticContext

Frontend `AgenticContext` is defined in `ts_sdk/src/process/agentic-context.ts` and serialized by `serializeAgenticContext()`.

```ts
interface AgenticContext {
  instructions?: string;
  workdir?: string;
  envVars?: Record<string, string>;
  model?: string;
  maxThinkingTokens?: number;
  permissionMode?: 'bypassPermissions' | 'askUser';
  projectId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  agentsJson?: Record<string, Record<string, unknown>>;
  chrome?: boolean;
  debug?: boolean;
  worktree?: boolean;
  additionalDirs?: string[];
  targetTypeIdStr?: string;
  outputFormat?: string;
}
```

Serialization mapping:

| TS field            | Backend key           |
| ------------------- | --------------------- |
| `envVars`           | `env_vars`            |
| `maxThinkingTokens` | `max_thinking_tokens` |
| `permissionMode`    | `permission_mode`     |
| `projectId`         | `project_id`          |
| `resumeSessionId`   | `resume_session_id`   |
| `forkSession`       | `fork_session`        |
| `agentsJson`        | `agents_json`         |
| `additionalDirs`    | `additional_dirs`     |
| `targetTypeIdStr`   | `target_typeid_str`   |
| `outputFormat`      | `output_format`       |

`ComputeNode.createProcess` receives this serialized context. Backend `scan_actions._scan_create_process()` stores process-level fields such as `workdir`, `project_id`, and `target_typeid_str`; moves CLI-related fields into `ClaudeCliOptions`/`cli_config`; and leaves remaining context in `context_data`.

### CLI Config

`cli_config` stores serialized worker CLI options. `AgenticProcess.cli_options` reconstructs the live command through `process.driver.cli_options(process)`.

For Claude, `ClaudeCliOptions` supports:

| Option                                | CLI effect                                            |
| ------------------------------------- | ----------------------------------------------------- |
| `permission_mode='bypassPermissions'` | `--dangerously-skip-permissions`                      |
| `chrome`                              | `--chrome`                                            |
| `debug`                               | `--debug`                                             |
| `worktree`                            | `--worktree`                                          |
| `verbose`                             | `--verbose`                                           |
| `output_format`                       | `--output-format <value>`                             |
| `session_id`                          | `--session-id <session_id>`                           |
| `resume` + `session_id`               | `--resume <session_id>`                               |
| `fork_session_id`                     | `--resume <source> --fork-session --session-id <new>` |
| `model`                               | `--model <model>`                                     |
| `effort`                              | `--effort <effort>`                                   |
| `agents_json`                         | `--agents '<json>'`                                   |
| `additional_dirs` / `add_dirs`        | repeated `--add-dir <path>`                           |
| `print_mode`                          | `-p`                                                  |

For Codex, `CodexCliOptions` builds `codex exec` arguments such as `--json`, `--ephemeral`, `-C <workdir>`, `-m <model>`, and `--dangerously-bypass-approvals-and-sandbox`.

### Embedded Assets

Agents and skills can be materialized under the process's assets directory and exposed to the worker through `additional_dirs`.

Backend actions:

```text
POST /api/v1/graph/agentic_process/<id>/attach-embedded-asset
POST /api/v1/graph/agentic_process/<id>/detach-embedded-asset
GET  /api/v1/graph/agentic_process/<id>/list-embedded-assets
```

TypeScript:

```ts
await process.embeddedAssets.attach('agent-<id>');
await process.embeddedAssets.detach('skill-<id>');
const refs = process.embeddedAssets.list();
```

***

## Backend API

All graph actions use `/api/v1/graph/{type}/{id}/{action}`.

### ComputeNode Creation Actions

```text
POST /api/v1/graph/compute_node/<id>/createProcess
POST /api/v1/graph/compute_node/<id>/upsertSessionProcess
```

`createProcess` creates an idle `AgenticProcess` from serialized `AgenticContext`. It returns process entity data.

`upsertSessionProcess` finds or creates a process for an existing Claude `session_id`. It is used by transcript/session navigation flows.

### AgenticProcess Actions

| Action                  | Method     | Description                                                                       |
| ----------------------- | ---------- | --------------------------------------------------------------------------------- |
| `open`                  | `POST`     | Start or reopen visible PTY mode through `AgenticProcess.start()`.                |
| `exit`                  | `POST`     | Stop worker and PTY while preserving the linked `Shell` entity.                   |
| `restart`               | `POST`     | `exit()` then `start()`.                                                          |
| `close`                 | `POST`     | Permanent teardown: close/delete linked `Shell`, clear shell links, stop process. |
| `fork`                  | `POST`     | Create a sibling process that forks from this process's `session_id`.             |
| `execute`               | `POST`     | Execute an instruction through `prompt()`; routes by `pty_mode`.                  |
| `prompt`                | `POST`     | Print-mode streaming HTTP prompt; the print-mode branch is taken when `pty_mode=false`. |
| `cancel-prompt`         | `POST`     | Cancel an in-flight print-mode worker.                                            |
| `execute-plan`          | `POST`     | Inject a plan execution prompt into an active PTY session.                        |
| `update-plan`           | `POST`     | Inject a plan-update prompt into an active PTY session.                           |
| `load-embedded-agent`   | `POST`     | Merge an agent spec into `cli_config.agents_json`.                                |
| `attach-embedded-asset` | `POST`     | Materialize an agent/skill under the process assets dir.                          |
| `detach-embedded-asset` | `POST`     | Remove a materialized embedded asset.                                             |
| `list-embedded-assets`  | `GET`      | Return current embedded asset TypeIds.                                            |
| `get-history`           | `GET`      | Load transcript history as `FlowData`.                                            |
| `status`                | `GET/POST` | Return stored `status`, computed `worker_status`, and `ready_for_input`.          |
| `add-dir`               | `POST`     | Append a directory to `additional_dirs`.                                          |
| `input-dir`             | `GET`      | Return/create the process input directory.                                        |

### Shell Actions Used By PTY Mode

`AgenticProcess.start()` works through `flow_sdk/builtin/shell.py`; frontend PTY attachment uses the `Shell` entity and shell service code.

Relevant `Shell` actions:

| Action               | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `open`               | Start a generic shell PTY.                                   |
| `close`              | Kill PTY, delete disk record, delete shell entity.           |
| `run`                | Run a subprocess command and return stdout/stderr/exit code. |
| `set-env`            | Persist and inject shell environment variables.              |
| `update-display`     | Update shell display metadata.                               |
| `fetch-pty-sequence` | Fetch replay-buffer data by sequence.                        |

***

## TypeScript API

### Imports

```ts
import {
  AgenticProcess,
  ProcessStatus,
  WorkerStatus,
  WorkerMode,
  isReadyForInput,
  getWorkerMode,
} from '@sdk/process';
```

The current files are under `ts_sdk/src/process/`, not `ts_sdk/src/agentic_processor/`.

### Entity Shape

`IAgenticProcess` includes:

| Property                                                       | Description                                    |
| -------------------------------------------------------------- | ---------------------------------------------- |
| `status`                                                       | Stored `ProcessStatus`.                        |
| `worker_status` / `workerStatus`                               | Computed `WorkerStatus`.                       |
| `ready_for_input`                                              | Server-computed readiness flag.                |
| `session_id`                                                   | Persistent worker session ID.                  |
| `shell_id`                                                     | Linked `Shell` for PTY mode.                   |
| `visible`                                                      | Tab visibility only (transport is `pty_mode`). |
| `cli_config`                                                   | Serialized worker CLI options.                 |
| `context_data`                                                 | Persisted extra context.                       |
| `workdir`                                                      | Worker working directory.                      |
| `shell_mode`                                                   | Direct PTY spawn vs legacy shell intermediary. |
| `additional_dirs`                                              | Extra `--add-dir` directories.                 |
| `embedded_asset_refs`                                          | Embedded agent/skill refs.                     |
| `project_id`, `project_encoded_name`                           | Project linkage.                               |
| `exe_folder`, `input_folder`, `output_folder`, `assets_folder` | Execution folder refs.                         |

Convenience getters:

| Getter                                   | Description                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `cliOptions`                             | Deserializes `cli_config` to `ClaudeCliOptions` and injects `session_id`, `workdir`, and `additional_dirs`. |
| `shellEntity`                            | Cached linked `Shell`, if available.                                                                        |
| `compute_node_id` / `compute_node_uname` | Delegated from the linked shell.                                                                            |
| `ptyConnection`                          | Delegated from the linked shell.                                                                            |
| `completed` / `error` / `historyLoaded`  | Client-side stream state.                                                                                   |
| `workDirVfs`                             | `workdir` converted to `VFSPath`.                                                                           |

### Static Methods

| Method                                                    | Description                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `AgenticProcess.execute(command, options?)`               | Simple one-shot helper. Creates a process on the current compute node and calls `executeInstruction()`.                                 |
| `AgenticProcess.spawn(options, workerOptions?)`           | Create and optionally activate a process. Without `headless: true` it opens a PTY; pass `visible: true` for user-visible terminal tabs. |
| `AgenticProcess.getByIdWithHistory(id)`                   | Fetch process and call `loadHistory()`.                                                                                                 |
| `AgenticProcess.open(sessionId)`                          | Upsert a process for a Claude session ID.                                                                                               |
| `AgenticProcess.fromWorkerSessionId('claude', sessionId)` | Alias for opening by session ID. The public name is legacy; the entity field is `session_id`.                                           |
| `AgenticProcess.openRecordInTerminal(record)`             | Ensure an existing record/session has a live PTY.                                                                                       |
| `AgenticProcess.fromClaudeSession(sessionId, cwd?)`       | Resolve/create a process from a Claude session record.                                                                                  |

### Instance Methods

| Method                                      | Mode | Description                                                                                                                          |
| ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `start(options?)`                           | PTY  | Calls backend `open`; creates/reuses a Shell PTY and attaches the frontend.                                                          |
| `sendInput(text)`                           | PTY  | Sends text through the active PTY connection.                                                                                        |
| `inject(message)`                           | PTY  | Frontend compatibility helper for queue-style injection; current backend PTY injection is primarily used internally by plan actions. |
| `executePlan(filePath, options?)`           | PTY  | Inject plan execution prompt.                                                                                                        |
| `updatePlan(filePath)`                      | PTY  | Inject plan update prompt.                                                                                                           |
| `exit()` / `stop()`                         | PTY  | Stop worker and PTY but keep shell entity.                                                                                           |
| `restart()`                                 | PTY  | Stop then start, preserving session history.                                                                                         |
| `close()`                                   | PTY  | Permanent teardown of the linked shell.                                                                                              |
| `fork(visible?)`                            | PTY  | Create and open a forked sibling process.                                                                                            |
| `prompt(text, abortController?)`            | CLI  | Streaming print-mode prompt over HTTP.                                                                                               |
| `cancelPrompt()`                            | CLI  | Cancel the active print-mode subprocess.                                                                                             |
| `executeInstruction(instruction, options?)` | Both | Calls backend `execute`; backend routes by `pty_mode`.                                                                                |
| `wait()`                                    | Both | Wait for terminal `workerStatus`/failed lifecycle.                                                                                   |
| `output()`                                  | Both | Async iterator over collected and live `FlowData`.                                                                                   |
| `getOutputs()`                              | Both | Synchronous access to collected `FlowData`.                                                                                          |
| `loadHistory(options?)`                     | Both | Load transcript history into the `FlowData` stream.                                                                                  |
| `appendUserMessage(content)`                | Both | Optimistically append a user message to the stream.                                                                                  |

### Events

`AgenticProcess` extends `APIEntity` and emits:

| Event          | Description                           |
| -------------- | ------------------------------------- |
| `flow_data`    | New `FlowData` arrived.               |
| `complete`     | Client-side stream marked complete.   |
| `error`        | Client-side stream marked failed.     |
| `state_change` | Delta for `status` or `workerStatus`. |
| `restarted`    | Emitted after frontend `restart()`.   |

***

## Stale Names

The following names appear in older docs or compatibility shims but are not the current model:

| Stale concept                            | Current term / behavior                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AgenticProcessor` parent                | Use `ComputeNode.createProcess` / direct `AgenticProcess`; the current entity is standalone.                                         |
| `ts_sdk/src/agentic_processor/*`         | Current SDK paths are `ts_sdk/src/process/*`.                                                                                        |
| `flow_sdk/builtin/agentic_processor.py`  | Current backend entity file is `flow_sdk/builtin/agentic_process/agentic_process.py`.                                                |
| `worker_session_id`                      | Use `session_id` on `AgenticProcess`. Some old compatibility code may accept or expose the old name, but it is not canonical.        |
| process-level `pty_pid`                  | PTY state is on `Shell.pty_pid`; process links via `shell_id`.                                                                       |
| `startPty()`, `resumePty()`, `killPty()` | Use `start()`/`open`, `restart()` or `start()` after stale shell, `exit()`/`close()`.                                                |
| `state.status`                           | Use stored `status` plus computed `worker_status`; there is no persisted `ProcessorState` status source on current `AgenticProcess`. |
| AMD processor/debug run loop             | Not part of the current `AgenticProcess` backend file. Current execution is worker CLI prompt/PTY plus FlowData history.             |
| `visible` as the mode selector           | `visible` is tab-visibility only. The transport selector is `pty_mode`. All execution routers key on `pty_mode`, never `visible`.    |
| "Routing stays `headless == !visible`"   | Stale phrasing still present in `agentic_process.py:461` and `agentic-process.ts:174`. Routing is `!pty_mode`; `visible` and `pty_mode` are only lock-stepped at launch, and `set-visible` can decouple them. |

***

## Key Files Reference

### Backend Python

| File                                                                     | Role                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `flow_sdk/builtin/agentic_process/agentic_process.py`                    | Main `AgenticProcess` entity, lifecycle, prompt/open/close actions, serialization.           |
| `flow_sdk/builtin/agentic_process/status_predicates.py`                  | `WorkerMode`, `is_ready_for_input`, process/worker predicate exports.                        |
| `flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py` | `AgenticContext`, `AgenticWorker`, `WorkerCLIOptions`, `WorkerDriver`, `get_driver()`.       |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/driver.py`          | Claude driver: CLI options, print turns, transcript path/status/history, prompt composition. |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/cli.py`             | Claude CLI option builder and direct PTY spawn args.                                         |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/stream_worker.py`   | `claude -p --output-format stream-json` print-mode worker.                                   |
| `flow_sdk/builtin/agentic_process/cli_drivers/codex/driver.py`           | Codex driver: print turns, process-local transcript, history/status.                         |
| `flow_sdk/builtin/agentic_process/cli_drivers/codex/cli.py`              | Codex CLI option builder.                                                                    |
| `flow_sdk/builtin/agentic_process/cli_drivers/codex/stream_worker.py`    | `codex exec --json --ephemeral` print-mode worker.                                           |
| `flow_sdk/builtin/shell.py`                                              | Shell entity that owns PTY sessions and worker OS process metadata.                          |
| `flow_sdk/builtin/faas/scan_actions.py`                                  | `ComputeNode.createProcess` and `upsertSessionProcess` implementations.                      |
| `flow_sdk/fs_records/agent_status.py`                                    | `WorkerStatus` and Claude transcript tail-status derivation.                                 |
| `flow_sdk/fs_records/agentic_process_lifecycle.py`                       | `ProcessStatus` lifecycle enum and helpers.                                                  |
| `flow_sdk/fs_records/agentic_process_record.py`                          | Filesystem record and execution folder layout.                                               |

### TypeScript SDK

| File                                               | Role                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `ts_sdk/src/process/agentic-process.ts`            | `AgenticProcess` class, spawn/start/prompt/execute/history methods.       |
| `ts_sdk/src/process/agentic-context.ts`            | `AgenticContext`, spawn options, context serialization.                   |
| `ts_sdk/src/process/agentic-types.ts`              | `ProcessStatus`, `WorkerStatus`, `WorkerMode`, display/readiness helpers. |
| `ts_sdk/src/process/index.ts`                      | Process module exports.                                                   |
| `ts_sdk/src/entities/compute-node/compute-node.ts` | Frontend `createProcess()` and `upsertSessionProcess()` calls.            |
| `ts_sdk/src/entities/shell.ts`                     | Shell entity consumed by PTY mode.                                        |
| `ts_sdk/src/services/shell/ptyConnection.ts`       | Frontend PTY attachment/input stream.                                     |
| `ts_sdk/src/cli_workers/claude-cli.ts`             | TypeScript Claude CLI option builder.                                     |

### Frontend/UI References

| Path                                               | Role                                         |
| -------------------------------------------------- | -------------------------------------------- |
| `ui/src/components/terminal/interactive-terminal/` | Interactive terminal UI and process toolbar. |
| `ui/src/components/terminal/TabbedTerminal.tsx`    | Multi-tab terminal orchestration.            |
