---
id: 305e2927-497f-554c-b0d4-d307d3c921fa
---

# fs_store: Record System Architecture

The `flow_sdk.fs_store` package provides file-system backed records. There is no single `FsStore` class — the package is a collection of modules that together provide record storage, indexing, querying, and lifecycle management. Every entity in the system (skills, tasks, sessions, hooks, settings entries) is a `Record`.

## Core Design

### Single base class: `Record`

All records extend a single `Record` class (in `flow_sdk/fs_store/record.py`). It is **not a dataclass**. Internally it uses a **single** `_data` dict that holds all fields — identity, audit, and domain data together:

```python
_data: dict[str, Any]  # All fields: id, type, name, status, plus domain fields
```

A `_META_FIELDS` frozenset (`{"id", "type", "name"}`) is used only for split-format file writes (separating `metadata.json` from `_data.json` on disk), not for internal storage separation.

### RecordRef

`RecordRef` (in `record_ref.py`) is a lightweight `@dataclass` pointer to another record or external data source:

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

Used for parent/child relationships, clone provenance (`origin_ref`), and pointers to external data files (`data_ref`).

## On-Disk Layout

### Folder layout (default, split format)

```
~/.flow/records/<type>/<type>-@<uid>/
  metadata.json    # Identity fields: {data: {id, type, name}}
  _data.json       # Domain fields: {data: {status, title, ...}}
  data.json        # Legacy fallback (read-only, for backward compat)
  state.json       # Per-record property cache (RecordState)
  SKILL.md         # Companion files (type-specific)
  output/          # Generated output directory
```

The naming convention is `<type>-@<uid>` (e.g., `task-@abc123`, `skill-@my-skill`).

**Migration path**: Old records stored data in `.flow_record/record.json`. The `_migrate_old_format()` function reads this legacy format and writes `data.json` in the wrapped `{"data": {...}}` format. New records use the split format (`metadata.json` + `_data.json`).

### File layout

```
~/.flow/records/<type>/
  <type>-@<uid>.json   # Standalone JSON file per record
```

Controlled by `StorageLayout.FOLDER` vs `StorageLayout.FILE`.

### Source file records (external data)

