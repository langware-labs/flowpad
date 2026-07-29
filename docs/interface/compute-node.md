---
id: b0f2f3f8-0b53-5da5-a753-7328bbfdafaf
---

# ComputeNode — interface

`ComputeNode` is the entity that represents an execution environment — "this machine"
(the `@local` singleton) or a remote sandbox (E2B). It is the backend host for the PTY /
shell stack, the file explorer, agentic processes, desktop/OS integration, and the
resource scanners, so nearly every local capability is exposed as an action on it.

- **Python**: `flow_sdk/builtin/faas/compute_node.py` — class `ComputeNode` at ~line 56.
  `flow_sdk/builtin/compute_node.py` is a **backward-compat re-export shim** (`from
  flow_sdk.builtin.faas.compute_node import ComputeNode`); import from either, the class
  lives in `faas/`.
- **TypeScript**: `ts_sdk/src/entities/compute-node/compute-node.ts` — class `ComputeNode`
  at ~line 88.

The class is assembled from six action mixins plus `Entity`:

```python
class ComputeNode(PtyActionsMixin, FsRecordsActionsMixin, OpsActionsMixin,
                  ScanActionsMixin, AnalyticsActionsMixin, DesktopActionsMixin, Entity):
```

The mixins hold **plain implementation methods only — no `@action` decorators**. Every
HTTP action is declared once on `ComputeNode` itself and delegates to a mixin method
(e.g. `@action.post("terminal-command")` → `self._pty_terminal_command()`). This keeps the
route surface in one file while the logic lives in the mixin.

## Python object & API

### The `@local` singleton (non-negotiable)

`@local` is the one compute node representing "this machine". The whole local stack
addresses it **by uname, never by a cached id**. If the row disappears (a project-delete
cascade or a compute-node sweep), every PTY / explorer / app-host caller breaks — see the
`[[project_local_compute_node_singleton]]` memory and CLAUDE.md. **Never cascade-delete it.**

| Classmethod | Purpose |
| --- | --- |
| `get_local(*, create=True)` | Single source of truth for resolving `@local`. Hardened: stable id → cache-invalidate retry → legacy uname → self-heal create. Callers must not hand-roll fallbacks. |
| `create_local(*, owner=None)` | Mints the `@local` node. Internal uname is an implementation detail of these two methods. |

### Plain public API (non-action)

| Member | Kind | Description |
| --- | --- | --- |
| `compute_provider` | property → `ComputeProvider` | The provider backing this node (local machine, E2B, …) via `get_compute_provider`. |
| `verified_node_provider_id` | property | Provider id, raising if not set up. |
| `provider_type_id_str` | property | Provider type-id string. |
| `get_host(port)` | method | Host URL for a port on this node. |
| `setup_node(run_startup=True)` | async | Initialize the provider; sets `node_provider_id`. |
| `get_node_status()` | async → `ExecutionEnvironmentStatus` | READY / PAUSED / … |
| `startup(config=None)` / `resume()` / `pause()` / `shutdown()` | async | Lifecycle transitions on the provider. |
| `wait_for_ready()` | async → bool | Block until the node is ready. |
| `run_command(cmd, background=…)` | async → `CLICommand` | Run a shell command on the node. |
| `exists(remote_paths)` | async → bool | Path existence check. |
| `write_files(...)` / `read_files(...)` | async | Bulk file write / read (overloaded read return shapes). |
| `list_dir(remote_paths)` | async → `dict[str, list[ListDirItem]]` | Directory listing. |
| `create_folders(remote_paths)` / `delete_files(remote_paths)` | async | Folder / file mutation. |
| `set_env(name, value)` | async | Set (or clear, when `value=None`) an env var on the node. |
| `get_machine_id()` | async → str | Stable machine identifier. |
| `get_machine_status()` | async → `MachineStatus` | Processes + network snapshot. |
| `send(msg_str)` | async | Low-level provider send. |
| `ready_session()` | async ctx-mgr | Ensures the node is up for the block, pauses on exit. |

`model_post_init` mounts the machine root (`/`) and `StorageProvider.LOCAL` when the node's
provider is `LOCAL_MACHINE`.

## Backend actions

All actions are declared on `ComputeNode` and delegate to a mixin method (or a local
helper). **45 `@action` decorators / 44 distinct action names** (`git-ops` is registered
twice — GET and POST — for one name). Grouped by the owning mixin below; "core" = declared
and implemented directly on `ComputeNode`, not via a mixin.

