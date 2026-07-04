---
id: 357acf1f-609c-5d7f-8d4a-e165c15c42f2
---

# AgenticProcess — interface

Complete interface reference for the `AgenticProcess` entity — the backend Python object, its HTTP `@action` surface, and the frontend TypeScript class.

For the conceptual model, read the narrative docs (this reference does not duplicate them):

- `docs/agent-management/agentic-process.md` — the two-axis model (`pty_mode` = transport intent vs `visible` = tab visibility), lifecycle, drivers.
- `docs/agent-management/mode-switching.md` — the PTY⇄headless (interactive⇄CLI) toggle and its mid-turn guard.
- `docs/agent-management/claude-session-manager.md` — the `restart_required` / drift-detection contract.

URL grammar for every action below: `POST|GET /api/v1/graph/agentic_process/{id}/{action}`. Verb column shows POST, GET, or ALL (`@action.all` accepts both). The two entity-minting actions live on `ComputeNode`, not `AgenticProcess`.

---

## Python object & API

Class: `AgenticProcess(Entity)` — `flow_sdk/builtin/agentic_process/agentic_process.py:389`. `_api_visible = True`, `type = "agentic_process"`, icon `Workflow`.

### Fields (semantics)

The two transport/visibility axes are the load-bearing ones; the rest support lifecycle, drift-detection, and assets.