Some records are extracted from external JSON files (e.g., Claude's `settings.json`). These use `SourceFileRecordList` and each record tracks its position via `json_path` (RFC 6901 pointer) and `source_file`.

## Record Properties

All fields are stored in the single `_data` dict. Access is transparent via `__getattr__`/`__setattr__`:

### Identity and audit fields

| Property | Type | Description |
|----------|------|-------------|
| `id` | `str` | Unique identifier (auto-generated UUID if not set) |
| `type` | `str` | Record type string (e.g., "task", "skill", "session") |
| `name` | `str` | Human-readable name |
| `status` | `str \| RecordStatus` | Record lifecycle status |
| `scope` | `Scope \| str` | Visibility scope (user, project, managed, etc.) |
| `created_at` | `datetime \| None` | Creation timestamp |
| `modified_at` | `datetime \| None` | Last modification timestamp |
| `created_by` | `str \| None` | Creator identifier |
| `updated_by` | `str \| None` | Last updater identifier |
| `parent_ref` | `RecordRef \| None` | Reference to parent record |
| `children_refs` | `list[RecordRef]` | References to child records |
| `origin_ref` | `RecordRef \| None` | Provenance (set on clones) |
| `data_ref` | `RecordRef \| None` | Pointer to external data source |

### Domain properties

Everything that isn't an identity/audit field also goes into `_data`. Access is transparent:

```python
task = TaskResource(title="Fix bug", priority="high")
task.title      # reads from _data["title"]
task.priority   # reads from _data["priority"]
task.id         # reads from _data["id"]
```

### Key-value access

Records also support dict-style access for backward compatibility:

```python
record["custom_field"] = 42       # writes to _data
record["name"] = "updated"        # writes to _data (name is in _data too)
del record["custom_field"]        # deletes from _data
"custom_field" in record           # checks _data
record.keys()                      # all _data keys
```

### Location properties (instance attributes, not serialized)

| Property | Type | Description |
|----------|------|-------------|
| `source_file` | `str \| None` | Path to the JSON file on disk |
| `path` | `str \| None` | Path to the record directory |
| `record_dir` | `Path \| None` | Computed directory from path or source_file |
| `default_path` | `Path \| None` | Default storage location based on type + id |

## RecordState (Per-Record State Cache)

**Important**: This is NOT the SQLite Entity index. See [entity-index-sync.md](data-management/entity-index-sync.md) for the Entity/FTS indexing system.

`RecordState` (`flow_sdk/fs_store/record_state.py`) manages a per-record `state.json` file that stores:
- **Discovery state**: whether the record has been discovered (timestamp)
- **PropertyRecord cached values**: TTL-based computed property results

### state.json Format

```json
{
  "fields": {
    "is_active": { "type": "property", "ttl": -1, "computed_at": "2026-03-15T...", "value": true },
    "errors": { "type": "property", "ttl": 60, "computed_at": "2026-03-15T...", "errors": [] }
  },
  "meta": { "id": "abc123", "type": "task", "name": "Fix bug" }
}
```

### API

| Method | Description |
|--------|-------------|
| `is_discovered()` | True if state.json was loaded and contains a discovery timestamp |
| `mark_discovered()` | Set discovered_at to now |
| `get_property(key)` | Return cached entry dict for key, or None |
| `set_property(key, entry)` | Store a computed entry dict |
| `load()` | Read state.json from disk (handles old format migration) |
| `save(meta=None)` | Write state.json to disk, optionally with meta dict |

### When RecordState is updated

- **`Record.save()`** — syncs meta fields (id, type, name) to state.json
- **`Record.discovery(force, recursive)`** — runs PropertyRecord discoveries, writes results to state.json
- **`Record.get_prop(key)`** — auto-recomputes expired TTL entries, writes state.json
- Lazy-loaded on first access via `Record._get_state()`

## PropertyRecord (TTL-Cached Computed Properties)

`PropertyRecord` (`flow_sdk/fs_store/property_record.py`) is a descriptor for TTL-cached computed properties on Record subclasses. Values are stored in the record's `RecordState`.

### Usage

```python
class MyRecord(Record):
    is_active = PropertyRecord(ttl=-1, discovery=lambda r: check_active(r))
    errors    = PropertyRecord(ttl=60, list_key="errors", discovery=lambda r: get_errs(r))

record.is_active   # bool, TTL-cached, never expires (ttl=-1)
record.errors      # list, TTL-cached, expires after 60 seconds
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `ttl` | `float` | Cache duration in seconds. `-1` = never expires. Default: 300s |
| `default` | `Any` | Default value if discovery returns nothing |
| `list_key` | `str \| None` | Named key in state.json entry (for list values) |
| `discovery` | `Callable` | Function to compute the value, receives the Record instance |

### How it works

1. `PropertyRecord.__set_name__` registers the descriptor in the class's `_property_types` dict
2. `PropertyRecord.__get__` calls `instance.get_prop(key)` which checks RecordState for cached value
3. If absent or TTL-expired, runs `descriptor.run_discovery(instance)`, caches result in RecordState, saves state.json
4. Returns the cached value

## Creating Subclasses

### Owned/writable records

For entities where we control the data (tasks, skills, memos):

```python
class TaskResource(Record):
    _record_type: ClassVar[str] = RecordType.TASK  # auto-registers with SchemaRegistry

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.TASK)
        kwargs.setdefault("status", TaskStatus.TO_DO)
        super().__init__(**kwargs)