Verb legend: `@action.all` registers the handler for every method (GET/POST/PUT/DELETE);
`@action.get` / `.post` restrict to that verb.

### PtyActions mixin (`pty_actions.py`) — 7

| Action | Verb | Delegates to | Description |
| --- | --- | --- | --- |
| `terminal-command` | POST | `_pty_terminal_command` | Run/stream a command in a PTY-backed terminal. |
| `list-shells` | GET | `_pty_list_shells` | List PTY shell sessions on the node. |
| `session-transcript` | GET | `_pty_session_transcript` | Parsed session transcript. |
| `session-transcript-raw` | GET | `_pty_session_transcript_raw` | Raw (unparsed) transcript bytes. |
| `discovery` | GET | `_pty_discovery_action` | PTY session discovery. |
| `reset-pty` | POST | `_pty_reset_pty` | Wipe in-memory PTY state (session_manager, replay_buffer, provider `_pty_sessions`); DB Shell rows untouched. |
| `update-shell` | POST | `_pty_update_shell` | Update shell session metadata. |

### Ops mixin (`ops_actions.py`) — 1

| Action | Verb | Delegates to | Description |
| --- | --- | --- | --- |
| `ops` | POST | `_ops_dispatch` | Sub-path router: `ops/setup` (provider init), `ops/command` (execute, incl. streaming). |

### Scan mixin (`scan_actions.py`) — 11

| Action | Verb | Delegates to | Description |
| --- | --- | --- | --- |
| `terminals` | GET | `_scan_get_by_worker_id` (via router) | `terminals/get_by_worker_id/<id>` resolves an AgenticProcess by worker id. Legacy list/close removed at the Tab cutover. |
| `scan-resources` | ALL | `_scan_resources` | Full resource scan of the node. |
| `get-resource-summary` | ALL | `_scan_get_resource_summary` | Aggregated resource summary. |
| `scan-item` | ALL | `_scan_item` | Scan a single item. |
| `clear-skill-usage` | ALL | `_scan_clear_skill_usage` | Reset skill-usage analytics data. |
| `clear-cli-log` | ALL | `_scan_clear_cli_log` | Clear the CLI log. |
| `list-projects` | ALL | `_scan_list_projects` | Discovered local projects. |
| `scan-project` | ALL | `_scan_project` | Scan one project. |
| `createProcess` | POST | `_scan_create_process` | AgenticProcess factory — see subsection. |
| `upsertSessionProcess` | POST | `_scan_upsert_session_process` | Resume/attach factory — see subsection. |
| `findSession` | GET | `_scan_find_session` | Read-only session-id → descriptor lookup (no process creation). |

### Desktop mixin (`desktop_actions.py`) — 9

| Action | Verb | Delegates to | Description |
| --- | --- | --- | --- |
| `get-host` | ALL | `_desktop_get_host(port, redirect=True)` | Resolve host URL for a port. |
| `get-machine-status` | ALL | `_desktop_get_machine_status` | Processes + network snapshot. |
| `get-system-profile` | ALL | `_desktop_get_system_profile` | Claude Code environment / config profile. |
| `open-external` | POST | `_desktop_open_external` | Open a URL/path in the OS. |
| `open-terminal` | POST | `_desktop_open_terminal` | Open a native terminal window. |
| `pick-folder` | POST | `_desktop_pick_folder` | Native folder-picker dialog. |
| `get-json-file` | ALL | `_desktop_get_json_file` | Read a JSON file from the node FS. |
| `save-json-file` | POST | `_desktop_save_json_file` | Write a JSON file to the node FS. |
| `generate-amd-plan` | POST | `_desktop_generate_amd_plan` | Generate an AMD (app-materialization) plan. |

### FsRecords mixin (`fs_records_actions.py`) — 3

| Action | Verb | Delegates to | Description |
| --- | --- | --- | --- |
| `fs-records` | GET/POST/PUT/DELETE | `_fs_records_action` | The file-explorer / VFS records CRUD gateway. |
| `asset-usage` | GET | `_handle_asset_usage` | `?skill=<name>` — sessions in which an asset was used (transcript scan). Powers the asset IDE usage tab. |
| `commit-asset` | POST | `_handle_commit_asset` | `{workdir, file}` — version-bump + commit an on-disk asset edit. |

### Analytics mixin (`analytics/`) — 2

