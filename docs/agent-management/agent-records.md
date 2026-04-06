# Agent Records

Complete reference for the Records system as it relates to agent management: the base `Record` / `FsRecord` class, `ClaudeSessionFsRecord`, the `AgenticProcess` Record, and the `vfs_record` entity-record sync mechanism.

---

## Table of Contents

1. [Base Record Class](#1-base-record-class)
2. [ClaudeSessionFsRecord](#2-claudesessionfsrecord)
3. [AgenticProcess Record](#3-agenticprocess-record)
4. [AgentRecord](#4-agentrecord)
5. [Record–Entity Sync](#5-recordentity-sync)
6. [Read/Write Patterns](#6-readwrite-patterns)
7. [TypeScript SDK Counterparts](#7-typescript-sdk-counterparts)
8. [Key Files Reference](#8-key-files-reference)

---

## 1. Base Record Class

### Purpose

`Record` (in `flow_sdk/fs_store/record.py`) is the single base class for all filesystem-backed data in the system. Every agent session, task, skill, memo, and settings entry is a `Record`. It is not a dataclass; it uses a **single internal `_data` dict** for all fields with a transparent attribute interface on top.

The legacy names `FsRecord`, `ResourceRecord`, and `FsRecordRef` are aliases kept for backward compatibility:

```python
FsRecord = Record
FsRecordRef = RecordRef
ResourceRecord = Record
```

### Internal Storage

All fields — identity, audit, refs, and domain data — live in one dict:

```python
_data: dict[str, Any]  # id, type, name, status, created_at, ... plus all domain fields
```

There is no `_meta_data` dict and no `_data_dirty`/`_meta_dirty` flags. The `_META_FIELDS` frozenset (`{"id", "type", "name"}`) exists only to control which fields are written to `metadata.json` vs `_data.json` on disk — it has no effect on internal storage.

### On-Disk Layout

```
~/.flow/records/<type>/<type>-@<uid>/
  metadata.json       # Identity fields: id, type, name
  _data.json          # Domain fields: everything else
  state.json          # Per-record property cache (RecordState)
  <companion files>   # Type-specific (e.g., agent.md, SKILL.md)
  output/             # Generated output directory
```

The naming convention is `<type>-@<uid>`, built by `record_stem(record_type, uid)`. Legacy formats (`data.json` combined, `.flow_record/record.json`) are read-supported but auto-migrated to the split format on next save.

The default root is `~/.flow/records/`. It can be overridden for testing via `set_default_records_root(path)`.

### Fields

All fields are stored in `_data`. The `_ENTITY_META_FIELDS` frozenset (`{"id", "type", "name", "status", "created_at", "modified_at", "scope"}`) determines which fields are mirrored to the Entity DB via `sync_to_db()`.

| Property | Type | Description |
|----------|------|-------------|
| `id` | `str` | Unique identifier (auto-generated UUID if not set) |
| `type` | `str` | Record type string (e.g., `"task"`, `"session"`) |
| `name` | `str` | Human-readable name |
| `status` | `str | RecordStatus | None` | Lifecycle status |
| `scope` | `Scope | str` | Visibility scope (`user`, `project`, `managed`, etc.) |
| `created_at` | `datetime | None` | Creation timestamp |
| `modified_at` | `datetime | None` | Last modification timestamp |
| `created_by` | `str | None` | Creator identifier |
| `updated_by` | `str | None` | Last updater identifier |
| `parent_ref` | `RecordRef | None` | Reference to parent record |
| `children_refs` | `list[RecordRef]` | References to child records |
| `origin_ref` | `RecordRef | None` | Provenance pointer (set on clones) |
| `data_ref` | `RecordRef | None` | Pointer to external data source |

All of the above and any subclass-specific fields (`title`, `priority`, etc.) live in the same `_data` dict. Access is transparent via `__getattr__`/`__setattr__`:

```python
task = TaskResource(title="Fix bug", priority="high")
task.title      # reads _data["title"]
task.priority   # reads _data["priority"]
task.id         # reads _data["id"]
```

### Location Properties (not serialized)

| Property | Type | Description |
|----------|------|-------------|
| `source_file` | `str | None` | Path to the JSON file on disk |
| `path` | `str | None` | Path to the record folder |
| `record_dir` | `Path | None` | Computed directory from `path` or `source_file` |
| `default_path` | `Path | None` | Default path based on type + id |

### Constructor

The constructor accepts two calling forms:

```python
# 1. Empty record — generates UUID
record = Record()

# 2. Kwargs — all go into _data
record = Record(id="x", name="y", description="z")
```

All kwargs are stored in `_data`. A special kwarg `raw_json` merges a dict directly into `_data`.

### RecordStatus Enum

```python
class RecordStatus(str, Enum):
    CREATING = "creating"
    NEW      = "new"
    ACTIVE   = "active"
    ORPHAN   = "orphan"
```

### Read-Only Records

Subclasses set `_read_only: ClassVar[bool] = True` to prevent writes. `save()`, `clone()`, and `move()` raise `ReadOnlyRecordError`. Read-only records can still have writable metadata via the origin/meta pattern (see section 6).

### Auto-Registration

Setting `_record_type` on a subclass automatically registers it with `SchemaRegistry` via `__init_subclass__`. This enables polymorphic loading:

```python
record = Record.load(some_path)  # returns TaskResource, ClaudeSessionFsRecord, etc.
```

### RecordRef

`RecordRef` is a lightweight dataclass pointer to another record or external data source:

```python
@dataclass
class RecordRef:
    id: str = ""
    type: str = ""
    path: str | None = None          # filesystem path
    json_path: str | None = None     # RFC 6901 JSON Pointer
    key_field: str | None = None     # field name for array lookup
    key_value: str | None = None     # field value to match
    format: str | None = None        # "json" | "jsonl" | "yaml"
```

---

## 2. ClaudeSessionFsRecord

### Purpose

`ClaudeSessionFsRecord` (in `flow_sdk/fs_records/claude/claude_session.py`) represents a single Claude Code chat session. It is built by parsing the JSONL transcript file that Claude Code writes to disk.

It is **read-only** (`_read_only = True`). The source of truth is the JSONL file; the record is never written back.

### Source on Disk

```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

The project directory name is the absolute working directory with `/` replaced by `-`, e.g. `/Users/me/myproject` becomes `projects/-Users-me-myproject/`.

Each line in the JSONL file is a JSON object with a shared envelope plus a type-specific payload:

| Envelope field | Description |
|----------------|-------------|
| `sessionId` | UUID of the session |
| `cwd` | Working directory when the session started |
| `version` | Claude Code CLI version |
| `gitBranch` | Git branch at start |
| `slug` | Human-readable session slug |
| `timestamp` | ISO timestamp of the entry |
| `uuid` | UUID of this specific JSONL entry |
| `type` | Entry type: `"user"`, `"assistant"`, `"system"`, `"progress"`, etc. |

### Data Fields (populated by `from_jsonl`)

These are stored in `_data` after parsing the JSONL file:

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | `str` | UUID — also used as the record `id` |
| `cwd` | `str` | Working directory of the session |
| `version` | `str` | Claude Code CLI version |
| `git_branch` | `str` | Git branch at start |
| `slug` | `str` | Human-readable slug; falls back to session_id |
| `model` | `str | None` | Model used (from first assistant message) |
| `message_count` | `int` | Total user + assistant messages |
| `user_message_count` | `int` | User messages only |
| `assistant_message_count` | `int` | Assistant messages only |
| `input_tokens` | `int` | Cumulative input token usage |
| `output_tokens` | `int` | Cumulative output token usage |
| `cache_read_input_tokens` | `int` | Cache read tokens |
| `cache_creation_input_tokens` | `int` | Cache creation tokens |
| `duration_ms` | `int` | Total turn duration in milliseconds |
| `tools_used` | `list[str]` | Sorted list of tool names used |
| `has_plan` | `bool` | True if any user entry had `planContent` |
| `last_stop_reason` | `str | None` | Last assistant `stop_reason` from transcript |
| `jsonl_path` | `str` | Absolute path to the JSONL file |

### Status Derivation

`ClaudeSessionFsRecord.status` is a computed property — not stored in `_data`. It derives from `last_stop_reason`:

```python
@property
def status(self) -> Literal["idle", "running", "complete"]:
    if not self.data.get("assistant_message_count", 0):
        return "idle"
    last_stop_reason = self.data.get("last_stop_reason")
    if last_stop_reason in self.COMPLETE_STOP_REASONS:
        return "complete"
    return "running"
```

`COMPLETE_STOP_REASONS = {"end_turn", "stop_sequence"}`.

### Activity Check

`is_active(max_seconds=300)` checks whether the JSONL file's mtime is within the threshold:

```python
session.is_active()          # recent activity in last 5 minutes
session.is_active(max_seconds=60)  # recent activity in last 1 minute
```

### Transcript Entries

`transcript_entries` lazily reads the JSONL file and returns a list of `ClaudeTranscriptEntryFsRecord` objects. `filtered_entries` excludes noisy types (`"file-history-snapshot"`, `"progress"`).

```python
session = ClaudeSessionFsRecord.from_jsonl(path)
for entry in session.filtered_entries:
    print(entry.summary)   # one-line summary per entry
print(session.summary_log) # newline-joined summaries
```

### Discovery

```python
# Discover all sessions under ~/.claude/projects/
sessions = ClaudeSessionFsRecord.discover()

# Find a specific session by session ID (fast path requires project)
session = ClaudeSessionFsRecord.discover_one(
    uid=worker_session_id,
    project="/path/to/workdir",  # optional — avoids full scan
)
```

Without the `project` kwarg, `discover_one` falls back to scanning all project directories.

### ClaudeActiveSessionFsRecord

`ClaudeActiveSessionFsRecord` (in `flow_sdk/fs_records/claude/claude_active_session.py`) is a lighter variant that reads only the first 20 lines of the JSONL and checks the mtime threshold. Used for listing sessions that are currently running.

```python
rec = ClaudeActiveSessionFsRecord.from_jsonl(jsonl_path, max_active_seconds=300)
# Returns None if mtime > max_active_seconds ago
```

Fields include: `session_id`, `project`, `cwd`, `version`, `git_branch`, `slug`, `started_at`, `last_active`, `message_count`, `uptime`.

---

## 3. AgenticProcess Record

### Purpose

`AgenticProcess` (in `flow_sdk/fs_records/agentic_process.py`) is the filesystem Record counterpart to the `AgenticProcess` DB entity. It stores process lifecycle state as a record and can derive status by delegating to `ClaudeSessionFsRecord`.

This record type is distinct from the entity: the entity is SQLite-backed and survives server restarts; the record is a lightweight filesystem snapshot.

### Record Type

```python
class AgenticProcess(Record):
    _record_type: ClassVar[str] = RecordType.AGENTIC_PROCESS
```

Auto-registered in the type registry under `RecordType.AGENTIC_PROCESS`.

### ProcessorStatus Enum

```python
class ProcessorStatus(StrEnum):
    IDLE       = "idle"
    RUNNING    = "running"
    PAUSED     = "paused"
    STEPPING   = "stepping"
    COMPLETE   = "complete"
    ERROR      = "error"
    TERMINATED = "terminated"
```

### Constructor Default

```python
def __init__(self, **kwargs: Any):
    kwargs.setdefault("type", RecordType.AGENTIC_PROCESS)
    kwargs.setdefault("state", ProcessorStatus.IDLE)
    super().__init__(**kwargs)
```

The `state` field is stored in `_data` and defaults to `"idle"`.

### Status Discovery

`discover_status(worker_session_id?)` derives the process status by looking up the Claude session transcript:

```python
def discover_status(self, worker_session_id: str | None = None) -> ProcessorStatus:
    sid = worker_session_id or self.data.get("worker_session_id")
    if not sid:
        return ProcessorStatus.IDLE
    session = ClaudeSessionFsRecord.discover_one(sid)
    if not session:
        return ProcessorStatus.IDLE
    return ProcessorStatus(session.worker_status)
```

This is the same logic as the entity's `_discover_status_from_transcript()` — the record delegates to `ClaudeSessionFsRecord.status`.

### Serialization

`to_dict()` wraps `state` as a nested dict for FlowPad API compatibility:

```python
def to_dict(self) -> dict:
    d = super().to_dict()
    d["state"] = {"status": d.get("state", self.state)}
    return d
```

The API expects `state` to be `{"status": "idle"}`, not a plain string.

### Relationship to the DB Entity

The `AgenticProcess` entity (in `flow_sdk/builtin/agentic_processor.py`) is the authoritative representation. It has:

- `worker_session_id` — the bridge to the JSONL on disk
- `pty_pid` — the live PTY WebSocket session
- `state` — `ProcessorState` dict with `status`, `error`, `debug`, `stack`, `variables`
- `context_data` — all execution context (`workdir`, `model`, `permission_mode`, etc.)

The Record variant is a simpler read path used when a full DB entity is not needed.

---

## 4. AgentRecord

### Purpose

`AgentRecord` (in `flow_sdk/fs_records/agent_record.py`) stores a Claude Code sub-agent definition. It uses a dual-file layout: `record.json` for structured fields and a companion `.md` file for the system prompt.

```
agent-@my-agent/
  metadata.json    # identity fields: id, type, name
  _data.json       # domain fields: description, tools, model, etc.
  my-agent.md      # YAML frontmatter + system prompt body
```

### Record Type

```python
class AgentRecord(Record):
    _record_type: ClassVar[str] = RecordType.AGENT
```

### Fields (stored in `_data`)

| Field | Type | Description |
|-------|------|-------------|
| `description` | `str` | Agent description |
| `tools` | `list` | Allowed tool list |
| `disallowed_tools` | `list` | Blocked tool list (`disallowedTools` in JSON) |
| `model` | `str` | Model override |
| `color` | `str` | UI color |
| `permission_mode` | `str` | `permissionMode` in JSON |
| `max_turns` | `int` | `maxTurns` in JSON |
| `skills` | `list` | Associated skills |
| `mcp_servers` | `dict` | `mcpServers` in JSON |
| `hooks` | `dict` | Hook configuration |
| `memory` | `dict` | Memory settings |
| `background` | `str` | Background instructions |
| `isolation` | `dict` | Isolation settings |

The `prompt` property reads and writes the system prompt body to/from the companion `.md` file; it does not go into `_data` except as a fallback when `record_dir` is unavailable.

### Agent Loading Priority

```python
AgentRecord.load_agent(name, project_dir=None)
# Priority: project (.claude/agents/) > user (~/.claude/agents/) > system (system_assets/agents/)
```

### Claude Code `--agents` JSON

`to_agents_json()` produces the dict passed to the `--agents` CLI flag:

```python
agent.to_agents_json()
# Returns: {"my-agent": {"prompt": "...", "description": "...", "permissionMode": "...", ...}}
```

`from_agents_json(name, data)` creates an `AgentRecord` from that structure.

---

## 5. Record–Entity Sync

### Overview

`record_data_ref` is the link between the filesystem Record layer and the DB Entity layer. When set on an Entity, it identifies the Record on disk that the Entity mirrors.

```
Record (filesystem, source of truth)
    |
    |  rec.sync_to_db()  — explicit, called on every write
    v
Entity (DB, queryable index)
    |
    |  entity.store()    — writes meta fields back to Record on disk
    v
Record updated on disk
```

The sync is always explicit — there are no background watchers or auto-triggers on field access.

### Entity Fields

These fields are defined on the base `Entity` class in `flow_sdk/core/entity/entity_model.py`:

| Field | Type | Description |
|-------|------|-------------|
| `record_data_ref` | `str | None` | Record reference in `type/id` format (e.g. `"task/abc123"`) |
| `indexed_content` | `str | None` | FTS content from `record.content` — excluded from API responses |

The old `vfs_record` and `vfs_orphan` fields have been removed and migrated to `record_data_ref`.

### What Gets Synced (Record → Entity)

`_ENTITY_META_FIELDS` controls which Record fields are mirrored to the Entity via `rec.sync_to_db()` → `Entity.from_record()`:

| Record field | Entity field | Notes |
|---|---|---|
| `id` | `id` | Primary key |
| `type` | `type` | Record type string |
| `name` | `name` | Synced if non-empty |
| `status` | `status` | `RecordStatus.value` unwrapped to string |
| `created_at` | `created_date` | datetime mapping |
| `modified_at` | `updated_date` | datetime mapping |
| `scope` | — | Not synced |

Domain fields (everything else in `_data`) are not mirrored to the Entity.

### `rec.sync_to_db()` — Record → Entity

```python
await rec.sync_to_db()
```

Called after every write (fs-records POST/PUT, MCP flow_entity_crud create/update). Internally:
1. `Entity.from_record(self)` — upserts the Entity row from `record.meta_dict()`
2. `driver.fts_upsert(...)` — updates FTS5 if `self.content` is not None
3. `self.write_hash_file(...)` — records the content hash for staleness checks

### `entity.store()` — Entity → Record

```python
await entity.store()
```

Writes Entity meta fields back to the linked Record on disk. Used when an Entity mutation should propagate down to the file (e.g. graph API PUT). Reads the Record at `record_data_ref`, patches `name` and `status`, calls `record.save()`. Does **not** call `record.sync_to_db()` — no feedback loop.

### `entity.check_and_refresh_record()` — staleness check

```python
await entity.check_and_refresh_record()
```

If the Record on disk is newer than the Entity (mtime check), calls `record.sync_to_db()` to refresh. Triggered as a background task on `GET /api/v1/graph/<type>/<id>`.

### Sync Trigger Points

| Trigger | Direction | Call |
|---------|-----------|------|
| fs-records POST/PUT | Record → Entity | `rec.sync_to_db()` at call site |
| fs-records DELETE | Entity removed | `Entity.delete_by_record_ref()` before disk delete |
| listen webhook CREATE/UPDATE | Entity → FTS | `_fts_sync_entity(entity)` |
| listen webhook DELETE | FTS removed | `_fts_delete_entity(entity_id)` |
| MCP `flow_entity_crud` create/update | Record → Entity | `rec.sync_to_db()` |
| graph API `GET /<type>/<id>` | Record → Entity (if stale) | `entity.check_and_refresh_record()` (background) |
| graph API `PUT /<type>/<id>` | Entity → Record | `entity.store()` |

### Entity Creation from Record

Entities are created automatically by `rec.sync_to_db()` — no manual creation needed:

```python
rec = TaskRecord(name="My Task", status="new")
rec.save()
await rec.sync_to_db()  # creates or updates the Entity row
```

---

## 6. Read/Write Patterns

### Creating a Record

```python
from flow_sdk.fs_records import TaskResource

task = TaskResource(title="Fix bug", priority="high")
task.save()
# Writes to ~/.flow/records/task/task-@<uuid>/metadata.json + _data.json
```

For an explicit path:

```python
task.save_record_json("/my/custom/path/record.json")
```

### Loading a Record

```python
from flow_sdk.fs_store import Record

# Polymorphic (returns the correct subclass based on "type" in JSON)
record = Record.load("/path/to/record/dir")

# Typed load
task = TaskResource.init_record("/path/to/record/dir")
```

`init_record` accepts a directory, a `record.json` path, or a data dict + path.

### Discovery

```python
# All records of a type (directory scan)
tasks = TaskResource.discover()

# Single record by uid (O(1) path lookup)
task = TaskResource.discover_one("some-uid")
```

### Updating a Record

```python
task = TaskResource.init_record(path)
task.title = "Updated title"
task.save()
```

With `fs_sync=True`, writes happen automatically on every field assignment:

```python
task = TaskResource(title="Fix bug", fs_sync=True, source_file="/path/to/record.json")
task.title = "Updated"  # auto-saves immediately
```

### Deleting a Record

```python
task.delete()  # removes the folder from disk
```

For `StorageLayout.FOLDER` records, the entire directory is removed. For `StorageLayout.FILE` records, only the JSON file is removed.

### Loading a Claude Session

```python
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord

session = ClaudeSessionFsRecord.from_jsonl(
    "~/.claude/projects/-Users-me-myproject/<session-id>.jsonl"
)
print(session.status)      # "idle" | "running" | "complete"
print(session.message_count)
print(session.tools_used)
```

### Origin/Meta Pattern for Read-Only Records

Read-only records (sessions, settings) cannot be saved, but writable metadata can be attached:

```python
session = ClaudeSessionFsRecord.from_jsonl(path)

# Create or load a writable overlay at ~/.flow/records/session/session-@<id>/
meta = session.get_or_create_meta()
meta["rating"] = 5
meta["tags"] = ["important"]
meta.save()

# Read it back later
meta = session.meta
print(meta["rating"])  # 5
```

The meta record has the same `id` and `type` as the origin, with `origin_ref` pointing back to the JSONL.

### Serialization

```python
d = record.to_dict()     # flat dict, internal fields excluded
rec = Record.from_dict(d)  # reconstitute from flat dict
```

`to_dict()` excludes `source_file`, `path`, `entity_id`, `json_path`, `fs_sync`, and `storage_layout`.

---

## 7. TypeScript SDK Counterparts

### FsRecord Base Class

`FsRecord` (in `ts_sdk/src/resource_management/fs_records/fs-record.ts`) mirrors the Python `Record` class. It is not an `APIEntity`; all I/O goes through the backend compute node via `ActionInfo`.

```typescript
export class FsRecord implements IResource {
  static _recordType = '';
  static _readOnly = false;
  static _storageLayout: StorageLayout = StorageLayout.FILE;

  id = '';
  type = '';
  name = '';
  status?: ResourceStatus;
  scope: Scope | string = Scope.USER;
  source_file?: string;
  path?: string;
  raw_json?: Record<string, unknown>;
  // ...
}
```

CRUD methods call the backend fs-records action using the standard REST routing:

```typescript
await record.save();                        // POST /fs-records/{type}  (create/update)
await FsRecord.getById(computeNodeId, id);  // GET  /fs-records/{type}/{id}
await FsRecord.getAll(computeNodeId, opts); // GET  /fs-records/{type}
await record.delete();                      // DELETE /fs-records/{type}/{id}
```

### ClaudeSessionFsRecord (TypeScript)

`ClaudeSessionFsRecord` (in `ts_sdk/src/resource_management/fs_records/claude/claude-session.ts`) is the TypeScript counterpart. It is read-only and registered in the type registry.

```typescript
export class ClaudeSessionFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SESSION;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FILE;

  session_id = '';
  cwd?: string;
  version?: string;
  git_branch?: string;
  slug?: string;
  model?: string;
  message_count = 0;
  user_message_count = 0;
  assistant_message_count = 0;
  input_tokens = 0;
  output_tokens = 0;
  cache_read_input_tokens = 0;
  cache_creation_input_tokens = 0;
  duration_ms = 0;
  tools_used?: string[];
  has_plan = false;
  jsonl_path?: string;
  status?: ClaudeSessionStatus;        // 'idle' | 'running' | 'complete'
  last_stop_reason?: string;
}
```

### IEntity record_data_ref Field

`IEntity` (in `ts_sdk/src/IEntity.ts`) includes:

```typescript
/** Record reference in "type/id" format (e.g. "task/abc123") */
record_data_ref?: string;
```

The old `vfs_record` and `vfs_orphan` fields remain in `IEntity` for backward compatibility with older DB rows but are no longer written by new code.

---

## 8. Key Files Reference

### Python

| File | Role |
|------|------|
| `flow_sdk/fs_store/record.py` | `Record` base class, `RecordStatus`, `resolve_record_json()`, `record_stem()` |
| `flow_sdk/fs_store/record_ref.py` | `RecordRef` dataclass |
| `flow_sdk/fs_store/record_types.py` | `RecordType` string constants |
| `flow_sdk/fs_store/resource_record_list.py` | `ResourceRecordList` — one-record-per-file collection |
| `flow_sdk/fs_store/source_file_record_list.py` | `SourceFileRecordList` — multiple records from one file |
| `flow_sdk/fs_records/claude/claude_session.py` | `ClaudeSessionFsRecord` — JSONL reader, status derivation |
| `flow_sdk/fs_records/claude/claude_active_session.py` | `ClaudeActiveSessionFsRecord` — mtime-filtered active session |
| `flow_sdk/fs_records/claude/claude_transcript_entry.py` | `ClaudeTranscriptEntryFsRecord` — single JSONL line |
| `flow_sdk/fs_records/agentic_process.py` | `AgenticProcess` Record + `ProcessorStatus` enum |
| `flow_sdk/fs_records/agent_record.py` | `AgentRecord` — sub-agent definition with `.md` companion |
| `flow_sdk/fs_records/__init__.py` | Public exports for all record types |
| `flow_sdk/core/entity/entity_model.py` | `Entity` base class — `record_data_ref`, `from_record()`, `store()`, `check_and_refresh_record()` |
| `flow_sdk/builtin/faas/compute_node.py` | fs-records action — calls `rec.sync_to_db()` after create/update |
| `flow_sdk/app/actions/graph_crud_actions.py` | `handle_get_by_id()` — triggers `check_and_refresh_record()`; `handle_update()` — calls `entity.store()` |

### TypeScript SDK

| File | Role |
|------|------|
| `ts_sdk/src/resource_management/fs_records/fs-record.ts` | `FsRecord` base class |
| `ts_sdk/src/resource_management/fs_records/claude/claude-session.ts` | `ClaudeSessionFsRecord` |
| `ts_sdk/src/resource_management/fs_records/record-type-registry.ts` | Type string → class registry |
| `ts_sdk/src/resource_management/fs_records/fs-record-ref.ts` | `FsRecordRef` interface |
| `ts_sdk/src/IEntity.ts` | `IEntity` interface — includes `vfs_record` and `vfs_orphan` |

### Tests

| File | Role |
|------|------|
| `tests/unit/test_entity_record_sync.py` | 17 unit tests for `sync_record()`, `_apply_record_metadata()`, orphan handling |
| `tests/api/test_entity_record_sync.py` | 3 API integration tests for end-to-end sync via API reads |
