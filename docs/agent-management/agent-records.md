---

---

# Agent Records

Reference for the filesystem records and entity/runtime state used by agent
management. The important boundary is:

* Durable records and DB entities survive server restarts: `Record`,
  `AgenticProcessRecord`, `ShellRecord`, `ClaudeSessionRecord`, and the
  `AgenticProcess` / `Shell` entity rows.

* Live runtime state does not survive restarts: in-memory PTY handles, replay
  buffer chunks, `_PROMPT_LOCKS`, `_PROMPT_WORKERS`, live OS PIDs, and the
  cached compute-node binding on `Shell`.

* Claude conversation history is durable because Claude writes JSONL transcripts
  under `~/.claude/projects/...`, not because the live worker object is durable.

***

## Table of Contents

1. [Base Record Class](#1-base-record-class)
2. [ClaudeSessionRecord](#2-claudesessionrecord)
3. [AgenticProcessRecord](#3-agenticprocessrecord)
4. [Process and Worker Status](#4-process-and-worker-status)
5. [Transcript and History by Mode](#5-transcript-and-history-by-mode)
6. [Shell and PTY Runtime State](#6-shell-and-pty-runtime-state)
7. [AgentRecord](#7-agentrecord)
8. [Record-Entity Sync](#8-record-entity-sync)
9. [Read/Write Patterns](#9-readwrite-patterns)
10. [TypeScript SDK Counterparts](#10-typescript-sdk-counterparts)
11. [Key Files Reference](#11-key-files-reference)

***

## 1. Base Record Class

### Purpose

`Record` (in `flow_sdk/fs_store/record.py`) is the base class for
filesystem-backed metadata. It is not a dataclass and it no longer uses a
single internal `_data` dict for live storage.

Current storage model:

* Public fields are direct instance attributes.

* Dirty tracking is private and uses `_dirty_keys: set[str]`.

* `_data` remains only as a constructor compatibility argument.

* `.data` and `.raw_json` are read shims over `to_dict()`.

* The TypeScript client still uses `FsRecord` naming, and some
  record-specific Python aliases remain, such as `ClaudeSessionFsRecord`.
  The Python base class in `flow_sdk.fs_store` is now `Record`.

### On-Disk Layout

Default metadata root:

```text
~/.flow/records/<type>/<type>-@<uid>/
  metadata.json          # wrapped {"data": {...}} containing all public fields
  state.json             # per-record property/cache state
  <key>.json             # optional named FSRef children from _domain_fsref_keys
  output/                # default generated output directory for base Record
```

Record data/blob root:

```text
~/.flow/records_data/
```

`record_stem(record_type, uid)` builds `<type>-@<uid>`. Legacy
`.flow_record/record.json` and old `data.json` records are read and migrated to
`metadata.json` on load/save.

The records root defaults to `~/.flow/records/` and can be overridden with
`set_default_records_root(path)` or `FS_RECORD_PATH`. The data/blob root
defaults to `~/.flow/records_data/`.

### Serialization

`to_dict()` returns a flat dict of public fields. It excludes private fields and
location/runtime attributes such as `source_file`, `path`, `json_path`,
`fs_sync`, `storage_layout`, `raw_json`, and the persisted `system` value.
`system` is re-derived from source paths during serialization.

`meta_dict()` includes all non-`None` public fields from `to_dict()` and injects
`asset_ref` as a path string when the record has a private `_asset_ref`.

### Location Properties

| Property            | Type    | Description |                                                                    |
| ------------------- | ------- | ----------- | ------------------------------------------------------------------ |
| `source_file`       | \`str   | None\`      | Backing file path, often `metadata.json` or an external asset file |
| `path`              | \`str   | None\`      | Record folder path                                                 |
| `record_dir`        | \`Path  | None\`      | `path`, or `source_file.parent`                                    |
| `record_data_dir`   | \`Path  | None\`      | Alias for `record_dir`                                             |
| `default_path`      | \`Path  | None\`      | `records_root / type / <type>-@<id>`                               |
| `record_folder_ref` | \`FSRef | None\`      | FSRef for the metadata folder, lazily resolved from `default_path` |
| `asset_ref`         | \`FSRef | None\`      | External content ref, private in memory and serialized as a path   |

### Constructor

```python
record = Record()
record = Record(id="x", name="y", description="z")
record = Record(_data={"id": "x", "name": "y"})
record = Record(raw_json={"id": "x", "name": "y"})
```

All public kwargs become direct attributes. `source_file`, `path`, `fs_sync`,
refs, and legacy `_meta`/`raw_json` keys receive compatibility handling.

### RecordStatus Enum

`RecordStatus` is still the base lifecycle enum for generic records:

```python
class RecordStatus(str, Enum):
    CREATING = "creating"
    NEW = "new"
    ACTIVE = "active"
    ORPHAN = "orphan"
```

Agent processes do not use this enum for their container lifecycle; they use
`ProcessStatus` from `flow_sdk/fs_records/agentic_process_lifecycle.py`.

### Read-Only Records

Read-only enforcement is FSRef-level. A record is read-only when its `_asset_ref`
is read-only. `ClaudeSessionRecord` sets this explicitly so session records are
never saved back to Claude's JSONL transcript.

***

## 2. ClaudeSessionRecord

### Purpose

`ClaudeSessionRecord` (in
`flow_sdk/fs_records/claude/claude_session.py`) represents one Claude Code
session transcript.

`ClaudeSessionFsRecord` still exists, but only as a backward-compatible alias:

```python
ClaudeSessionFsRecord = ClaudeSessionRecord
```

Use `ClaudeSessionRecord` in new Python code. TypeScript mirrors this rename
with a deprecated `ClaudeSessionFsRecord` alias.

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

`from_jsonl(path)` is intentionally cheap:

* Reads the first 4 KB for `session_id`, `slug`, and `cwd`.

* Reads the last 16 KB for the latest `custom-title`.

* Sets `jsonl_path`, `source_file`, `path`, and `project_encoded_name`.

* Does not eagerly parse full stats such as token counts or message counts.

The constructor sets:

* `id = session_id`.

* `name = custom_title or slug or session_id`.

* `_asset_ref = FSRef(jsonl_path or "/", read_only=True)`.

### Lazy Data Fields

Aggregated fields are `_SessionStatsProp` descriptors. The first access parses
the JSONL once and caches the result on the instance as `_session_batch_stats`.

| Field                         | Type        | Notes                                    |                                             |
| ----------------------------- | ----------- | ---------------------------------------- | ------------------------------------------- |
| `session_id`                  | `str`       | Claude session UUID; also the record id  |                                             |
| `cwd`                         | `str`       | Session working directory                |                                             |
| `version`                     | `str`       | Claude Code CLI version                  |                                             |
| `git_branch`                  | `str`       | Git branch from transcript envelope      |                                             |
| `slug`                        | `str`       | Claude session slug                      |                                             |
| `model`                       | \`str       | None\`                                   | First/primary model seen in assistant usage |
| `message_count`               | `int`       | User plus assistant messages             |                                             |
| `user_message_count`          | `int`       | User messages                            |                                             |
| `assistant_message_count`     | `int`       | Assistant messages                       |                                             |
| `input_tokens`                | `int`       | Total input tokens                       |                                             |
| `output_tokens`               | `int`       | Total output tokens                      |                                             |
| `cache_read_input_tokens`     | `int`       | Cache-read input tokens                  |                                             |
| `cache_creation_input_tokens` | `int`       | Cache-creation input tokens              |                                             |
| `duration_ms`                 | `int`       | Total turn duration                      |                                             |
| `tools_used`                  | `list[str]` | Tool names                               |                                             |
| `has_plan`                    | `bool`      | True if transcript includes plan content |                                             |
| `last_stop_reason`            | \`str       | None\`                                   | Last assistant stop reason                  |
| `project_encoded_name`        | `str`       | Encoded project directory name           |                                             |
| `last_user_message`           | \`str       | None\`                                   | Last user text                              |
| `modified_at`                 | \`str       | None\`                                   | Derived from transcript/file metadata       |
| `task_path`                   | \`str       | None\`                                   | Claude task/todo path when available        |
| `estimated_cost_usd`          | `float`     | Estimated session cost                   |                                             |
| `models_used`                 | `list[str]` | All models encountered                   |                                             |
| `primary_model`               | \`str       | None\`                                   | Primary model                               |
| `created_at`                  | \`str       | None\`                                   | First transcript timestamp                  |

`to_dict()` includes all lazy properties and therefore triggers the batch parse
on first call. `meta_dict()` has a fast path that avoids the full parse during
bulk indexing.

### Status

`ClaudeSessionRecord.status` is not stored. It is derived from the transcript
tail by `flow_sdk/fs_records/agent_status.py::_tail_status()`.

```python
@property
def status(self) -> WorkerStatus:
    path = self.jsonl_path
    if not path:
        return WorkerStatus.IDLE
    return _tail_status(path)
```

This is the current source of worker status. It is no longer the older
`"idle" | "running" | "complete"` derivation based only on `last_stop_reason`.

### Transcript Entries

`transcript_entries` lazily reads the full JSONL file and returns
`ClaudeTranscriptEntryFsRecord` instances through
`transcript_records.create_transcript_entry()`.

`filtered_entries` excludes noisy entry types:

```python
EXCLUDED_ENTRY_TYPES = ["file-history-snapshot", "progress"]
```

`summary_log` is a newline-joined summary of filtered entries.

### Discovery

```python
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

sessions = ClaudeSessionRecord.discover(limit=50)

session = ClaudeSessionRecord.get(
    uid,
    project="/path/to/workdir",  # optional O(1) project lookup
)
```

Without `project`, `get()` scans all project directories under
`~/.claude/projects/`.

### Active Sessions

`ClaudeActiveSessionFsRecord` remains the lightweight active-session view in
`flow_sdk/fs_records/claude/claude_active_session.py`. It reads at most the
first 20 lines and returns `None` if the JSONL mtime is older than
`max_active_seconds`.

***

## 3. AgenticProcessRecord

### Purpose

`AgenticProcessRecord` (in
`flow_sdk/fs_records/agentic_process_record.py`) is the filesystem record for
agent process metadata and per-process execution folders.

The old import name `flow_sdk.fs_records.AgenticProcess` is a compatibility
alias to `AgenticProcessRecord`. The DB-backed runtime entity is a different
class: `flow_sdk/builtin/agentic_process/agentic_process.py::AgenticProcess`.

### Record Type

```python
class AgenticProcessRecord(Record):
    _record_type = RecordType.AGENTIC_PROCESS
    _indexed_by_default = False
    _record_ttl = 30.0
```

### Constructor Defaults and Legacy Fields

Current defaults:

```python
kwargs.setdefault("type", RecordType.AGENTIC_PROCESS)
kwargs.setdefault("status", ProcessStatus.NEW)
kwargs.setdefault("pty_pid", None)
kwargs.setdefault("shell_id", None)
kwargs.setdefault("project_encoded_name", None)
kwargs.setdefault("project_id", None)
```

Legacy field migration:

```python
if "pty_session_id" in kwargs and "pty_pid" not in kwargs:
    kwargs["pty_pid"] = kwargs.pop("pty_session_id")
```

Important naming:

* `status` is the stored process-container lifecycle and uses `ProcessStatus`.

* `pty_pid` replaced old `pty_session_id`.

* `shell_id` links to the `Shell` entity.

* `worker_session_id` still exists on the record for backward compatibility and
  for `discover_worker_status()`, but the current `AgenticProcess` entity uses
  `session_id` as the canonical Claude/Codex session field.

* HTTP `open` still accepts legacy `worker_session_id` in the body and maps it
  to entity `session_id`.

### Execution Folder Layout

Per-process artifacts live under the record folder:

```text
~/.flow/records/agentic_process/agentic_process-@<id>/
  metadata.json
  state.json
  execution/
    input/
    output/
    assets/
```

`AgenticProcessRecord` overrides the base directory helpers so `input_dir`,
`output_dir`, and `assets_dir` are under `execution/`.

The folder FSRefs are exposed through:

* `exe_folder`

* `input_folder`

* `output_folder`

* `assets_folder`

`meta_dict()` injects these FSRef dictionaries for Entity consumers.

### Computed Record Properties

`AgenticProcessRecord` defines TTL-backed `PropertyRecord` descriptors:

| Property    | TTL | Source                                                                              |
| ----------- | --: | ----------------------------------------------------------------------------------- |
| `is_active` | 30s | Linked `ClaudeSessionRecord.is_active`                                              |
| `queue`     |  5s | `queue.json` in the record folder, defaulting to `{"enabled": True, "entries": []}` |

### Worker Status Discovery

```python
def discover_worker_status(worker_session_id: str | None = None) -> WorkerStatus:
    sid = worker_session_id or self.worker_session_id
    if not sid:
        return WorkerStatus.IDLE
    session = ClaudeSessionRecord.get(sid)
    return session.status if session else WorkerStatus.IDLE
```

`discover_status()` is a backward-compatible alias to
`discover_worker_status()`.

For current `AgenticProcess` entities, prefer the entity's `session_id` and pass
it explicitly when using this record helper:

```python
record.discover_worker_status(process.session_id)
```

***

## 4. Process and Worker Status

Agent management uses a two-axis status model.

### ProcessStatus

`ProcessStatus` lives in
`flow_sdk/fs_records/agentic_process_lifecycle.py`. It is the app/user-level
lifecycle of the process container and is stored on the `AgenticProcess` entity
and `AgenticProcessRecord.status`.

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

`WorkerStatus` lives in `flow_sdk/fs_records/agent_status.py`. It is the
expert-level state of the worker inside the process and is derived from the
transcript JSONL tail. It is not stored.

```python
class WorkerStatus(StrEnum):
    INITIALIZING = "initializing"
    IDLE = "idle"
    COMPLETE = "complete"
    ERROR = "error"
    INTERRUPTED = "interrupted"
    INACTIVE = "inactive"
    WAITING = "waiting"
    THINKING = "thinking"
    TOOL_CALL = "tool_call"
    TOOL_RUNNING = "tool_running"
    API_ERROR = "api_error"
    API_TIMEOUT = "api_timeout"
    UNKNOWN = "unknown"
```

Helper sets:

* Running worker statuses: `WAITING`, `THINKING`, `TOOL_CALL`,
  `TOOL_RUNNING`, `API_ERROR`.

* Busy worker statuses: `THINKING`, `TOOL_CALL`, `TOOL_RUNNING`.

* Terminal worker statuses: `COMPLETE`, `ERROR`, `INTERRUPTED`, `INACTIVE`,
  `API_TIMEOUT`.

### Tail Status Algorithm

`_tail_status(path)` reads the last 4 KB of the JSONL and checks file mtime.
The key classifications are:

| Condition                                                  | WorkerStatus   |
| ---------------------------------------------------------- | -------------- |
| JSONL missing                                              | `INITIALIZING` |
| `last-prompt` after an assistant turn with no pending tool | `COMPLETE`     |
| pending tool after assistant `stop_reason == "tool_use"`   | `TOOL_RUNNING` |
| last user text contains `interrupted`                      | `INTERRUPTED`  |
| last assistant `stop_reason == "end_turn"`                 | `COMPLETE`     |
| last assistant `stop_reason == "stop_sequence"`            | `ERROR`        |
| file stale for more than 5 minutes with no terminal signal | `INACTIVE`     |
| active `system` entry with subtype `api_error`             | `API_ERROR`    |
| active assistant entry with no stop reason                 | `THINKING`     |
| active assistant `stop_reason == "tool_use"`               | `TOOL_CALL`    |
| active `progress` entry                                    | `TOOL_RUNNING` |
| active `user` entry newer than 30s                         | `WAITING`      |
| active `user` entry older than 30s                         | `API_TIMEOUT`  |
| unrecognized tail                                          | `UNKNOWN`      |

### Entity Projection

`AgenticProcess.to_dict()` and its API serializer add:

* `worker_status`: derived by `self.driver.tail_status(transcript_path)`.

* `ready_for_input`: derived by
  `flow_sdk/builtin/agentic_process/status_predicates.py::is_ready_for_input()`.

Readiness contract:

```text
process.status == RUNNING
AND worker_status in {IDLE, COMPLETE, INTERRUPTED}
```

If there is no transcript yet, a process with no `session_id` is treated as
ready; a process with a `session_id` is treated as busy until a transcript is
found or the driver reports a status.

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
self.driver.run_print_turn(self, instruction)
```

For Claude, `ClaudeDriver.run_print_turn()`:

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

In both paths, `ClaudeCliOptions` carries `process.session_id` into the CLI as
`--session-id` or `--resume`, so Claude writes the same JSONL transcript shape
used by headless mode.

Durable storage in this mode:

* `AgenticProcess` DB row: `session_id`, `shell_id`, lifecycle `status`,
  `visible`, `cli_config`, etc.

* `Shell` DB row: tab metadata, `pty_pid`, `worker_pid`, `worker_name`,
  `last_launch_cmd`, workdir, env, tab order.

* `ShellRecord`: shell record metadata and the `.pty` stream file.

* Claude JSONL transcript.

Non-durable live state in this mode:

* Provider-owned live PTY handle.

* In-memory replay buffer chunks.

* Actual OS process liveness behind `worker_pid` / PTY PID.

* Cached compute-node binding on the `Shell` instance.

Completion handling:

* `_poll_for_completion()` polls `ClaudeSessionRecord.get(session_id).status`
  until a terminal worker status, then sets lifecycle `status` to `STOPPED`.

* The PTY exit callback also updates the process lifecycle and indexes the
  `ClaudeSessionRecord` on close.

Resume and fork:

* `AgenticProcess.resume(session_id)` pre-bakes `--resume <session_id>`.

* `AgenticProcess.fork(session_id)` pre-bakes
  `--resume <source> --fork-session --session-id <new>`.

* When resuming/forking, the code tries to find the source
  `ClaudeSessionRecord` and uses its `cwd` as `CLAUDE_PROJECT_DIR` / workdir.

***

## 6. Shell and PTY Runtime State

### Shell Entity

`Shell` (in `flow_sdk/builtin/shell.py`) is the DB-backed metadata layer for a
terminal tab / PTY session.

It stores queryable metadata such as:

* `id`: also the shell/PTY session id.

* `status`: `idle`, `running`, or `closed`.

* `workdir`, `env`, `name`, `tab_order`.

* `pty_pid`: PTY session id; currently set to the shell id by `Shell.start()`.

* `compute_node_id` and `compute_node_uname`.

* `worker_pid`, `worker_name`, and `last_launch_cmd`.

* `collaboration_room_id`.

The entity does not own the PTY bytes. It locates the live PTY through the
linked compute node.

### ShellRecord

`ShellRecord` (in `flow_sdk/fs_records/shell_record.py`) persists shell session
metadata and the durable PTY stream path.

Constructor migrations:

```python
pty_session_id -> pty_pid
process_id -> agentic_process_id
state -> status
```

Defaults:

```python
status = ShellStatus.IDLE
pty_pid = id
agentic_process_id = None
workdir = None
name = None
tab_order = 0
created_at = now
last_active_at = now
```

The PTY stream file lives under the records data root:

```text
~/.flow/records_data/shell/shell-@<shell-id>/<pty_pid>.pty
```

`Shell.read()` reads this file through `ShellRecord.pty_stream_ref`. `Shell.output()`
streams from the live PTY handle and therefore only works while the PTY exists.

### Runtime Boundary

Do not treat `ShellRecord`, `Shell.pty_pid`, or `Shell.worker_pid` as proof that
a process is still alive. They are durable hints used for recovery and
reattachment. The current live state is checked through:

* `Shell.has_attachable_pty()`

* `Shell.is_alive`

* `Shell.worker_alive()`

* compute-provider PTY lookups

* `psutil` PID checks

`Shell.stop()` kills the PTY and leaves the shell entity. `Shell.close()` is
permanent teardown: kill/close PTY, delete the `ShellRecord`, and delete the
`Shell` entity.

***

## 7. AgentRecord

`AgentRecord` (in `flow_sdk/fs_records/agent_record.py`) stores a Claude Code
sub-agent definition. It remains a filesystem record with a companion Markdown
prompt file.

Typical layout:

```text
agent-@my-agent/
  metadata.json
  my-agent.md
```

`prompt` is read from and written to the companion `.md` file when the record
has a folder. Structured fields such as `description`, `tools`,
`disallowed_tools`, `model`, `permission_mode`, `max_turns`, `skills`,
`mcp_servers`, `hooks`, `memory`, `background`, and `isolation` are stored as
record fields.

`AgentRecord.load_agent(name, project_dir=None)` searches project, user, and
system agent locations. `to_agents_cli_json()` returns the dict passed to
Claude's `--agents` flag.

***

## 8. Record-Entity Sync

### Current Model

Records and entities are synchronized explicitly. There are no background file
watchers triggered by field access.

```text
Record.sync_to_db()
  -> Entity.from_record(record)
  -> entity.save()
  -> record.sync_from_entity(entity)
  -> FTS upsert from record search fields

Entity.store()
  -> record_cls.get(entity.id) or record_cls(id=entity.id)
  -> record.sync_from_entity(entity)
  -> record.save()
```

Current `Entity.get_record()` resolves by entity type and id through
`SchemaRegistry`, not through a `vfs_record` field.

### Record -> Entity

`Record.sync_to_db()` calls `Entity.from_record(self)`.

`Entity.from_record()`:

* Chooses the entity class registered for `record.type`.

* Starts from `record.meta_dict()`.

* Allocates a stable entity id with the entity class.

* Creates or updates the entity.

* For specialized entity classes, pulls matching domain fields from
  `record.to_dict()` only when needed.

* Saves the entity.

`Record.sync_to_db()` then:

* Writes entity metadata back to the record via `sync_from_entity()`.

* Upserts FTS using `search_title`, `search_description`, and `search_content`.

* Records errors as `RecordError` on failure.

### Entity -> Record

`Entity.store()` / `_store()`:

* Looks up the record class for `entity.get_type()`.

* Loads the record by `entity.id`, or creates `record_cls(id=entity.id)` if no
  record exists yet.

* Calls `record.sync_from_entity(entity)` in a worker thread.

* Updates FTS if the record exposes `search_content`.

`Record.sync_from_entity(entity)` uses `entity.db_json()`, ignores private,
DB-excluded, and `None` fields, and writes only changed values. It is a no-op
for read-only records and source-file sub-records with `json_path`.

### Legacy VFS Fields

Older code used `vfs_record` and `vfs_orphan`. SQLite has a migration that
extracts old `vfs_record` values into a `record_data_ref` column and removes
`vfs_record` / `vfs_orphan` from the JSON data blob. Current record/entity
loading for these agent records is type/id based.

***

## 9. Read/Write Patterns

### Generic Record

```python
from flow_sdk.fs_store import Record

record = Record(type="task", name="Example")
record.save()

loaded = Record.load(record.default_path)
```

`save()` writes the folder-layout `metadata.json` under the record's
`default_path` unless the record is explicitly bound to a simple JSON
`source_file`.

### Claude Session

```python
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

session = ClaudeSessionRecord.from_jsonl(
    "~/.claude/projects/-Users-me-myproject/<session-id>.jsonl"
)

print(session.status)          # WorkerStatus
print(session.message_count)   # triggers lazy stats parse
print(session.tools_used)
```

Sessions are read-only. To find an existing session:

```python
session = ClaudeSessionRecord.get("<session-id>", project="/abs/workdir")
```

### Agentic Process Record

```python
from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord

record = AgenticProcessRecord(id="<process-id>")
record.path = str(record.default_path)

print(record.input_dir)
print(record.output_dir)
print(record.assets_dir)
```

For status projection from a current `AgenticProcess` entity:

```python
worker_status = record.discover_worker_status(process.session_id)
```

### Shell Output

```python
shell_bytes = await shell.read()   # durable .pty stream file if present
live_stream = shell.output()       # live PTY stream; empty if no live PTY
```

Use `Shell.has_attachable_pty()` or `Shell.worker_alive()` to check live state.

***

## 10. TypeScript SDK Counterparts

### FsRecord

`ts_sdk/src/resource_management/fs_records/fs-record.ts` mirrors the Python
record API for client-side calls. It is not an `APIEntity`; CRUD goes through
backend actions.

Current action subpaths:

```typescript
await record.save();                        // fs-records/save
await FsRecord.getById(computeNodeId, id);  // fs-records/get_by_id
await FsRecord.getAll(computeNodeId, opts); // fs-records/get_all
await record.delete();                      // fs-records/delete
```

### ClaudeSessionRecord

`ts_sdk/src/resource_management/fs_records/claude/claude-session.ts` now exports
`ClaudeSessionRecord` as the canonical class and keeps
`ClaudeSessionFsRecord` as a deprecated alias.

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
  `inactive`, `waiting`, `thinking`, `tool_call`, `tool_running`,
  `api_error`, `api_timeout`, `unknown`.

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

| File                                                                     | Role                                                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `flow_sdk/fs_store/record.py`                                            | Base `Record`, direct-attribute storage, folder save/load, sync helpers           |
| `flow_sdk/fs_store/record_ref.py`                                        | `RecordRef` / `RecordDataRef` helpers                                             |
| `flow_sdk/fs_store/record_types.py`                                      | `RecordType` constants                                                            |
| `flow_sdk/fs_records/claude/claude_session.py`                           | `ClaudeSessionRecord`, lazy stats, transcript entries, status from `_tail_status` |
| `flow_sdk/fs_records/claude/claude_active_session.py`                    | Active-session lightweight record                                                 |
| `flow_sdk/fs_records/claude/claude_transcript_entry.py`                  | Transcript entry re-exports                                                       |
| `flow_sdk/fs_records/claude/transcript_records/`                         | Type-specific Claude transcript record parsers                                    |
| `flow_sdk/fs_records/agent_status.py`                                    | `WorkerStatus`, status helper sets, `_tail_status()`                              |
| `flow_sdk/fs_records/agentic_process_lifecycle.py`                       | `ProcessStatus` and process lifecycle helper sets                                 |
| `flow_sdk/fs_records/agentic_process_record.py`                          | `AgenticProcessRecord`, execution folders, legacy field migration                 |
| `flow_sdk/fs_records/shell_record.py`                                    | `ShellRecord`, `ShellStatus`, durable `.pty` stream path                          |
| `flow_sdk/builtin/agentic_process/agentic_process.py`                    | DB-backed `AgenticProcess` entity, mode routing, status projection                |
| `flow_sdk/builtin/agentic_process/status_predicates.py`                  | `WorkerMode`, readiness predicate, status helper imports                          |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/driver.py`          | Claude driver, headless print-mode execution, transcript path/history             |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/stream_worker.py`   | `claude -p --output-format stream-json` subprocess worker                         |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/session_history.py` | JSONL-to-FlowData history loading                                                 |
| `flow_sdk/builtin/agentic_process/cli_drivers/claude/cli.py`             | `ClaudeCliOptions`, `--session-id`, `--resume`, `--fork-session` args             |
| `flow_sdk/builtin/shell.py`                                              | DB-backed `Shell` entity, PTY launch/read/write/runtime checks                    |
| `flow_sdk/builtin/faas/pty_actions.py`                                   | PTY creation, ShellRecord creation/update, replay/attach routes                   |
| `flow_sdk/core/entity/entity_model.py`                                   | `Entity.from_record()`, `get_record()`, `store()`, refresh                        |
| `flow_sdk/db/drivers/sqlite/sqlite_driver.py`                            | SQLite entity persistence and legacy VFS migration                                |

### TypeScript SDK

| File                                                                 | Role                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ts_sdk/src/resource_management/fs_records/fs-record.ts`             | Client-side `FsRecord` base                                        |
| `ts_sdk/src/resource_management/fs_records/claude/claude-session.ts` | `ClaudeSessionRecord` and deprecated `ClaudeSessionFsRecord` alias |
| `ts_sdk/src/process/agentic-process.ts`                              | Client-side `AgenticProcess` entity wrapper                        |
| `ts_sdk/src/process/agentic-types.ts`                                | `ProcessStatus`, `WorkerStatus`, `WorkerMode`, readiness helpers   |
| `ts_sdk/src/IEntity.ts`                                              | Base entity interface with legacy VFS fields                       |