| Field | Type | Semantics |
| --- | --- | --- |
| `pty_mode` (:453) | `bool = True`, persisted | **Transport intent** and the routing key. `True` → interactive PTY (live terminal). `False` → headless JSON-stream (`-p`/stream-json, no PTY, no xterm; loader skips the PTY attach). Execution routes on `pty_mode`, not `visible`; `pty_mode` seeds `visible` at launch and the chat⇄terminal toggle keeps them in lock-step in the common case. |
| `visible` (:445) | `bool = False` | **Tab visibility only** — "is this process shown as a terminal tab". Set `True` on open, `False` on close. NOT a transport selector and NOT a membership flag (the strip's membership is the `Tab` entity). |
| `cli_config` | `dict` | Vendor CLI options (`ClaudeCliOptions`/`CodexCliOptions`/`CopilotCliOptions` serialized). Holds `agents_json`, `resume`, `session_id`, permission mode, etc. |
| `session_id` | `str \| None` | Vendor session/thread id. Once set, `project_id`+`workdir` are **frozen** (see `__setattr__` binding lock, :613) — rebinds to a different value are refused because the on-disk transcript is keyed to them. |
| `shell_id` | `str \| None` | Linked `Shell` entity (the PTY host). Preserved across `exit()` for restart; `sidecar_shell_id` is the legacy zsh-intermediary companion. Reverse pointer is `Shell.agentic_process_id` (see note below). |
| `shell_mode` | `bool = False` | AgenticProcess drives this choice. `False` = direct PTY spawn (default) — the worker PID is set via `shell.set_worker_pid_direct(cmd)` (`start_pty` path, :1144); `True` = legacy zsh intermediary. |
| `restart_required` (:481) | `bool = False` | `True` iff a worker-relevant field drifted since the last successful `start_pty()` while `RUNNING`. Set by the save-hook (drift vs `last_started_hash`); surfaced as a UI "Restart" affordance. See claude-session-manager.md. |
| `workdir` | `str \| None` | Worker cwd. Frozen once `session_id` is set; derived from the owning project when unset. |
| `additional_dirs` | `list[str]` | Extra dirs passed to the worker via `--add-dir`. |
| `embedded_asset_refs` | `list[TypeId]` | Entities materialized into `<record_dir>/assets/`, discovered via `--add-dir`. |
| `embedded_agent_ids` | `list[str]` | Agent ids injected via `--agents` at launch. |
| `project_id` | `str \| None` | Owning project. Frozen once `session_id` is set; resolved by `get_project()` from ancestry → workdir → `@local`. |
| `status` | `str` | Lifecycle `ProcessStatus` (NEW / STARTING / RUNNING / STOPPING / STOPPED / FAILED). Distinct from the transcript-derived `worker_status`. |
| `start_failure` (:489) | `str \| None` | Latches a process after an instant-death launch; blocks auto-respawn until an explicit `open(retry=true)`. |
| `last_started_hash` / `last_started_snapshot` | drift baseline | MD5 + structured `{generic, worker}` payload captured at last successful `start_pty()`; compared on each `save()` to set `restart_required`. |
| `process_type` | `ProcessKind \| None` | Usage discriminator: CHAT, EXECUTION, ANALYSIS, CONVERSATION, or WIZARD. It does not choose transport; WIZARD is a popup assistant completed by a typed result event. |
| `target_typeid_str` | `str \| None` | VFS path the process is keyed to — a serialized TypeId for entity-scoped chats, or `<typeid>/<sub_path>` for surface-scoped chats. |
| `auto_rename` | `bool = True` | Allow PTY OSC title escapes to update `name`; cleared on first manual rename. |
| `status_report` / `total_cost_usd` / `markdown_docs` / `plan_path` | projections | Backend-computed transcript projections (counters, USD cost, authored docs, latest plan), persisted so UI affordances survive reload. `total_cost_usd` is derived, not persisted. |

### Public methods (by concern)

Names + one-liners; no bodies.

**Lifecycle**
- `run(instruction, workdir=None, **kw)` *(classmethod)* — one-shot create→start→send→wait→`RunResult`→stop.
- `resume(session_id, workdir=None, **kw)` *(classmethod)* — factory that pre-bakes `--resume <session_id>` cli_config.
- `fork(session_id, workdir=None, **kw)` *(classmethod)* — factory that pre-bakes `--resume <parent> --fork-session --session-id <new>`.
- `start_pty(instruction=None, visible=None, retry=False, session_id_override=None)` — the PTY entry point; always materializes a Shell + spawns the interactive worker. Runs under a per-process open lock; reloads before spawning. `retry=True` clears the `start_failure` latch.
- `start(...)` — back-compat alias for `start_pty`.
- `wait(timeout=None)` / `waitForIdle(timeout=None)` — block until terminal `worker_status` / until ready-for-input (2 s poll).

**Prompting / input**
- `prompt(instruction)` — schedule a run and return; routes on `pty_mode` (PTY stdin / `start_pty` relaunch / `driver.headless_prompt`).
- `input(text, options=None)` — stage without submitting (raw PTY keystrokes, no Enter; else enqueue on the persisted queue).
- `submit(instruction=None, options=None)` — commit one turn; `submit(x)` ≡ `input(x)` + `submit()`.
- `send(data)` — raw write to live PTY stdin (`str` → bracketed paste + `\r`; `bytes` → verbatim).
- `inject(message)` — inject text into the running worker (used by plan actions).

**Transcript**
- `stream_transcript(timeout=300, poll_interval=0.2)` — async-iterate JSONL entries as the worker writes them.
- `transcript` *(property)* — driver-resolved transcript descriptor; `transcript_path` *(property)* — its `Path`.
- `on_transcript_change(jsonl_path, entries)` — hook fired when the transcript file changes.

**Config**
- `cli_options` *(property)* → `WorkerCLIOptions`; `driver` *(property)* → the vendor `WorkerDriver`.
- `cmd_line` *(property)* — live launch command (disk I/O; never call inside `model_dump`).
- `save(owner=None, notify=True)` — persist; runs the drift/`restart_required` save-hook.

**Queue**
- `queue` *(property)* → `PromptQueue` — the file-backed FIFO (`prompt_queue.json`) under the record dir.

**Assets**
- `load_skill(skill)` — make a skill folder discoverable (symlink into the worker's skills root).
- `load_embedded_agent(agent)` — merge an agent spec into `cli_config.agents_json`.
- `get_asset_descriptors()` → `list[AssetDescriptor]` — unified read-only view (embedded + inline + path-scan).

**Misc**
- `shell()` → `Shell | None`; `get_compute_node()` → the linked shell's compute node.
- `fork(...)` *(see lifecycle)*; `close()` — permanent teardown (kill worker + delete shell entity, keep `shell_id`).
- `rename(name)`; `teardown_for_tab()` — `Tab.close` dispatch hook → `close()`.
- `get_by_session_id(session_id)` *(classmethod)* — resolve a process from a vendor session id.

### Display target contract (`flow show`)

`flow show` is the process-scoped display pin. It is intentionally different from
`flow navigate`:

- `flow navigate` steers the user's browser tab.
- `flow show` resolves a display target and sends it to watchers through the
  `on_show` entity event without changing the browser URL.

Both verbs share `resolve_display_target` (`flow_sdk/core/display_target.py`) so
typeids, file paths, and ports resolve consistently. The resolved payload is one
of:

| Kind | Input | Payload shape | Display meaning |
| --- | --- | --- | --- |
| `entity` | TypeId, or a path owned by an indexed asset | Entity metadata plus optional source path | Open the matching asset editor/viewer. |
| `vfs` | Raw file path not owned by an indexed asset | `{ kind: "vfs", path }` | Open the raw file viewer/editor chosen by extension. |
| `webapp` | Port | `{ kind: "webapp", port }` | Open a dev-server preview through the process compute node. |

`AgenticProcess.show` also persists the payload into `context_data.last_shown`.
That persistence is load-bearing for Vibe: a refreshed or late-opened process
dock can restore the agent's last shown target even though the original
`on_show` event has already passed. Vibe then chooses display state in this
order: `last_shown` / fresh `on_show`, stream `FlowData.focus`, webapp fallback.

MCP UI is a specialization of the raw VFS case: a shown path ending in
`.mcp.html` is rendered by the MCP App preview host instead of the generic HTML
preview.

### Wizard result contract

A wizard is an `AgenticProcess` with `process_type=WIZARD`, usually created by
`launchWizard(name, data)` through the frontend `WizardHost`. It runs headless
JSON-stream transport (`pty_mode=false`) inside the same chat UI and resolves a
typed result:

```ts
{ status: 'done' | 'cancel' | 'error', data: T | null, errorStr?: string | null }
```

Completion uses the generic entity-event ingress, not a wizard-specific REST
endpoint. The UI footer calls `completeWizard(process, result)`, and an agent can
emit the same event through:

```bash
flow wizard <agentic_process_id> close '{"status":"done","data":{}}'
```

Both paths post `wizard.close`; the backend validates it and emits
`wizard.closed` for the waiting `launchWizard` promise.

### Relationship to Shell

The `AgenticProcess` ⇄ `Shell` link (see `docs/interface/shell.md`):

- **Reverse pointer:** `Shell.agentic_process_id` — set once at Shell creation, never reassigned (distinct from the OS worker PID). `AgenticProcess.shell_id` is the forward pointer.
- **Lifecycle contrast (load-bearing):** an AgenticProcess **worker-exit preserves the Shell** — only the worker process ends, so the tab stays resumable (`exit()` keeps `shell_id`, `session_id`, and the transcript). By contrast `Shell.close()` **deletes the Shell** (record + entity). `AgenticProcess.close()` is the teardown that both kills the worker and deletes the shell entity, while keeping `shell_id` on the AgenticProcess as the reserved tab identity.
- **shell_mode:** AgenticProcess owns the choice. On the default `shell_mode=False` (direct PTY spawn) path, the worker PID is stamped via `shell.set_worker_pid_direct(cmd)`.

### Helper types

- `AgenticContext` — backend per-turn execution context (`cli_worker_base_driver.py:79`): `compute_node`, `instructions`, `workdir`, `env_vars`, `model`, `permission_mode`, `resume_session_id`, `fork_session`, `session_id`, `effort`, add-dirs, etc. (A second, prompt-layer `AgenticContext` lives in `_shared.py:19`.)
- `AssetDescriptor` (dataclass, :132) — one asset row: `typeid`, `source: AssetSource`, `posix_path`, `source_dir`. `AssetSource` ∈ {EMBEDDED, INLINE, PROJECT_DIR, USER_DIR, WORKDIR, ADDITIONAL_DIR, CONTEXT_DIR}; the last five are read-only sources.
- `TranscriptSubpath` (StrEnum, :120) — `plan` / `prompt` / `prompts` / `full`; routes the `transcript` action's sub-path.
- `AgenticProcessEventName` (StrEnum, `events.py`) — client→worker events; currently just `FIRST_PROMPT = "first_prompt"`.

---

## Backend actions

38 `@action`s on `AgenticProcess` (verified: `grep -c '@action' agentic_process.py` → **38**). `POST|GET /api/v1/graph/agentic_process/{id}/{action}`.

| Action | Verb | Python method(s) | Mode | Guards / preconditions | Description |
| --- | --- | --- | --- | --- | --- |
| `exit` | POST | `exit` → `Shell.stop` | both | Fails if no `shell_id`. | Kill worker, keep shell entity + `session_id` alive (status→STOPPED). Use before restart. |
| `switch-mode` | POST | `_enter_cli_mode` (→cli) / `_perform_open` (→interactive) | both | body `{mode}`; **→CLI rejected mid-turn (409)** if a prompt lock is held. →interactive has no such guard. | Standardized transport switch. `cli` kills PTY + `visible=False`+`pty_mode=False`; `interactive` spawns PTY + `visible=True`+`pty_mode=True`. Same session. |
| `restart` | POST | `http_restart` → `exit` + `start_pty(retry=True)` | both | None (carries `retry=True`, so `start_failure` never blocks it). No mid-turn guard. | exit() + start_pty(); shell entity reused. |
| `self-restart` | POST | `http_self_restart` → schedules `http_restart` | both | Safe to call from inside the running worker. | Detached restart: returns `{scheduled:true}` immediately, runs exit+start out-of-band, emits `worker.restarted` WS event. |
| `recover-project` | POST | `recover_project_action` → `Project.recover_by_path` | both | Fails if no `workdir`. Bypasses the project-id freeze. | Re-attach to a Project derived from `workdir` when `project_id` is a dangling FK. |
| `fork` | POST | `fork_action` → `AgenticProcess.fork` + `save` | both | body `{visible?}`. | Create a sibling process sharing this session's history (`--resume <sid> --fork-session`). |
| `enqueue` | POST | `_enqueue_action` → `queue.enqueue` | both | body `{prompt, source?}`; `prompt` required. | Append a prompt to the persisted queue; schedules a drain. |
| `dequeue` | POST | `_dequeue_action` → `queue.dequeue` | both | body `{id\|index}` required. | Remove one queued entry. |
| `clear-queue` | POST | `_clear_queue_action` → `queue.clear` | both | — | Empty the prompt queue. |
| `set-queue-enabled` | POST | `_set_queue_enabled_action` → `queue.set_enabled` | both | body `{enabled?}` (default true). | Enable/disable auto-drain; schedules a drain when enabled. |
| `set-visible` | POST | `_set_visible_action` (mutates `visible` only) | both | body `{visible?}`. Idempotent. | Show/hide the tab WITHOUT touching `pty_mode`, killing the worker, or switching transport. |
| `input` | POST | `_http_input` → `input` | both | body `{text, options?}`. | Stage input, no submit. Live PTY → raw keystrokes; headless/cold → persisted queue. |
| `submit` | POST | `_http_submit` → `submit` | both | body `{instruction?, options?}`. Headless fails if nothing staged. | Commit one turn. Live PTY → discrete Enter; headless → drain queue head. |
| `execute` | POST | `_http_execute` → `prompt` | both | param `instruction` required; optional `session_id`. | SDK `executeInstruction()` seam; delegates to `prompt` (fresh-start or send-to-running). |
| `prompt` | POST | `_http_prompt` → `_run_pty_prompt` (PTY) / `driver` stream (headless) | both | body `{message, permission_mode?}`; `message` required. **409** if status STOPPING/FAILED or a prompt lock is already held; `permission_mode` whitelisted. | Streaming turn (chunked FlowData). One action, two transports keyed on `pty_mode`. |
| `cancel-prompt` | POST | `_http_cancel_prompt` → worker `close_session` | headless (print-mode) | Fails if no in-flight worker. | Cancel the in-flight print-mode turn (SIGTERM→5 s→SIGKILL). |
| `execute-plan` | POST | `execute_plan` → `inject` + `set_plan_auto_approve` | PTY | param `file_path` required. | Tell the worker to update+execute a plan; optional `/clear` first; arms one-shot ExitPlanMode auto-approve. |
| `update-plan` | POST | `update_plan` → `inject` | PTY | param `file_path` required. | Tell the worker to update the plan from `<plan-note>` annotations. |
| `transcript` | POST | `transcript_action` → `_transcript_plan`/`_transcript_prompts`/`_transcript_full` | both | routes on URL sub-path (`plan`/`prompts`/`full`); unknown → fail. | Generic transcript surface; loads JSONL once, dispatches by sub-path. |
| `get-plan` | POST | `get_plan` → `_transcript_plan` | both | — | Back-compat alias for `transcript/plan`. |
| `load-embedded-agent` | POST | `load_embedded_agent_action` → merge `cli_config.agents_json` | both | param `asset_ref` required + file must exist. | Embed an agent from a VFS path into `cli_config` (durable). |
| `load-embedded-skill` | POST | `load_embedded_skill_action` → symlink into skills root | both | param `asset_ref` required; folder + `SKILL.md` must exist. | Make a skill folder discoverable to the worker (live symlink). |
| `attach-embedded-asset` | POST | `attach_embedded_asset` → `_materialize_entity` | both | param `entity_ref` (TypeId) required. | Materialize an entity under assets dir + add to `--add-dir` + record in `embedded_asset_refs`. |
| `detach-embedded-asset` | POST | `detach_embedded_asset` → `_unmaterialize_entity` | both | param `entity_ref` required. | Remove materialized files + drop from `embedded_asset_refs`. |
| `list-embedded-assets` | GET | `list_embedded_assets` | both | — | Return `embedded_asset_refs` as serialized TypeId strings. |
| `get-assets` | GET | `get_assets_action` → `get_asset_descriptors` | both | — | Unified asset list (embedded + inline + path-scan). |
| `get-history` | GET | `get_history_action` → `driver.load_history` | both | Stateless — works after exit. | Transcript as a list of FlowData dicts. Empty is success (`history:[]`), not 404. |
| `restart-info` | GET | `restart_info_action` → `_diff_snapshot_fields` | both | Read-only. | Diff of last-started launch payload vs current entity snapshot (powers "Command Status"). |
| `cmd-line` | GET | `cmd_line_action` → `cmd_line` | both | Read-only; failure-tolerant (`cmd_line:None`). | Live launch command, computed on demand (never serialized). |
| `status` | ALL | `get_status` → `fetch_worker_status` | both | Read-only. | `{status, worker_status, ready_for_input}` (transcript-derived). |
| `get-host` | ALL | `get_host` → `compute_node.get_host` | both | params `port` (1024–65535), `redirect?`. | Resolve public host for a dev-server port on this process's compute node (web preview). |
| `set-graph-context` | POST | `set_graph_context_action` → `set_graph_context` | both | param `graph_context_id`; GraphContext must exist (404). Pre-launch only. | Bind a GraphContext to this process before launch. |
| `add-dir` | POST | `add_dir` | both | param `path`. | Append to `additional_dirs` (→ `--add-dir`) + one-shot index scan of the new path. |
| `remove-dir` | POST | `remove_dir` | both | param `path`. No-op if absent. | Remove a dir from `additional_dirs`. |
| `open` | POST | `_http_open` → `start_pty` | both | body `{instruction?, visible?, session_id?, retry?}`. `retry:true` clears `start_failure`. | Spawn/reattach the PTY worker (name kept as `open` for back-compat). |
| `os-status` | GET | `os_status` → `_collect_os_status_payload` | both | Read-only (may self-heal a stale compute-node link; never spawns/kills). | OS-level liveness snapshot; `ready` is the headline (`isAlive()`). For batches prefer ComputeNode `os-status-batch`. |
| `close` | POST | `_http_close` → `close` | both | Fails if already terminated. | Permanent teardown: kill worker + delete shell entity (keeps `shell_id` as reserved tab identity). |
| `input-dir` | GET | `get_input_dir` | both | — | Absolute path of the process's input dir (created if missing) + compute-node id. |

### Entity-minting actions (on ComputeNode)

These live on `ComputeNode` (`flow_sdk/builtin/faas/compute_node.py`), not `AgenticProcess`, because they create the entity. URL: `POST /api/v1/graph/compute_node/{id}/{action}`.

| Action | Verb | Python method | Description |
| --- | --- | --- | --- |
| `createProcess` | POST | `create_process_action` → `_scan_create_process` (`scan_actions.py:256`) | Create a new idle AgenticProcess on this node. Body `{context, result?, visible?, pty_mode?, launch_prompt?}`. `pty_mode` (default `True`) is the transport intent; `launch_prompt` is enqueued **before** the auto-start so the worker boots with it as its launch instruction. Returns the entity. |
| `upsertSessionProcess` | POST | `upsert_session_process` → `_scan_upsert_session_process` (`scan_actions.py:549`) | Idempotent on `sessionId`. Body (camelCase) `{sessionId, workdir?, projectId?, workerType?}`. Adopts an existing vendor session (codex/claude) as an AgenticProcess. Backend/test callers; UI prefers `terminals/get_by_worker_id/<id>`. |

---

## Frontend TS interface

Class: `AgenticProcess extends APIEntity<AgenticProcess> implements IAgenticProcess` — `ts_sdk/src/process/agentic-process.ts:289`. `static type = 'agentic_process'`.

### Statics
- `execute(command, options?)` — simplest one-shot: `createProcess` → `watch` → `executeInstruction` (AMD-wrapped).
- `openTab(workerType, prompt?, project?, opts?)` — spawn a visible tab (or headless when `opts.ptyMode===false`); seeds `prompt` via `createProcess({launchPrompt})`, then `openTerminalDock`.
- `launch(opts)` — start a session in an explicit project workdir; can mount the Flowpad Assistant via `load_flowpad_assistant`; first prompt rides the queue.
- `spawn(options, workerOptions?)` — low-level factory: build `ClaudeCliOptions` → `save` → headless (`watch`+`executeInstruction`) or PTY (`start`). Returns `SpawnResult`.
- `getByIdWithHistory(id)` — `getById` + auto `loadHistory`.
- `openRecordInTerminal(record)` — open an existing session record as a terminal.
- `getByWorkerId(workerId, workerType?)` — resolve a process from a vendor worker/session id (auto-discovers `workerType`).

### Getters
- `status` → `ProcessStatus`; `workerStatus` → `WorkerStatus` (transcript-derived).
- `cliOptions` (get/set) → `ClaudeCliOptions`.
- `ptyConnection` → the live `PtyConnection | undefined`; `shellEntity` → `Shell | null`.
- Dock-pointer family: `dockPointer`, `terminalDockPointer`, `transcriptDockPointer`, `searchDockPointer` (URL-first navigation targets).
- `completed`, `error`, `historyLoaded`, `isPrompting`, `wasRestoredFromSession`.
- `icon`, `instructionFile`, `workDirVfs`, `compute_node_id`, `compute_node_uname`, `stackFrame`.

### Methods (by concern)

**Lifecycle** — `start(options?)`, `exit()`, `stop()`, `restart()` (emits `restarted`), `close()`, `switchMode(mode, opts?)` (interactive → `start`; cli → `switch-mode` round-trip), `fork(visible=false)`.

**Prompting** — `prompt(...)`, `input(text, options?)`, `submit(instruction?, options?)`, `executeInstruction(...)`, `cancelPrompt()` (print-mode), `interruptTurn()` (PTY Ctrl-C or `cancelPrompt`), `sendInput(text)`, `inject(instruction)`, `continue(command)`.

**Queue** — `enqueue(prompt, source?)`, `dequeue(idOrIndex)`, `clearQueue()`, `setQueueEnabled(enabled)`, plus `pinPrompt`/`unpinPrompt`/`linkExecutedPrompt`.

**Stream** — `loadHistory(options?)`, `output()` (async generator of FlowData), `getOutputs()`, `appendUserMessage(content)`, `onLine(handler)`, `wait()`, `waitForReady(options?)`, `waitForComplete()`.

**Assets / dirs** — `addDir(path)`, `removeDir(path)`, `loadEmbeddedAgent(sourcePath)`, `loadEmbeddedSkill(sourcePath)`, `getAssets()`, `enableAssistant()` / `setAssistantEnabled(enabled)`.

**Misc** — `setVisible(visible)` (optimistic + latch), `setGraphContext(graphContextId)`, `recoverProject()`, `getPlan()`, `getPrompts()`, `getTranscript()`, `executePlan(filePath, options?)`, `updatePlan(filePath)`, `createCollaborationRoom(...)`, `shell()`.

### Events
Local `EventEmitter` events (subscribe via `.on(name, fn)`):
- `flow_data` — each streamed FlowData (base `handleFlowData`).
- `complete` — terminal success; `error` — turn/worker error.
- `state_change` — status/lifecycle change (drives `wait()`).
- `status` — `(newStatus, oldStatus)`; `status_report` — counters projection; `prompting-change`, `line`.
- `restarted` — terminal should clear + re-attach the PTY. Emitted directly by `restart`/`switchMode(interactive)`, and bridged from the backend `worker.restarted` entity event via `onEntityEvent` (server-initiated `self-restart`).
- `entity_event` — generic backend entity event bridge. Wizard callers wait for
  `wizard.closed` on this channel.

### Spawn payload contract (`ts_sdk/src/process/agentic-context.ts`)
- `AgenticContext` — the camelCase DTO (`workdir`, `model`, `permissionMode`, `projectId`, `resumeSessionId`, `forkSession`, `agentsJson`, `additionalDirs`, `loadFlowpadAssistant`, `sharedContextEntities`, `targetVfsPath`, `outputFormat`, `workerType`, `processType`, …). `compute_node_id` is deliberately NOT sent (backend-managed).
- `IAgenticProcessOptions extends AgenticContext` — adds `scope: TypeId[]` and `shellMode` — the `spawn()` entrypoint type.
- `ISpawnWorkerOptions` — how `spawn` activates: `instruction`, `headless`, `sync`, `workerSessionId`, `visible`, `result`, `watchProcess`, `ptyTimeout`.
- `serializeAgenticContext(ctx)` — camelCase → snake_case for the REST body (`permissionMode`→`permission_mode`, `targetVfsPath`→`target_typeid_str`, etc.).

> **Caution — `spawn({headless:true})` does not set `pty_mode`.** `spawn` writes `visible` onto the new entity but never sets `pty_mode`, which defaults to `True` on the Python model. A "headless" spawn therefore leaves the entity's transport intent as PTY even though `spawn` drives it via `watch()`+`executeInstruction()`. Prefer `createProcess({ pty_mode: false })` / `openTab(..., { ptyMode:false })` when you need a durably-headless process (the loader reads `pty_mode`, not the spawn path, to decide whether to attach a PTY). Documented arch-review finding.

---

## Flows

End-to-end sequences are in the sibling `./flows.md` (anchors below are the expected entry points):

- Headless execute — [`./flows.md#headless-execute`](./flows.md#headless-execute)
- PTY launch / open tab — [`./flows.md#pty-launch`](./flows.md#pty-launch)
- Mode switch (PTY⇄headless) — [`./flows.md#mode-switch`](./flows.md#mode-switch)
- Restart & self-restart — [`./flows.md#restart`](./flows.md#restart)
- Fork a session — [`./flows.md#fork`](./flows.md#fork)
- Prompt queue drain — [`./flows.md#prompt-queue`](./flows.md#prompt-queue)