| Action | Verb | Delegates to | Description |
| --- | --- | --- | --- |
| `get-cost-overview` | ALL | `_analytics_cost_overview` | Cost overview across sessions. |
| `get-claude-context` | ALL | `_analytics_claude_context` | Claude context/usage analytics. |

### core (on `ComputeNode` directly) — 12 decorators / 11 names

| Action | Verb | Implementation | Description |
| --- | --- | --- | --- |
| `tabs` | POST | `_terminal_close` | Compat router for `tabs/close` — batch terminal teardown (shell + agentic_process). |
| `recover-orphaned-project` | POST | `_recover_orphaned_project` | `{dangling_id}` — resurrect a deleted Project from a dependent's `workdir`; rebind `project_id`s. |
| `create-project-from-git` | POST | `_create_project_from_git` | `{git_origin, target_name?}` — clone into workspace + materialize a Project; 409 with `suggested_name` on collision. |
| `find-local-repo` | POST | `_find_local_repo` | `{git_origin}` → `{found, local_path}` — locate an existing clone by `origin`. |
| `os-status-batch` | POST | `_os_status_batch` | `{process_ids}` — batched os-status snapshot for many AgenticProcesses (collapses N GETs). |
| `clear-debug-errors` | POST | `clear_debug_errors_action` | Delete all Claude debug logs + error records. |
| `search-cloud-errors` | POST | `search_cloud_errors_action` | `{fingerprints}` — proxy error-fingerprint search to Flowpad cloud, apply results locally. |
| `fix-all-cloud-errors` | POST | `fix_all_cloud_errors_action` | `{fingerprints}` — spawn an AgenticProcess per error with a saved cloud fix instruction. |
| `get-cwd` | GET | `get_cwd_action` | Runs `pwd`; returns `{cwd}`. |
| `worker-history` | GET | `worker_history_action` | Unified Recent Sessions across all workers; `?limit=&project_ids=` (per-project when scoped). |
| `git-ops` | GET | `git_ops_action` → `_git_ops_dispatch` | Read git ops: `status`, `branch`, `is-init`, `is-linked-worktree` (`?workdir=`). Delegates to `GitRepo.dispatch`. |
| `git-ops` | POST | `git_ops_post_action` → `_git_ops_dispatch` | Mutating git ops: `push`, `restore-file`, `discard-file`, `stage-file`, `unstage-file`. |

### `createProcess` / `upsertSessionProcess` — AgenticProcess factories

These two POST actions are the backend factory that mints an `AgenticProcess` on this node.
They are the entity-creation path behind the TS `ComputeNode.createProcess`. Full process
lifecycle lives in [./agentic-process.md](./agentic-process.md).

**`createProcess`** (`_scan_create_process`) — POST body is `CreateProcessRequest`-shaped:

```
{ context: <serialized AgenticContext>, result?: {...}, visible?: bool,
  pty_mode?: bool, launch_prompt?: str }
```