```

Domain fields are accessed transparently via `__getattr__`:

```python
task = TaskResource(title="Fix bug", priority="high")
task.title      # "Fix bug" — reads _data["title"]
task.save()     # persists to ~/.flow/records/task/task-@<id>/
```

No need for `@property` boilerplate on simple fields. Use explicit properties only when you need validation or computed values.

### Read-only records (external data)

For entities whose data lives in external files (Claude sessions, settings):

```python
class ClaudeSessionFsRecord(Record):
    _read_only: ClassVar[bool] = True

    def __init__(self, **kwargs):
        kwargs.setdefault("type", RecordType.SESSION)
        super().__init__(**kwargs)
```

Read-only records raise `ReadOnlyRecordError` on `save()`, `clone()`, or `move()`. They can still have writable metadata via the `.meta` / `.get_or_create_meta()` pattern (see below).

### Auto-registration

Setting `_record_type` on a subclass automatically registers it with `SchemaRegistry` via `__init_subclass__`. This enables polymorphic loading:

```python
record = Record.load(some_path)  # returns TaskResource, SkillRecord, etc.
```

## CRUD Operations

### Single record

```python
# Create
record = TaskResource(title="Fix bug")
record.save()                           # to default path

# Load
loaded = Record.load(path)              # polymorphic
loaded = TaskResource.init_record(path) # typed

# Update
loaded.title = "Fix critical bug"
loaded.save()

# Delete
loaded.delete()                         # removes from disk
```

### Discovery

```python
# Find all records of a type on disk (directory scan)
tasks = TaskResource.discover()                    # list[TaskResource]
task = TaskResource.discover_one("some-uid")       # O(1) path lookup

# Run property discovery on a record (compute + cache PropertyRecord values)
record.discovery(force=False, recursive=False)
```

### Collections

**RecordList** — storage-agnostic typed collection (preferred):

```python
from flow_sdk.fs_store import RecordList

tasks = RecordList(record_class=TaskResource)
tasks.create(TaskResource(title="New task"))
task = tasks.get("some-uid")
tasks.update("some-uid", {"title": "Updated"})
tasks.delete("some-uid")

# Query with RecordQuery
from flow_sdk.fs_store import RecordQuery
results = tasks.query(RecordQuery(status="active", limit=10, sort_by="modified_at"))
```

**ResourceRecordList** — one record per file/folder on disk:

```python
from flow_sdk.fs_store import ResourceRecordList, StorageLayout

tasks = ResourceRecordList(
    record_class=TaskResource,
    storage_layout=StorageLayout.FOLDER,
)

# CRUD
tasks.create(TaskResource(title="New task"))
task = tasks.get("some-uid")
tasks.update("some-uid", {"title": "Updated"})
tasks.delete("some-uid")

# Iteration (lazy, reads one file at a time)
for task in tasks:
    print(task.title)
```

**SourceFileRecordList** — multiple records extracted from a single JSON file:

```python
class ClaudeSettingsJsonRecordList(SourceFileRecordList):
    def _extract(self, data: dict) -> list[Record]:
        # Parse settings.json and return typed records
        ...
