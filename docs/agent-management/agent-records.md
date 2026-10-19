---
id: d8f7b76f-2547-4599-8d59-8125fddbecbf
version: 5
---
# Agent Records

Reference for the filesystem records and entity/runtime state used by agent
management. The important boundary is:

* Durable records and DB entities survive server restarts: `FSRecord` shadow
  folders (for `agentic_process`, `shell`, `claude_session`, … types) and the
  `AgenticProcess` / `Shell` entity rows. The old per-type record subclasses
  (`Record`, `AgenticProcessRecord`, `ShellRecord`, `ClaudeSessionRecord`,
  `AgentRecord`, the whole `flow_sdk/fs_records/` package) were deleted.

* Live runtime state does not survive restarts: in-memory PTY handles, replay
  buffer chunks, `_PROMPT_LOCKS`, `_PROMPT_WORKERS`, live OS PIDs, and the
  cached compute-node binding on `Shell`.

* Claude conversation history is durable because Claude writes JSONL transcripts
  under `~/.claude/projects/...`, not because the live worker object is durable.

***

## Table of Contents

1. [FSRecord](#1-fsrecord)
2. [Claude Session Records](#2-claude-session-records)
3. [AgenticProcess Record Folder](#3-agenticprocess-record-folder)
4. [Process and Worker Status](#4-process-and-worker-status)
5. [Transcript and History by Mode](#5-transcript-and-history-by-mode)
6. [Shell and PTY Runtime State](#6-shell-and-pty-runtime-state)
7. [SubAgent Records](#7-subagent-records)
8. [Record-Entity Sync](#8-record-entity-sync)
9. [Read/Write Patterns](#9-readwrite-patterns)
10. [TypeScript SDK Counterparts](#10-typescript-sdk-counterparts)
11. [Key Files Reference](#11-key-files-reference)

***

## 1. FSRecord

### Purpose

`FSRecord` (in `flow_sdk/fs_store/fs_record.py`, exported from
`flow_sdk.fs_store`) is the **single concrete record class** for
filesystem-backed metadata. There are no record subclasses: per-type behavior
lives in the type's registered `TypeInfo` (`flow_sdk/schema/type_info/`) and in
per-type helper modules such as
`flow_sdk/fs_store/indexer/functions/claude_sessions.py`. The full record model
is in `docs/CLAUDE.md` and `docs/data-management/record-model.md`.

Current storage model:

* Meta fields are direct instance attributes (`__dict__`).

* `metadata.json` is the only persisted state; `save_metadata(patch)` is a
  partial-merge writer and `save()` writes the whole flat dict.

* There is no dirty tracking, no `_data` / `raw_json` compatibility argument,
  and no auto-save on attribute mutation.

* The TypeScript client still uses `FsRecord` naming (§10).

### On-Disk Layout

Default metadata root:

```text
<records_root>/<type>/<id>/
  metadata.json                     # flat JSON dict of all persisted fields
  <epoch>_<hash>_<pathdigest>.hash  # index sentinel (zero-byte)
```

(The old wrapped `{"data": {...}}` metadata, `state.json` cache, named `<key>.json` children, and `output/` folder were removed with the `FSRecord` refactor — see `docs/data-management/record-model.md` and `docs/data-management/folder-layout.md`.)

Record data/blob root:

```text
~/.flow/instances/<name>/records_data/<type>/<id>/
```

`record_stem(record_type, uid)` builds the portable `<type>-<id>` token (not the
shadow-folder name, which is the bare id). There are no legacy
`.flow_record/record.json` / `data.json` load fallbacks: `FSRecord.load_record()`
reads only `metadata.json`.

Both roots are **per instance**: the records root is
`InstanceSettings.records_root` (`~/.flow/instances/<name>/records/`) and the
data/blob root is `InstanceSettings.records_data_dir`. Resolve them with
`get_default_records_root()` / `get_default_records_data_root()`, build per-record
folders with `shadow_dir_for(type, id)` / `data_dir_for(type, id)`, and redirect
them in tests with `set_default_records_root()` /
`set_default_records_data_root()` — all in `flow_sdk/fs_store/record_paths.py`.

### Serialization

`meta_dict()` returns the flat dict used to build the Entity DB row: `type`,
`id`, `asset_ref` (path string), and every non-system, non-`None` instance
attribute. `to_dict()` / `data` return the flat dict too.

### Location Properties

| Property                       | Type            | Description                                                             |
| ------------------------------ | --------------- | ----------------------------------------------------------------------- |
| `shadow_dir`                   | `Path`          | `<records_root>/<type>/<id>/`, computed from `(type, id)`               |
| `record_folder_ref`            | `FSRef`         | FSRef for `shadow_dir`                                                  |
| `metadata_ref`                 | `FSRef`         | FSRef for `shadow_dir/metadata.json`                                    |
| `asset_ref` (alias `main_ref`) | `FSRef \| None` | The primary content file; only its path is persisted in `metadata.json` |

### Constructor

```python
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store import FSRecord

record = FSRecord(type="task", id=mint_uuid(), name="y", description="z")
```

The signature is `FSRecord(type: str = "", id: str | None = None, **fields)`;
every extra kwarg becomes a direct attribute. `FSRecord` never mints an id: a
file-backed record gets it from `TypeInfo.mint_entity_id()`, a row-only entity
from `Entity.allocate_id()`, and an id-less record reaching `save()` raises
`ValueError`.

### Status Fields

There is no generic `RecordStatus` enum. `status` is an ordinary meta field
whose vocabulary belongs to the type: agent processes use `ProcessStatus`
(`flow_sdk/builtin/process_lifecycle.py`), shells use `ShellStatus`
(`flow_sdk/builtin/shell.py`), and the Claude session listing writes a worker
state (§2).

### Read-Only Records

Read-only enforcement is FSRef-level. A Claude session record's `_asset_ref` is
`FSRef(jsonl_path, read_only=True)` (set by `extract_claude_session_from_path`),
so a session record is never written back to Claude's JSONL transcript.

***

## 2. Claude Session Records

### Purpose

One Claude Code session transcript is an `FSRecord` of type `claude_session`
(`RecordType.CLAUDE_SESSION`). The Python `ClaudeSessionRecord` subclass and its
`ClaudeSessionFsRecord` alias were deleted; their behavior is now module-level
functions in `flow_sdk/fs_store/indexer/functions/claude_sessions.py` (walker,
stats, status, transcript, discovery) plus the extractor in
`flow_sdk/assets/types/claude_sessions.py`. Only the TypeScript SDK still has a
`ClaudeSessionRecord` class with a deprecated `ClaudeSessionFsRecord` alias
(§10).

### Source on Disk

```text
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

The encoded project directory is the absolute working directory with `/`
replaced by `-`. For example:

```text
/Users/me/myproject
~/.claude/projects/-Users-me-myproject/<session-id>.jsonl
```

Each JSONL line is a Claude event with shared envelope fields such as
`sessionId`, `cwd`, `version`, `gitBranch`, `slug`, `timestamp`, `uuid`, and
`type`, plus type-specific payload under fields such as `message`.

### Fast Construction

`extract_claude_session_from_path(path, *, include_content=True, resolved_id=None)`
(`flow_sdk/assets/types/claude_sessions.py:66`) is the cheap constructor that
replaced `ClaudeSessionRecord.from_jsonl`:

* Reads head lines only until the first `cwd`-bearing envelope, for
  `session_id`, `slug`, and `cwd`.

* Reads the session title via `read_claude_title(path)`.

* Sets `jsonl_path`, `source_file`, and `path` to the JSONL path.

* With `include_content=True` it also builds the FTS `content` via a full
  `worker_summary_log` parse; listing callers pass `include_content=False`.

* Does not populate stats such as token counts or message counts.

The returned `FSRecord` has:

* `id = resolved_id or session_id`.

* `name = custom_title or slug or session_id`.

* `_asset_ref = FSRef(path, read_only=True)`.

### Lazy Data Fields

There are no descriptors. Call `ensure_claude_session_stats(rec)` explicitly: it
parses the JSONL once (cached on the instance as `_session_batch_stats`) and
writes these fields onto the record in place. Verbatim excerpt,
`flow_sdk/fs_store/indexer/functions/claude_sessions.py:53`:

```python
_STAT_FIELDS = (
    "session_id", "cwd", "version", "git_branch", "slug",
    "model", "message_count", "user_message_count", "assistant_message_count",
    "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens",
    "duration_ms", "tools_used", "has_plan", "last_stop_reason",
    "last_user_message", "modified_at", "task_path",
    "estimated_cost_usd", "models_used", "primary_model", "created_at",
)
```

`claude_session_to_dict(rec)` runs the stats parse and adds `status` and
`is_active`. `claude_session_meta_dict(rec)` is the fast path for bulk listings:
it avoids the full parse and writes `status = "complete"`.

### Status

A session's worker status is not stored. It is derived from the transcript tail
by `_tail_status()` (`flow_sdk/transcript_analyzer/worker_status.py:524`).
Verbatim excerpt, `flow_sdk/fs_store/indexer/functions/claude_sessions.py:170`:

```python
def claude_session_status(rec: FSRecord) -> WorkerStatus:
    """Derive WorkerStatus from the last 4 KB of the JSONL (~60µs)."""
    path = getattr(rec, "jsonl_path", None) or rec.source_file
    if not path:
        return WorkerStatus.IDLE
    return _tail_status(path)
```

An `AgenticProcess` does not go through this helper; it uses
`fetch_worker_status()` (§3).

### Transcript Entries

`claude_session_transcript_entries(rec)` reads the full JSONL file and builds
entries through `create_transcript_entry()`
(`flow_sdk/fs_store/indexer/functions/_claude_transcript.py`).

`claude_session_filtered_entries(rec)` excludes noisy entry types. Verbatim
excerpt, `flow_sdk/fs_store/indexer/functions/claude_sessions.py:65`:

```python
_EXCLUDED_ENTRY_TYPES = ("file-history-snapshot", "progress")
```

`claude_session_to_transcript_dicts(rec, include_raw_json=False)` serializes the
filtered entries for API responses.

### Discovery

```python
from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    discover_claude_session_paths_iter,
    get_claude_session,
)

paths = list(discover_claude_session_paths_iter(limit=50))  # JSONL Paths

session = get_claude_session(
    "<session-id>",
    project="/path/to/workdir",  # optional O(1) project lookup
)  # FSRecord | None
```

Without `project`, `get_claude_session()` scans every project directory under
`InstanceSettings.claude_projects_dir` (`~/.claude/projects/`). It extracts with
`include_content=False`, so it never runs the full transcript parse.

### Active Sessions

`claude_session_is_active(rec)` is True when the JSONL mtime is within the last
5 minutes (`_ACTIVE_MAX_AGE_SECONDS = 300`).

***

## 3. AgenticProcess Record Folder

### Purpose

`AgenticProcessRecord`, its `flow_sdk.fs_records.AgenticProcess` alias, and its
constructor defaults / `pty_session_id` migration were deleted. The only
`AgenticProcess` class is the DB-backed entity
`flow_sdk/builtin/agentic_process/agentic_process.py::AgenticProcess`. Its
on-disk folder is the plain `FSRecord` shadow folder for type
`agentic_process`, resolved by `AgenticProcess._record_dir()`
(`agentic_process.py:2038`, which calls `shadow_dir_for("agentic_process", id)`).

Important naming on the entity:

* `status` is the stored process-container lifecycle and uses `ProcessStatus`.

* `shell_id` links to the `Shell` entity.

* `session_id` is the canonical Claude/Codex session field.

* HTTP `open` still accepts legacy `worker_session_id` in the body and maps it
  to `session_id` (`agentic_process.py:6878`).

### Execution Folder Layout

Per-process artifacts live under the record folder:

```text
<records_root>/agentic_process/<id>/
  metadata.json
  execution/
    input/
    output/
    assets/
```

The folder FSRefs are entity fields filled in from `_record_dir()`
(`agentic_process.py:6152-6155`):

* `exe_folder` (`execution/`)

* `input_folder` (`execution/input/`)

* `output_folder` (`execution/output/`)

* `assets_folder` (`execution/assets/`)

`execution/input/` is the process's one input folder: `run(input=…)` saves a DataSpec
there, pasted and dropped files land there (the `input-dir` action), and
`resolved_add_dirs` mounts it for the worker. `execution/output/` is used only when a run
declares its output (`run(output_spec=…)`): the agent is told to write that DataSpec's
layout there, and it is loaded back into the answer's `value`; by default a process works
in its `workdir` instead (`builtin/agentic_process/process_io.py`). The turn-end reindex skips this whole record
folder — it is the run's I/O, not project content. Startup retention keeps the newest
200 records, not counting a record whose `execution/output/` holds a file younger than
30 days (`fs_store/operations/record_retention.py`).

### Prompt Queue

There are no TTL-backed `PropertyRecord` descriptors. `AgenticProcess.queue` is a
file-backed FIFO `PromptQueue` over `prompt_queue.json` in the record folder.

### Worker Status Discovery

`discover_worker_status()` / `discover_status()` were deleted. The public
accessor is `AgenticProcess.fetch_worker_status()`. Verbatim excerpt,
`flow_sdk/builtin/agentic_process/agentic_process.py:6170`:

```python
def fetch_worker_status(self) -> WorkerStatus | None:
    if self.hub_route:
        raw = self.remote_projection.get("worker_status")
        try:
            return WorkerStatus(raw) if raw else None
        except ValueError:
            return None
    if self.status == ProcessStatus.NEW.value:
        return None
    if self.status == ProcessStatus.STOPPED.value:
        discovered = self._discover_status_from_transcript()
        return discovered if discovered and is_worker_terminal(discovered) else None
    if self.status == ProcessStatus.FAILED.value:
        return WorkerStatus.ERROR
    return self._discover_status_from_transcript()
```

(docstring omitted). `_discover_status_from_transcript()` reads the worker
transcript tail through the driver (`driver.tail_status(transcript_path)`) plus
liveness reconciliation. Each call is a tail read, so fetch once and pass the
value along (e.g. `is_ready_for_input(process, worker_status=...)`).

***

## 4. Process and Worker Status

Agent management uses a two-axis status model.

### ProcessStatus

`ProcessStatus` lives in
`flow_sdk/builtin/process_lifecycle.py`. It is the app/user-level
lifecycle of the process container and is stored on the `AgenticProcess` entity
(`status`).

```python
class ProcessStatus(StrEnum):
    NEW = "new"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"
```

The explicit lifecycle is:

```text
NEW -> STARTING -> RUNNING -> STOPPING -> STOPPED
any -> FAILED
```

### WorkerStatus

`WorkerStatus` lives in `flow_sdk/transcript_analyzer/worker_status.py`. It is
the expert-level state of the worker inside the process and is derived from the
transcript JSONL tail. It is not stored.

```python
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

assert [m.name for m in WorkerStatus] == [
    "INITIALIZING", "IDLE", "COMPLETE", "ERROR", "INTERRUPTED", "INACTIVE",
    "PENDING_USER", "WORKING", "THINKING", "TOOL_CALL", "TOOL_RUNNING",
    "API_ERROR", "API_TIMEOUT", "UNKNOWN",
]
```

`PENDING_USER` means an unresolved user-input tool (`AskUserQuestion` /
`ExitPlanMode`) sits at the tail; `WORKING` means input was received and the
worker is producing a reply.

Helper sets:

* Running worker statuses (`_RUNNING_STATUSES`, `worker_status.py:79`):
  `WORKING`, `THINKING`, `TOOL_CALL`, `TOOL_RUNNING`, `API_ERROR`.

* Busy worker statuses (`_BUSY_WORKER_STATUSES`,
  `flow_sdk/builtin/agentic_process/status_predicates.py:98`): `INITIALIZING`,
  `WORKING`, `THINKING`, `TOOL_CALL`, `TOOL_RUNNING`.

* Terminal worker statuses (`_TERMINAL_STATUSES`, `worker_status.py:89`):
  `COMPLETE`, `ERROR`, `INTERRUPTED`, `INACTIVE`, `API_TIMEOUT`.

### Tail Status Algorithm

`_tail_status(path)` (`worker_status.py:524`) reads the last 4 KB of the JSONL
(widening up to 2 MB when the window holds only envelope lines) and checks file
mtime (active = written within 5 minutes). Classifications, in priority order:

| Condition                                                      | WorkerStatus   |
| -------------------------------------------------------------- | -------------- |
| JSONL missing                                                  | `INITIALIZING` |
| unresolved `AskUserQuestion` / `ExitPlanMode` tool in the tail | `PENDING_USER` |
| most recent user text is an interrupt marker                   | `INTERRUPTED`  |
| `last-prompt` tail, no assistant stop reason yet               | `WORKING`      |
| `last-prompt` tail with a pending tool                         | `TOOL_RUNNING` |
| `last-prompt` tail after `stop_reason == "stop_sequence"`      | `ERROR`        |
| `last-prompt` tail after any stop reason other than `end_turn` | `WORKING`      |
| `last-prompt` tail after `end_turn`                            | `COMPLETE`     |
| last assistant `stop_reason == "end_turn"`                     | `COMPLETE`     |
| last assistant `stop_reason == "stop_sequence"`                | `ERROR`        |
| file stale for more than 5 minutes with no terminal signal     | `INACTIVE`     |
| active file with no parseable entry                            | `INITIALIZING` |
| active `system` entry with subtype `api_error`                 | `API_ERROR`    |
| active `system` entry with subtype `init`                      | `IDLE`         |
| active assistant entry with no stop reason                     | `THINKING`     |
| active assistant `stop_reason == "tool_use"`                   | `TOOL_CALL`    |
| active `progress` entry                                        | `TOOL_RUNNING` |
| active `user` entry older than 90s                             | `API_TIMEOUT`  |
| active `user` entry otherwise                                  | `WORKING`      |
| unrecognized tail                                              | `UNKNOWN`      |

### Entity Projection

The `AgenticProcess` API serializer adds `worker_status`, `busy`, and
`ready_for_input` (`agentic_process.py:5960-5964`):

* `worker_status`: `fetch_worker_status()` (§3).

* `busy`: `status_predicates.is_turn_busy()` — any of: the per-process prompt
  lock is held, a print-mode worker is registered, `_turn_in_flight` is set, or
  (PTY transport only) the raw `worker_status` is in `_BUSY_WORKER_STATUSES`.

* `ready_for_input`: `status_predicates.is_ready_for_input()`.

Readiness contract (`status_predicates.py:203`):

```text
is_ready_for_input(p)  ⇔  not is_turn_busy(p) and (
    p.status == RUNNING
    or (p.status == NEW and not p.pty_mode)                        # fresh headless
    or (p.status == STOPPED and not p.pty_mode and p.session_id)   # headless-idle
)
```

***

## 5. Transcript and History by Mode

`AgenticProcess.visible` selects the worker mode. The mode itself is not stored
separately.

| `visible` | Mode            | Worker shape                                    |
| --------- | --------------- | ----------------------------------------------- |
| `False`   | CLI/headless    | One subprocess per prompt turn, no `Shell`/PTY  |
| `True`    | Interactive/PTY | Live `Shell` entity and PTY-backed terminal tab |

Both modes use `AgenticProcess.session_id` as the durable conversation/session
identifier and both write or resume the same Claude JSONL transcript path:

```text
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

### CLI / Headless Mode (`visible=False`)

`AgenticProcess.prompt(instruction)` routes to:

```python
self.driver.headless_prompt(self, instruction)
```

For Claude, `ClaudeDriver.headless_prompt()`:

* Requires `process.workdir`.

* Eagerly assigns `process.session_id` when missing.

* Sets lifecycle `status` to `ProcessStatus.RUNNING`.

* Spawns `ClaudeCLIStreamWorker`.

* Runs `claude -p --output-format stream-json --verbose`.

* Passes either `--session-id <sid>` for a fresh turn or `--resume <sid>` for a
  resume turn.

* Captures the first `system:init` session id from stdout if Claude reports a
  different id, then saves it back onto the process.

* Streams FlowData to listeners from stdout.

* Leaves `status` as `RUNNING` after the turn so the process can accept the
  next prompt when `worker_status` becomes ready.

Durable storage in this mode:

* `AgenticProcess` DB row: `session_id`, `status`, `workdir`, `cli_config`, etc.

* Claude JSONL transcript: conversation history and worker-state source.

Non-durable live state in this mode:

* `_PROMPT_LOCKS`

* `_PROMPT_WORKERS`

* The live `ClaudeCLIStreamWorker`

* The subprocess PID

History loading:

```python
await process.get_history_action()
```

The action calls `driver.load_history(process)`. For Claude this reads the JSONL
with `session_history.load_session_history(session_id)` and converts user,
assistant, reasoning, tool-call, and tool-result entries into FlowData. It does
not require a live worker.

### Interactive / PTY Mode (`visible=True`)

`AgenticProcess.start()` / HTTP `open` creates or reuses a `Shell` entity, then
launches the worker in one of two ways:

* Default direct PTY path (`shell_mode=False`): Claude is the PTY process. The
  code builds argv/env with `cmd.to_spawn_args()` and calls
  `shell.start(spawn_args=..., extra_env=...)`, then records the PTY PID with
  `shell.set_worker_pid_direct()`.

* Legacy shell path (`shell_mode=True`): starts a shell such as zsh first, then
  injects the Claude command with `shell.launch()`.

In both paths, `ClaudeAgentOptions` carries `process.session_id` into the CLI as
`--session-id` or `--resume`, so Claude writes the same JSONL transcript shape
used by headless mode.

Durable storage in this mode:

* `AgenticProcess` DB row: `session_id`, `shell_id`, lifecycle `status`,
  `visible`, `cli_config`, etc.

* `Shell` DB row: tab metadata, `pty_pid`, `worker_pid`, `worker_name`,
  `last_launch_cmd`, workdir, env, tab order.

* Shell `FSRecord` (type `shell`): shell record metadata, plus the `.pty`
  stream file under the records data root.

* Claude JSONL transcript.

Non-durable live state in this mode:

* Provider-owned live PTY handle.

* In-memory replay buffer chunks.

* Actual OS process liveness behind `worker_pid` / PTY PID.

* Cached compute-node binding on the `Shell` instance.

Completion handling:

* `_poll_for_completion()` was deleted. A transcript change is debounced into
  `AgenticProcess._flush_transcript_change()`, which re-derives `worker_status`
  via `_discover_status_from_transcript()`, broadcasts only on a status
  transition, and runs the `API_TIMEOUT` → `_on_timeout` handling.

* The PTY exit callback updates the process lifecycle, and on close the session
  is indexed by loading it with `get_claude_session(session_id)` and calling
  `record.sync_to_db()`.

Resume and fork:

* `AgenticProcess.resume(session_id)` pre-bakes `--resume <session_id>`.

* `AgenticProcess.fork(session_id)` pre-bakes
  `--resume <source> --fork-session --session-id <new>`.

* When resuming/forking, the code looks up the source session record
  (`_discover_claude_record_session(lookup_id)`) and uses its `cwd` as
  `CLAUDE_PROJECT_DIR` / workdir.

***

## 6. Shell and PTY Runtime State

### Shell Entity

`Shell` (in `flow_sdk/builtin/shell.py`) is the DB-backed metadata layer for a
terminal tab / PTY session.

It stores queryable metadata such as:

* `id`: also the shell/PTY session id.

* `status`: a `ShellStatus` value — `idle`, `running`, `closing`, `closed`, or
  `error`.

* `workdir`, `env`, `name`, `tab_order`.

* `pty_pid`: PTY session id; currently set to the shell id by `Shell.start()`.

* `compute_node_id` and `compute_node_uname`.

* `worker_pid`, `worker_name`, and `last_launch_cmd`.

* `collaboration_room_id`.

The entity does not own the PTY bytes. It locates the live PTY through the
linked compute node.

### Shell Record

`ShellRecord` (and its constructor migrations/defaults) was deleted. A shell's
on-disk record is a plain `FSRecord` of type `shell`, handled by module
functions in `flow_sdk/builtin/shell.py`:

* `get_shell_record(uid)` (`shell.py:77`) — O(1)
  `FSRecord.load_or_none("shell", uid)`.

* `shell_pty_stream_path(record_id, pty_pid)` (`shell.py:82`) — the durable PTY
  stream path, `data_dir_for("shell", record_id) / f"{pty_pid}.pty"`.

* `close_shell_record(record)` (`shell.py:91`) — sets `status` to `closed` and
  unlinks the `.pty` stream file. Idempotent.

The PTY stream file lives under the per-instance records data root:

```text
~/.flow/instances/<name>/records_data/shell/<shell-id>/<pty_pid>.pty
```

`Shell.read()` reads this file (via `get_shell_record` + `shell_pty_stream_path`).
`Shell.output()` streams from the live PTY handle and therefore only works while
the PTY exists.

### Runtime Boundary

Do not treat the shell record, `Shell.pty_pid`, or `Shell.worker_pid` as proof that
a process is still alive. They are durable hints used for recovery and
reattachment. The current live state is checked through:

* `Shell.has_attachable_pty()`

* `Shell.is_alive`

* `Shell.worker_alive()`

* compute-provider PTY lookups

* `psutil` PID checks

`Shell.stop()` kills the PTY and leaves the shell entity. `Shell.close()` is
permanent teardown: terminate the worker, delete the shell's record, close the
PTY, and delete the `Shell` entity.

***

## 7. SubAgent Records

`AgentRecord`, `load_agent()`, and `agent_to_cli_json()` were deleted. A Claude
Code sub-agent definition (`.claude/agents/<name>.md`) is the `subagent` entity
type (see the glossary note in the root `CLAUDE.md`); in Python it is an
`FSRecord` built from the Markdown file by the helpers in
`flow_sdk/assets/types/subagent.py`:

* `load_subagent(name, roots)` — find `<name>` under the given agent roots.

* `parse_subagent_markdown(text, name=None)` /
  `render_subagent_markdown(rec)` — frontmatter + prompt body round-trip.

* `subagent_to_cli_json(rec)` — the Claude `--agents` dict for one sub-agent.

`flow_sdk/builtin/subagent_loading.py::load_subagent(name, project_dir=None)`
applies the application search order: `<project_dir>/.claude/agents`, the
user's `InstanceSettings.claude_agents_dir`, then the system agent roots.

For a process, `ProcessAssets.load_embedded_subagent(agent)`
(`flow_sdk/builtin/agentic_process/process_assets.py:173`) records the sub-agent
in `embedded_subagent_ids`, and `ProcessAssets.get_agents_json()` merges the
embedded sub-agents' `subagent_to_cli_json()` output into the `--agents` JSON
(falling back to a persisted `cli_config.agents_json` for legacy processes).

***

## 8. Record-Entity Sync

### Current Model

Records and entities are synchronized explicitly. There are no background file
watchers triggered by field access.

```text
FSRecord.sync_to_db()
  -> Entity.from_record(record)            (creates/updates + saves the row)
  -> record.sync_from_entity(entity)
  -> FTS upsert (batched or immediate)
  -> wiki edge re-extraction
  -> TypeInfo post-sync callbacks

Entity.store()
  -> FSRecord.load(type, entity.id) or FSRecord(type=type, id=entity.id)
  -> TypeInfo.serializer(origin).store(entity, origin)   (asset write)
  -> record.save_metadata(entity.metadata_payload())      (partial merge)
```

Current `Entity.get_record()` resolves by entity type and id,
not through a `vfs_record` field.

### Record -> Entity

`FSRecord.sync_to_db()` calls `Entity.from_record(self)`.

`Entity.from_record()`:

* Chooses the entity class registered for `record.type`.

* Starts from `record.meta_dict()`.

* Allocates a stable entity id with the entity class.

* Creates or updates the entity.

* For specialized entity classes, pulls matching domain fields from
  `record.to_dict()` only when needed.

* Saves the entity.

`FSRecord.sync_to_db()` then:

* Mirrors entity state back to the record via `sync_from_entity()` (in a worker
  thread).

* Upserts FTS from an `FtsEntry` built from the record.

* Re-extracts wiki edges and runs the type's post-sync callbacks.

* Records errors as `RecordError` on failure.

### Entity -> Record

`Entity.store()` / `_store()`:

* Loads the shadow with `FSRecord.load(type, entity.id)`, or constructs
  `FSRecord(type=type, id=entity.id)` if none exists yet.

* Writes the asset through the type's serializer (skipped for a borrowed
  checkout).

* Partial-merges `entity.metadata_payload()` (plus `asset_ref`) into
  `metadata.json` via `record.save_metadata()`.

`FSRecord.sync_from_entity(entity)` pulls canonical `id`, `scope`, `project_id`,
`updated_date`, and `asset_ref` from the entity onto the record, and calls
`save()` only when something changed.

### Legacy VFS Fields

Older code used `vfs_record` and `vfs_orphan`. SQLite has a migration that
extracts old `vfs_record` values into a `record_data_ref` column and removes
`vfs_record` / `vfs_orphan` from the JSON data blob. Current record/entity
loading for these agent records is type/id based.

***

## 9. Read/Write Patterns

### Generic Record

```python
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store import FSRecord

record = FSRecord(type="task", id=mint_uuid(), name="Example")
record.save()  # <records_root>/task/<id>/metadata.json

loaded = FSRecord.load("task", record.id)
```

`save()` writes the flat `metadata.json` into `record.shadow_dir` and raises
`ValueError` for an id-less record. Running this writes into the current
instance's records root; in tests, redirect it first with
`set_default_records_root()` and restore it in teardown.

### Claude Session

```python
from pathlib import Path

from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_session_status,
    ensure_claude_session_stats,
    extract_claude_session_from_path,
)

session = extract_claude_session_from_path(
    Path("~/.claude/projects/-Users-me-myproject/<session-id>.jsonl").expanduser()
)

print(claude_session_status(session))  # WorkerStatus
ensure_claude_session_stats(session)   # one lazy stats parse, in place
print(session.message_count)
print(session.tools_used)
```

Sessions are read-only. To find an existing session:

```python
from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session

session = get_claude_session("<session-id>", project="/abs/workdir")  # FSRecord | None
```

### Agentic Process Folders

```python
from flow_sdk.fs_store.record_paths import shadow_dir_for

execution = shadow_dir_for("agentic_process", "<process-id>") / "execution"

print(execution / "input")
print(execution / "output")
print(execution / "assets")
```

On a loaded `AgenticProcess` entity the same folders are the `input_folder`,
`output_folder`, and `assets_folder` FSRef fields, and the worker status is
`process.fetch_worker_status()` (§3).

### Shell Output

```python
shell_bytes = await shell.read()   # durable .pty stream file if present
live_stream = shell.output()       # live PTY stream; empty if no live PTY
```

Use `Shell.has_attachable_pty()` or `Shell.worker_alive()` to check live state.

***

## 10. TypeScript SDK Counterparts

### FsRecord

`ts_sdk/src/resource_management/fs_records/fs-record.ts` is the client-side
record shape. It is not an `APIEntity`, and it has **no CRUD helpers**: its
public API is `setComputeNode()`, `toDict()`, static `fromDict()`, and the
`stem` / `recordType` / `readOnly` / `storageLayout` getters. The old
`save()` / `getById()` / `getAll()` / `delete()` helpers were removed because the
backend routes `/fs-records/<segment>` by record type. Verbatim excerpt,
`fs-record.ts:130`:

```typescript
  // No CRUD helpers here. The backend routes /fs-records/<segment> by RECORD
  // TYPE, so the save/delete/get_by_id/get_all subpaths these used to POST were
  // answered with 400 "Unknown record type 'save'". Records are read through
  // SourceFileRecordList and written through its updateRecord().
```

### ClaudeSessionRecord

`ts_sdk/src/resource_management/fs_records/claude/claude-session.ts` exports
`ClaudeSessionRecord` as the canonical class and keeps
`ClaudeSessionFsRecord` as a deprecated alias. (This class exists only in
TypeScript; Python has no session record subclass, see §2.)

```typescript
export class ClaudeSessionRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SESSION;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FILE;
}

/** @deprecated Use ClaudeSessionRecord */
export const ClaudeSessionFsRecord = ClaudeSessionRecord;
```

The TypeScript data shape includes session stats, `jsonl_path`, `start_time`,
`project_encoded_name`, `last_user_message`, cost/model fields, and
`source_file`/`path` compatibility fields.

### AgenticProcess Status Types

`ts_sdk/src/process/agentic-types.ts` mirrors the Python two-axis model:

* `ProcessStatus`: `new`, `starting`, `running`, `stopping`, `stopped`,
  `failed`.

* `WorkerStatus`: `initializing`, `idle`, `complete`, `error`, `interrupted`,
  `inactive`, `pending_user`, `working`, `thinking`, `tool_call`,
  `tool_running`, `api_error`, `api_timeout`, `unknown`.

* `isBusy()`: reads the backend-derived `busy` boolean.

* `WorkerMode`: derived from `visible`, not stored.

* `isReadyForInput()`: mirrors the Python readiness predicate.

`AgenticProcess` TypeScript uses `session_id` as the canonical session field.
Some method parameters and comments still mention `workerSessionId` for
backward compatibility, but requests are mapped to backend `session_id` /
legacy `worker_session_id` handling.

### IEntity Legacy Fields

`ts_sdk/src/IEntity.ts` still exposes optional `vfs_record` and `vfs_orphan`
for older rows. New agent/session/process code should not use those fields for
record lookup.

***

## 11. Key Files Reference

### Python

| File                                                                     | Role                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `flow_sdk/fs_store/fs_record.py`                                         | `FSRecord` — the single record class: save/load/discover, hash sentinel, `sync_to_db` |
| `flow_sdk/fs_store/record_paths.py`                                      | Per-instance records / records\_data roots, `shadow_dir_for`, `data_dir_for`          |
| `flow_sdk/fs_store/record_ref.py`                                        | `RecordRef` / `RecordDataRef` helpers                                                 |
| `flow_sdk/fs_store/record_types.py`                                      | `RecordType` (alias of `EntityType`)                                                  |
| `flow_sdk/fs_store/indexer/functions/claude_sessions.py`                 | Claude session walker, lazy stats, status, transcript entries, discovery              |
| `flow_sdk/fs_store/indexer/functions/_claude_transcript.py`              | Claude transcript entry parsers (`create_transcript_entry`)                           |
| `flow_sdk/assets/types/claude_sessions.py`                               | `extract_claude_session_from_path` (cheap session `FSRecord` construction)            |
| `flow_sdk/assets/types/subagent.py`                                      | SubAgent Markdown parse/render, `load_subagent`, `subagent_to_cli_json`               |
| `flow_sdk/transcript_analyzer/worker_status.py`                          | `WorkerStatus`, running/terminal helper sets, `_tail_status()`                        |
| `flow_sdk/builtin/process_lifecycle.py`                                  | `ProcessStatus` and process lifecycle helper sets                                     |
| `flow_sdk/builtin/agentic_process/process_assets.py`                     | `ProcessAssets` — embedded skills / sub-agents, `--agents` JSON                       |
| `flow_sdk/builtin/agentic_process/agentic_process.py`                    | DB-backed `AgenticProcess` entity, mode routing, status projection                    |
| `flow_sdk/builtin/agentic_process/status_predicates.py`                  | `WorkerMode`, readiness predicate, status helper imports                              |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/driver.py`          | Claude driver, headless print-mode execution, transcript path/history                 |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/stream_worker.py`   | `claude -p --output-format stream-json` subprocess worker                             |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/session_history.py` | JSONL-to-FlowData history loading                                                     |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/cli.py`             | `ClaudeAgentOptions`, `--session-id`, `--resume`, `--fork-session` args               |
| `flow_sdk/builtin/shell.py`                                              | DB-backed `Shell` entity, PTY launch/read/write/runtime checks                        |
| `flow_sdk/builtin/faas/pty_actions.py`                                   | PTY creation, ShellRecord creation/update, replay/attach routes                       |
| `flow_sdk/core/entity/entity_model.py`                                   | `Entity.from_record()`, `get_record()`, `store()`, refresh                            |
| `flow_sdk/db/drivers/sqlite/sqlite_driver.py`                            | SQLite entity persistence and legacy VFS migration                                    |

### TypeScript SDK

| File                                                                 | Role                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ts_sdk/src/resource_management/fs_records/fs-record.ts`             | Client-side `FsRecord` base                                        |
| `ts_sdk/src/resource_management/fs_records/claude/claude-session.ts` | `ClaudeSessionRecord` and deprecated `ClaudeSessionFsRecord` alias |
| `ts_sdk/src/process/agentic-process.ts`                              | Client-side `AgenticProcess` entity wrapper                        |
| `ts_sdk/src/process/agentic-types.ts`                                | `ProcessStatus`, `WorkerStatus`, `WorkerMode`, readiness helpers   |
| `ts_sdk/src/IEntity.ts`                                              | Base entity interface with legacy VFS fields                       |