The `context` is the serialized `AgenticContext` (see the TS `serializeAgenticContext`).
The handler pops fields out of it onto top-level process schema fields, notably:
`workdir`, `project_id`, `target_typeid_str` (from `targetVfsPath`), `process_type`
(lifted out so `useProcessesForTarget`'s `match:{process_type}` filter works),
`worker_type` (`claude_code` | `codex` | `copilot`; **unknown value is a hard error**, never
silently substituted), `model`, `permission_mode` (default `bypassPermissions`),
`fork_session`, `resume_session_id`, `additional_dirs`, `load_flowpad_assistant`, and
`shared_context_entities`. `pty_mode` picks transport: `true` → interactive PTY (default),
`false` → headless JSON-stream. `launch_prompt` is enqueued **pre-start** so the worker
boots with it as its launch arg (deterministic — avoids the post-start stdin race).

The success payload is the full authoritative serialized `AgenticProcess`, not
an identity-only row. This is required by the TS return type and preserves
explicit false values (`pty_mode:false`, `visible:false`) when the SDK hydrates
the returned entity. Correctness must not depend on the save broadcast reaching
the DataManager cache before the HTTP response.

**`upsertSessionProcess`** (`_scan_upsert_session_process`) — resume/attach counterpart: same
context lift, but reattaches to an existing session instead of a clean spawn.

## Frontend TS interface

Class `ComputeNode extends APIEntity<ComputeNode>` (`static type = 'compute_node'`).

| Member | Signature | Description |
| --- | --- | --- |
| `getLocal()` | `static async → ComputeNode \| null` | Frontend counterpart to backend `get_local()`. Read-only resolution: context node (if `LOCAL_MACHINE`) → bootstrap `default_compute_node` → fetch by `@local` alias typeid. Never mints (client can't create entities; backend self-heals). |
| `createProcess(context?, options?)` | `async → AgenticProcess` | Main factory. `context: AgenticContext` (serialized via `serializeAgenticContext`); `options`: `result`, `watchProcess`, `visible`, `pty_mode`, `launchPrompt`. Hydrates the action's full authoritative entity response, then calls `process.watch()` unless `watchProcess === false`. |
| `findSession(sessionId, workerType?)` | `async → FindSessionResult \| null` | Read-only session lookup; `null` on 404. Never creates a process. |
| `appendSession` / `addSession` / `createSession` / `getSession` / `hasSession` / `removeSession` / `rekeySession` / `getAllSessions` / `clearLocalSessions` / `sessionCount` | mixed | **Frontend-only session cache** (`Map<id, Shell>`) — the local view of PTY sessions. Reset on node switch; does **not** touch backend PTYs. |
| `startWatchingMachineSessions(cb?)` / `stopWatchingMachineSessions()` / `isWatchingMachineSessions` | mixed | Subscribe to `on_data_op` and materialize a `Shell` for each new id in `active_pty_sessions`. |
| `setup()` | `async → string` | `ops/setup` — init provider; sets `node_provider_id`. |
| `executeCommand(input)` | `async → ShellOutputFlowData` | `ops/command` — run a command, parse the XML flow stream into stdout/stderr/exit-code. |
| `executeCommandStreaming(input, onCmdProgress?)` | `async → void` | Streaming variant over `ops/command` with `stream:true`. |
| `getMachineStatus()` | `async → MachineStatus` | `get-machine-status` action. |
| `getArtifactProcess(artifact)` | `async → ProcessInfo \| null` | Find the process serving an artifact's port (via machine status). |
| `startArtifactProcess` / `stopArtifactProcess` / `restartArtifactProcess` | async → `ProcessInfo` | Service control over an artifact's `start_cmd` / port (poll-until-up; throws `ServiceControlError`). |
| `getJsonFile<T>(path)` / `saveJsonFile(path, data)` | async | `get-json-file` / `save-json-file`. |
| `resetPty()` | `async → number` | `reset-pty`; returns cleared-session count. |
| `getCwd()` | `async → string` | `get-cwd`. |
| `openPathDialog(initialDir?)` | `async → string \| null` | `pick-folder`; `null` on cancel. |
| `git(workDir)` | `→ GitWorkdir` | Workdir-bound git helper (fronts the `git-ops` action). |

Module helper: `vfsToOsPath(vfsPath, root)` converts a VFS-relative path to an OS absolute
path (OS detected from `root`).

### Sibling type files

- `compute-node-types.ts` — `ComputeProviderType` (`local_machine`/`e2b`), `RuntimeType`,
  `OSType`, `RuntimeEnvironment`, `ExecutionEnvironmentStatus`, `IComputeNode`.
- `machine-status.ts` — `MachineStatus`, `ProcessInfo`, `NetworkConnection`,
  `ComputeNodeSize` (+ labels), `ComputeNodeInfo`. Mirrors the Python machine_status models.
- `service-control.ts` — `ServiceArtifact`, `isServiceArtifact`, `canStartArtifact`,
  `ServiceControlError` — the artifact service-control types used by the `*ArtifactProcess`
  methods.
- `system-profile.ts` — `SystemProfile` types (`Scope`, `ItemType`, …) for the Claude Code
  environment surfaced by `get-system-profile`.

## Flows

Short cross-references into [./flows.md](./flows.md):

- **Spawn an agentic session** — `createProcess` → backend `_scan_create_process` →
  `AgenticProcess`. See [./flows.md#create-process](./flows.md#create-process) and
  [./agentic-process.md](./agentic-process.md).
- **Resume a session** — `findSession` (lookup) → `upsertSessionProcess`. See
  [./flows.md#resume-session](./flows.md#resume-session).
- **Run a terminal command** — `executeCommand` / `terminal-command`. See
  [./flows.md#run-command](./flows.md#run-command).
- **Resolve `@local`** — `ComputeNode.getLocal()` ⇄ backend `get_local()`. See
  [./flows.md#resolve-local](./flows.md#resolve-local).