```

Each extracted record has a `json_path` (RFC 6901 pointer) and `source_file` tracking its position. Write-back uses `_record_to_json()` to patch records back into the source file.

## RecordQuery

`RecordQuery` (`flow_sdk/fs_store/record_query.py`) provides composable filter/sort/paginate for records:

```python
q = RecordQuery(
    types=["task"],
    status="active",
    modified_after=datetime(2026, 1, 1),
    sort_by="modified_at",
    sort_desc=True,
    limit=10,
    offset=0,
)
results = q.apply(records)  # filter + sort + paginate in-memory
```

Supports: `ids`, `types`, `status`, `created_after/before`, `modified_after/before`, `parent_id`, `scope`, `field_predicates`, `predicate` (arbitrary callable), and `child_filter` (recursive composition).

## RecordProvider

`RecordProvider` (`flow_sdk/fs_store/provider.py`) is a `Protocol` for pluggable record backends:

| Method | Description |
|--------|-------------|
| `discover(record_type, scope)` | Return all records of the given type |
| `discover_one(record_type, uid)` | Return a single record by type + uid |
| `query(q)` | Execute a RecordQuery |
| `supports_pushdown(q)` | Whether query can be pushed to backend |
| `is_mutable` (property) | Whether write-back is supported |
| `write_back(record)` | Persist a modified record |

**Implementations:**
- `FSProvider` — delegates to `Record.discover()` / `discover_one()`, in-memory query (no pushdown)
- `GmailProvider` — stub/skeleton for external sources (read-only, not yet implemented)

Provider registry: `register_provider(name, provider)` / `get_provider(name)`.

## CollectionManifest

`CollectionManifest` (`flow_sdk/fs_store/manifest.py`) provides O(1) collection-change detection via a monotonic version counter:

```
~/.flow/records/manifests/<record_type>/.manifest.json
```

### Format

```json
{"version": 42, "updated_at": "2026-03-15T...", "count": 17}
```

### API

| Method | Description |
|--------|-------------|
| `bump(op)` | Increment version; op="add" increments count, op="remove" decrements. Atomic with `fcntl.flock` |
| `read()` | Load manifest from disk |
| `needs_refresh(last_seen_version)` | True if on-disk version differs from last_seen_version |
| `rebuild(record_ids)` | Full rebuild with explicit record ID list |

### When manifest is bumped

- `Record.save()` calls `_bump_manifest("add")`
- `Record.delete()` calls `_bump_manifest("remove")`

**Known issue**: `Record.save()` always bumps with `"add"` even on updates, so the manifest count can over-count if records are updated via `save()` after initial creation.

## Origin/Meta Pattern

Read-only records (e.g., Claude sessions) can't be modified, but we often need to attach our own metadata (ratings, notes, tags). The origin/meta pattern solves this:

```python
session = ClaudeSessionFsRecord.from_jsonl(path)  # read-only

# Create writable metadata record
meta = session.get_or_create_meta()
meta["rating"] = 5
meta["tags"] = ["important"]
meta.save()  # writes to ~/.flow/records/session/session-@<id>/.flow_record/record.json

# Later, read it back
meta = session.meta  # loads from default_path
meta["rating"]       # 5
```

The meta record:
- Has the same `id` and `type` as the origin
- Has an `origin_ref` pointing back to the origin's source file
- Is a plain writable `Record` (not read-only)
- Lives at the origin's `default_path`

## Dirty Tracking

Records track whether data has been modified:

```python
record._data_dirty   # True if any field was set
```

Currently used for `fs_sync` (auto-save on field changes when enabled). Designed to support future optimizations where only changed fields are written to disk.

## Key Management

Records have a `_get_record_key()` classmethod for generating stable identifiers:

```python
class Record:
    @classmethod
    def _get_record_key(cls, record_data: dict) -> str:
        # Default: md5 hash of canonical JSON (first 12 chars)
        canonical = json.dumps(record_data, sort_keys=True, separators=(",", ":"))
        return hashlib.md5(canonical.encode()).hexdigest()[:12]
```

Subclasses override for meaningful keys (e.g., `ClaudeSessionRecord` uses `sessionId`).

## Backward Compatibility

The old class hierarchy (`ResourceRecord` -> `FsRecord` -> subclasses) is preserved via aliases:

```python
FsRecord = Record
FsRecordRef = RecordRef
ResourceRecord = Record
ResourceStatus = RecordStatus
```

Old code using `FsRecord(...)` or `FsRecordRef(...)` continues to work. `RecordRef` also accepts the legacy `record_path` key in `from_dict()`, mapping it to `path`.

## DomainObject Layer

`DomainObject` (`flow_sdk/fs_store/domain_object.py`) is the hydrated, in-memory form of a `Record`. Where `Record` is a passive data container (a dict-backed serializable object), a `DomainObject` wraps a `Record` and adds business logic — lifecycle transitions, computed properties, and domain-specific operations.

```
Record (disk-backed data) --> DomainObject (in-memory + business logic)
```

### Design

- Holds a **live reference** to its `Record` — mutations to the record are immediately visible through the `DomainObject`.
- `_record_type` class variable links a `DomainObject` subclass to its `Record` type string.
- `__init_subclass__` **auto-registers** each subclass into the domain type map, mirroring how `Record` subclasses self-register. No explicit registration call needed.
- `fromRecord(record)` is the canonical factory: `ShellSession.fromRecord(record)` -> `ShellSession` instance.
- `type_registry.hydrate(record)` looks up the domain class for a record's `_record_type` and returns a `DomainObject`. Returns `None` if no domain class is registered for that type.

### Usage

```python
from flow_sdk.domain import ShellSession
from flow_sdk.fs_records import ShellSessionRecord

record = ShellSessionRecord.discover_one(session_id)
session = ShellSession.fromRecord(record)  # hydrate

session.worker_status  # delegates to record.status
session.close()  # transitions status, deletes .pty file, saves record
```

### Domain Objects (`flow_sdk/domain/`)

| Class | Record type | Key behaviors |
|-------|-------------|---------------|
| `Agent` | `agent` | Agent identity, capability metadata |
| `AgenticProcess` | `agentic_process` | PTY session tracking, status transitions |
| `ClaudeSession` | `session` | Claude JSONL session, transcript access |
| `Environment` | `environment` | Env var management, variable resolution |
| `Shell` / `ShellRunner` | -- | Command execution, result capture (`Shell` is an alias for `ShellRunner`) |
| `ShellSession` | `shell_session` | Lifecycle (close), `.pty` stream path computation |
| `ProcessMonitor` | -- | Background process health monitoring |

**Note**: `Shell`/`ShellRunner` and `ProcessMonitor` do not wrap `Record`s — they are domain service objects that follow the module's pattern without the `DomainObject` base class.

### Import trigger

`from flow_sdk import domain` (or any submodule import) triggers `__init_subclass__` registration for all domain classes. This module **must be imported** before `type_registry.hydrate()` is called. The `flow_sdk/domain/__init__.py` imports all subclasses for this reason.

## Module Map

| File | Purpose |
|------|---------|
| `record.py` | `Record` class, status enum, stem helpers, default root |
| `record_ref.py` | `RecordRef` dataclass |
| `record_types.py` | `RecordType` constants (string enum) |
| `record_state.py` | `RecordState` — per-record `state.json` property cache |
| `property_record.py` | `PropertyRecord` — TTL-cached computed property descriptor |
| `record_list.py` | `RecordList` — storage-agnostic typed collection with cache modes |
| `record_query.py` | `RecordQuery` — composable filter/sort/paginate |
| `resource_record_list.py` | `ResourceRecordList` — one-record-per-file collection |
| `source_file_record_list.py` | `SourceFileRecordList` — multi-record-from-one-file |
| `source_file_registry.py` | Maps filenames to `SourceFileRecordList` subclasses |
| `provider.py` | `RecordProvider` protocol, `FSProvider`, `GmailProvider` (stub) |
| `manifest.py` | `CollectionManifest` — O(1) collection-change detection |
| `schema_registry.py` | `SchemaRegistry` — unified type system + scan/index orchestration |
| `identifier.py` | Record identifier utilities |
| `domain_object.py` | `DomainObject` base class for hydrated Records |
| `factory/type_registry.py` | Backward-compat shim — delegates Record lookups to `SchemaRegistry` |
| `scope.py` | `Scope` enum (user, project, managed, etc.) |
| `storage_layout.py` | `StorageLayout` enum (file, folder, list_item) |
| `exceptions.py` | `ReadOnlyRecordError`, `ReadOnlyProviderError` |
| `sync_protocol.py` | Sync operation types |
| `__init__.py` | Public API + backward-compat aliases |
