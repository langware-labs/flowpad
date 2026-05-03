# Record Model

This document describes the `Record` base class and the surrounding infrastructure in `flow_sdk/fs_store/`. The Record layer is the persistence backbone for all typed data objects in flow-cli: agent sessions, tasks, skills, hooks, settings, transcript entries, and more.

## Overview

`Record` is a single, unified base class. All state lives in a single `_data` dict plus instance-level attributes. Subclasses define domain-specific behaviour by setting `_record_type`, declaring properties over `_data`, and optionally overriding discovery or serialization methods.

Source files:

| File | Purpose |
|---|---|
| `flow_sdk/fs_store/record.py` | `Record` base class, `RecordStatus`, on-disk helpers |
| `flow_sdk/fs_store/record_types.py` | `RecordType` / `SkillitRecordType` string enums |
| `flow_sdk/fs_store/storage_layout.py` | `StorageLayout` enum |
| `flow_sdk/fs_store/record_ref.py` | `RecordRef` dataclass |
| `flow_sdk/fs_store/record_list.py` | `RecordList` (storage-agnostic collection) |
| `flow_sdk/fs_store/resource_record_list.py` | `ResourceRecordList` (per-file/per-folder collection) |
| `flow_sdk/fs_store/source_file_record_list.py` | `SourceFileRecordList` (multi-record inside one JSON file) |
| `flow_sdk/fs_store/factory/type_registry.py` | `TypeRegistry` singleton |
| `flow_sdk/fs_store/record_query.py` | `RecordQuery` filter/sort/paginate helper |
| `flow_sdk/fs_store/record_state.py` | `RecordState` per-record index cache |
| `flow_sdk/fs_store/manifest.py` | `CollectionManifest` per-type collection manifest |

---

## Single-Dict Internal Storage

Every `Record` instance carries one internal dict and one dirty flag:

| Attribute | Content | Persisted to |
|---|---|---|
| `_data` | All fields: id, type, name, status, and all domain-specific fields | Split across `metadata.json` + `_data.json` (see [On-Disk Split Format](#on-disk-split-format)) |
| `_data_dirty` | `bool` — unsaved changes | (tracked only) |

Two instance-level attributes are stored directly on the object (not in `_data`):

| Attribute | Type | Purpose |
|---|---|---|
| `_source_file` | `str \| None` | Absolute path to the JSON file last read/written |
| `_path` | `str \| None` | Absolute path to the enclosing folder (FOLDER layout) |
| `fs_sync` | `bool` | When `True`, every field write auto-saves immediately |
| `storage_layout` | `StorageLayout` | How this instance is stored on disk |

### `_SKIP_SERIALIZE` frozenset

```python
_SKIP_SERIALIZE: frozenset[str] = frozenset({
    "source_file", "path",
    "json_path",
    "fs_sync", "storage_layout",
    "raw_json",
})
```

Fields in `_SKIP_SERIALIZE` are excluded from `to_dict()` and `from_dict()` output. These are infrastructure fields that don't belong in the serialized record.

### Attribute Routing

`__getattr__` is only invoked when Python's normal lookup fails. It checks `_data` and raises `AttributeError` if the key is absent. Private names (starting with `_`) immediately raise `AttributeError` to prevent recursion.

`__setattr__` applies the following routing rules in order:

1. Names starting with `_` — written directly via `object.__setattr__`.
2. Names that have a property descriptor with a setter in the MRO — the property setter is called.
3. Names that have a read-only property in the MRO — `AttributeError` raised.
4. `"fs_sync"` and `"storage_layout"` — written via `object.__setattr__`.
5. Everything else — written into `_data`, `_data_dirty` set to `True`, `_auto_sync` called.

`__getitem__` / `__setitem__` / `__delitem__` / `__contains__` are also defined for dict-style access.

---

## RecordStatus Enum

```python
class RecordStatus(str, Enum):
    CREATING = "creating"
    NEW      = "new"
    ACTIVE   = "active"
    ORPHAN   = "orphan"
```

`CREATING` is used for records that are being constructed but not yet fully persisted. `NEW` is the initial persisted state. `ACTIVE` marks a record that has been acknowledged or activated. `ORPHAN` is set when an external data reference can no longer be resolved.

When `status` is set, `on_status_change(old_status, new_status)` is called. Subclasses override this hook to react to transitions.

---

## Identity Properties

All identity fields are stored in `_data` and exposed as Python properties.

### Identity

| Property | Type | Notes |
|---|---|---|
| `id` | `str` | UUID, auto-generated in `__init__` if absent. Has NO setter — `AttributeError` on assignment. |
| `uid` | `str` (read-only) | Returns the value of `uid_field_name` (default: `"id"`) |
| `type` | `str` | Record type string, e.g. `"session"` |
| `name` | `str` | Human-readable name |
| `status` | `str \| RecordStatus \| None` | Lifecycle state |
| `stem` | `str` (read-only) | `"<type>-@<uid>"` — canonical filesystem stem |

`uid_field_name` is a class variable (default `"id"`). Subclasses may point it at a different field, in which case `uid` falls back to `id` if that field is absent.

### Relationship Refs

| Property | Type | Key in _data |
|---|---|---|
| `parent_ref` | `RecordRef \| None` | `"parent"` |
| `children_refs` | `list[RecordRef]` | `"children"` |
| `origin_ref` | `RecordRef \| None` | `"origin"` |
| `data_ref` | `RecordRef \| None` | `"data_ref"` |

Legacy aliases (`parent_id`, `parent_ref`, `children_refs`, `origin_ref`) are accepted in the constructor and normalized to the canonical key names.

---

## Location Properties

These are stored as instance attributes, not in `_data`:

| Property | Type | Notes |
|---|---|---|
| `source_file` | `str \| None` | Path of the JSON file that was read or written |
| `path` | `str \| None` | Path of the enclosing folder (FOLDER layout only) |
| `record_dir` | `Path \| None` (read-only) | Computed: `path` if set, else parent of `source_file` |
| `default_path` | `Path \| None` (read-only) | `~/.flow/records/<type>/<type>-@<uid>/` |
| `fs_modified_at` | `datetime \| None` (read-only) | mtime from the filesystem |
| `output_dir` | `Path` (read-only) | `<record_dir>/output/`, created on access |

---

## `asset_ref` and folder queries

For Entity types whose Record carries an external content file (skills,
agents, workflows, markdown docs, …), the entity row stores an `asset_ref`
field with the absolute path of that file or folder.

**Storage format — canonical POSIX.** Paths are normalised on write via
`flow_sdk.fs_store.path_utils.canonical_posix_path` =
`unicodedata.normalize("NFC", Path(p).resolve().as_posix())`. This:

- collapses `\` vs `/` (Windows paths become `C:/Users/...`);
- canonicalises case on macOS APFS / Windows NTFS via `Path.resolve()`;
- folds NFD vs NFC differences from macOS APFS filenames.

The conversion runs in `Entity._prepare_for_storage()` at the single write
site `flow_sdk/core/entity/entity_model.py:644`. Existing rows written
before this rule was introduced may retain non-canonical values until the
next save; a one-shot backfill can re-save them.

**Query — `Entity.assets_by_path(PathQueryOptions)`.** Returns entities whose
`asset_ref` is a strict descendant of any of `opts.search_dirs`, optionally
narrowed by `opts.types`. Pushdown uses a half-open lex range against
`json_extract(data, '$.asset_ref')`:

```sql
asset_ref >= '<dir>/'  AND  asset_ref < '<dir>0'
```

`/` is `0x2F`; the next codepoint `0` (`0x30`) terminates the range.
Multiple search dirs are OR'd, types are AND'd via `IN`. The query reads
`asset_ref` only — `parent_path` and `vault_root` are not consulted.

The dir itself is **not** returned — only strict descendants. Querying for
`<dir>` where the dir IS an entity's `asset_ref` returns an empty list.

HTTP wrapper: `GET /api/v1/assets/by-path?folder=<abs>&record_type=<type>`
(both `folder` and `record_type` are repeatable). See
`flow_sdk/server/routes/assets.py`.

---

## Constructor Calling Patterns

The `__init__` signature is:

```python
def __init__(
    self,
    _data: dict | None = None,
    **kwargs: Any,
)
```

Two calling conventions are supported:

### 1. Empty construction

```python
r = Record()
# Generates a new UUID for id in _data
```

### 2. Flat kwargs

```python
r = Record(id="abc", type="session", name="my-session", prompt="hello")
# All kwargs go to _data
```

A special kwarg `raw_json` merges its dict value into `_data` directly.

### Factory loading via `from_dict`

```python
rec = MyRecordSubclass.from_dict(flat_dict)
```

`from_dict` populates `_data` from the flat dict, coercing `status` and datetime strings, without triggering dirty flags.

### Polymorphic loading via `Record.load`

```python
rec = Record.load("/path/to/folder-or-json-file")
```

Tries `metadata.json` first (new split format via `_load_split_format`), then falls back to `data.json`, then to `.flow_record/record.json` (triggering migration). Looks up the `type` field in `type_registry`, instantiates the correct subclass via `from_dict`, and sets `source_file`. Returns a `Record` base instance if the type is not registered.

---

## StorageLayout Enum

```python
class StorageLayout(str, Enum):
    FILE      = "file"       # standalone <type>-@<uid>.json file
    LIST_ITEM = "list_item"  # one line inside a JSONL file
    FOLDER    = "folder"     # <type>-@<uid>/ directory with data.json inside
```

### FILE

A single JSON file named `<type>-@<uid>.json` inside the collection directory. Used for lightweight records where a sibling directory is unnecessary.

### LIST_ITEM

Used by `SourceFileRecordList` subclasses. The record is not a standalone file — it is a fragment embedded in a larger JSON document. Its position is tracked via `json_path` (an RFC 6901 JSON Pointer).

### FOLDER

The default for `Record`. Each record lives in a directory named `<type>-@<uid>/`.

The stem format is `<type>-@<uid>` (separator constant `"-@"`). `record_stem(type, uid)` builds it; `parse_record_stem(stem)` splits it back.

---

## On-Disk Split Format

Record data is split across two files in the record folder:

```
<type>-@<uid>/
  metadata.json    # identity fields: id, type, name
  _data.json       # domain fields: everything else (status, prompt, etc.)
  state.json       # RecordState cache (synced on save)
```

Both files use the wrapped `{"data": {...}}` format.

### `metadata.json` — Identity Fields

Contains the fields defined in `_META_FIELDS`:

```python
_META_FIELDS: frozenset[str] = frozenset({"id", "type", "name"})
```

```json
{"data": {"id": "abc-123", "type": "task", "name": "My Task"}}
```

Written by `_save_split_format(folder)`. On load, `_load_split_format(folder)` reads this file first.

**Heal-on-read**: If `metadata.json` is corrupt (invalid JSON), identity is recovered from the folder name (`<type>-@<uid>`) via `parse_record_stem()`, and a valid `metadata.json` is written back so subsequent loads use the same stable id.

### `_data.json` — Domain Fields

Contains all fields NOT in `_META_FIELDS` (status, description, prompt, created_at, custom fields, etc.):

```json
{"data": {"status": "active", "prompt": "hello", "description": "..."}}
```

Only written if there are domain fields to persist. Old meta fields (`created_at`, `modified_at`, `created_by`, `updated_by`, `scope`, `entity_id`, `json_path` — defined in `_OLD_META_FIELDS`) are stripped on read to prevent legacy field pollution.

### `_ENTITY_META_FIELDS` — Extended Meta Set

A broader frozenset used by the Entity sync layer:

```python
_ENTITY_META_FIELDS: frozenset[str] = frozenset({
    "id", "type", "name", "status", "created_at", "modified_at", "scope"
})
```

This is NOT used for file splitting — only `_META_FIELDS` controls which fields go into `metadata.json`. `_ENTITY_META_FIELDS` is used when syncing record metadata into Entity DB rows.

### `state.json` — Per-Record Index Cache

Managed by `RecordState` (in `flow_sdk/fs_store/record_state.py`). Synced on every `save()` call via `self._get_index().save(meta=meta_dict)`. Contains cached identity metadata used by the index/discovery layer for fast lookups without reading the full record data.

### `CollectionManifest` — Per-Type Manifest

Managed by `CollectionManifest` (in `flow_sdk/fs_store/manifest.py`). Updated on every `save()` and `delete()` call via `self._bump_manifest(op)`. Tracks collection-level metadata (add/delete operations) for the record type under the default records root.

### Backward-Compatible Migration

Two migration paths exist for older on-disk formats:

1. **Oldest format** (`.flow_record/record.json`): `_migrate_old_format(folder)` reads the old file, writes `data.json` in wrapped format, and removes `.flow_record/`.

2. **Legacy combined format** (`data.json` with all fields): `_migrate_data_to_split_format(folder)` splits the combined `data.json` into `metadata.json` + `_data.json`, then removes `data.json`.

Both migrations are lazy — they run on first read. `Record.load()` tries `metadata.json` first (new split format), then falls back to `data.json`, then to `.flow_record/record.json`.

All discovery methods (`Record.discover()`, `Record.discover_one()`, `Record.load()`, `Record.init_record()`) trigger migration transparently.

---

## TypeRegistry and Auto-Registration

`Record.__init_subclass__` fires whenever a subclass is defined. If the subclass has a non-empty `_record_type` class variable, it is registered automatically with `SchemaRegistry`:

```python
class MyRecord(Record):
    _record_type = "my_record"
    # Automatically registers with SchemaRegistry (record_cls=MyRecord)
```

`Record.load` uses `SchemaRegistry.get_record_cls(type_name)` to instantiate the correct subclass from a JSON file.

The legacy `type_registry` singleton (`flow_sdk/fs_store/factory/type_registry.py`) still exists as a thin backward-compat shim. Its `get()` and `get_all_types()` methods delegate to `SchemaRegistry`. Calling `type_registry.register()` is a no-op — use the `_record_type` class variable to trigger auto-registration instead.

---

## RecordRef

`RecordRef` is a `@dataclass` in `flow_sdk/fs_store/record_ref.py`. A lightweight pointer for parent/child relationships, origin tracking, and external data references.

```python
@dataclass
class RecordRef:
    id: str = ""
    type: str = ""
    path: str | None = None
    json_path: str | None = None
    key_field: str | None = None
    key_value: str | None = None
    format: str | None = None
```

> **Note — `data_ref` is structurally defined but unused for external data indexing.** The `data_ref` property on `Record` stores a `RecordRef` with fields designed for pointing at external data (path, json_path, key_field, key_value, format), but no code currently uses `data_ref` for automatic external data discovery or indexing. The only path for external data into the record system is through hardcoded `SourceFileRecordList` subclasses (see [folder-layout.md](folder-layout.md#sourcefileregistry-and-the-config-file-whitelist)).

---

## CRUD on a Single Record

### Initialization and loading

| Method | Signature | Notes |
|---|---|---|
| `init_record` | `cls.init_record(path_or_data, path=None, indent=2) -> T` | Load from path or create at path from dict |
| `init` | `cls.init(data, path, indent=2) -> T` | Alias for `init_record(data, path)` |
| `load` | `cls.load(path) -> Record` | Polymorphic — uses TypeRegistry to pick subclass |
| `discover` | `cls.discover(scope=None, **kwargs) -> list[T]` | Directory scan of `~/.flow/records/<type>/` |
| `discover_one` | `cls.discover_one(uid, scope=None, **kwargs) -> T \| None` | O(1) direct path lookup |
| `read_record` | `self.read_record(path: Path) -> None` | Reload this instance's fields from a file |

### Saving

| Method | Notes |
|---|---|
| `save()` | For FOLDER layout, writes `metadata.json` + `_data.json` via `_save_split_format()`, syncs `state.json`, and bumps the collection manifest. Auto-assigns `default_path` if `source_file` is unset. |
| `save_record_json(path=None, indent=2)` | Write to an explicit path (or `source_file`) |
| `write_record(path, indent=2)` | Low-level write; raises `ReadOnlyRecordError` if `_read_only` is True |
| `persist()` | Default: delegates to `save()`; overridden in source-file-backed records |

### Mutation helpers

| Method | Notes |
|---|---|
| `clone(new_path)` | Deep copy with new UUID, sets `origin_ref` to this record, saves at `new_path` |
| `move(new_path)` | Writes to `new_path`, removes old `record_dir` with `shutil.rmtree` |
| `delete()` | FOLDER layout: `shutil.rmtree` on `record_dir`; FILE layout: unlinks `source_file` |
| `open()` | Opens `record_dir` in the native OS file manager |

### Read-only records

Setting `_read_only = True` on a subclass causes `write_record`, `clone`, and `move` to raise `ReadOnlyRecordError`. Source-file-backed records that represent parsed fragments of external files typically set this.

---

## `Record.sync_to_db()` Async Method

```python
await record.sync_to_db()
```

Creates or updates the corresponding Entity in SQLite and upserts into the `entities_fts` FTS5 table. **The ONLY way to get a Record into the Entity DB.**

No-op for `_read_only` records. The FTS upsert is skipped when `record.content` returns None (i.e., the record has opted out of search indexing). See [record-search.md](record-search.md) for full details.

---

## fs_sync Auto-Save

When `fs_sync = True` on a record instance, any attribute write triggers `_auto_sync`, which calls `save()` immediately if `source_file` is set.

```python
rec = MyRecord.load("/some/path")
rec.fs_sync = True
rec.name = "updated"   # writes to disk immediately
```

---

## Companion Files

Any record with `record_dir` set can store arbitrary companion files alongside the record data:

```python
def read_file(self, filename: str) -> str | None:
    """Read a companion text file from record_dir. Returns None if missing."""

def write_file(self, filename: str, content: str) -> Path:
    """Write a companion text file to record_dir. Creates dirs if needed."""
```

The `output_dir` property returns `<record_dir>/output/`, creating it if it does not exist.

---

## Serialization

### to_dict

`to_dict()` returns a flat dict containing all `_data` fields, excluding keys in `_SKIP_SERIALIZE`. `datetime` values are serialized to ISO-8601 strings; `Enum` values to their `.value`.

```python
rec = Record(id="abc", type="session", name="test", prompt="hello")
rec.to_dict()
# {"id": "abc", "type": "session", "name": "test", "prompt": "hello"}
```

### from_dict

`from_dict(data)` populates `_data` from the flat dict and returns a new instance without triggering any property setters or dirty flags.

---

## RecordList

`RecordList` in `flow_sdk/fs_store/record_list.py` is a storage-agnostic typed collection. It delegates all discovery to `record_class.discover()` / `record_class.discover_one()` and all persistence to `record.persist()`.

```python
from flow_sdk.fs_store.record_list import RecordList
from my_module import MyRecord

lst = RecordList(MyRecord, scope=Scope.USER)
```

### Methods

| Method | Signature | Notes |
|---|---|---|
| `get` | `(uid: str) -> Record \| None` | Calls `discover_one` |
| `__iter__` | | Calls `discover`; no caching |
| `__len__` | | Calls `discover`; no caching |
| `records` | property | `list(self)` |
| `create` | `(record: Record \| dict) -> Record` | Checks for duplicate uid; calls `persist()` |
| `save` | `(record: Record) -> None` | Calls `persist()` (create or overwrite) |
| `update` | `(uid: str, data: dict) -> Record` | Fetch, setattr each field, persist; raises `KeyError` if missing |
| `delete` | `(uid: str) -> bool` | Calls `record.delete()`; returns `True` if existed |
| `query` | `(q: RecordQuery) -> list[Record]` | Applies a `RecordQuery` to all discovered records |

---

## ResourceRecordList

`ResourceRecordList` in `flow_sdk/fs_store/resource_record_list.py` is an explicit per-file/per-folder collection with direct disk control. It is a `@dataclass`.

### Constructor fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `list_path` | `Path \| None` | `None` | Root directory; auto-computed from `record_class` type if omitted |
| `record_class` | `type[Record]` | `Record` | The record type to manage |
| `storage_layout` | `StorageLayout` | `StorageLayout.FOLDER` | FILE or FOLDER |
| `records_path` | `Path \| None` | `None` | Override for `~/.flow/records/` |

### Methods

| Method | Notes |
|---|---|
| `get(uid)` | Reads from disk |
| `create(record \| dict)` | Raises `ValueError` if uid already exists |
| `save(record)` | Write to disk; create or overwrite |
| `update(uid, data)` | Read-modify-write |
| `delete(uid)` | FOLDER: `shutil.rmtree`; FILE: `unlink` |
| `__iter__` | Sorted; skips corrupt/empty files silently |
| `__len__` | Counts matching entries without loading |

---

## SourceFileRecordList

`SourceFileRecordList` in `flow_sdk/fs_store/source_file_record_list.py` is for record types embedded inside a single JSON file. Uses an in-memory cache.

Typical examples: entries inside `~/.claude.json`, items inside a `.mcp.json` file, transcript entries inside a JSONL session file.

### Abstract methods to override

| Method | Notes |
|---|---|
| `_extract(data)` | **Required.** Parse the JSON dict and return typed records. |
| `_record_to_json(record)` | Optional. Convert a record back to its JSON fragment. |

### Write-back CRUD

| Method | Notes |
|---|---|
| `update(record_type, uid, data)` | Apply field updates, patch the source file at `record.json_path`, reload cache. |
| `delete_record(record_type, uid)` | Removes the JSON fragment at `record.json_path` from the source file. |

---

## RecordQuery

`RecordQuery` in `flow_sdk/fs_store/record_query.py` is a `@dataclass` for declarative filter, sort, and pagination of records. All fields are optional and are AND-ed together.

### Filter fields

| Field | Type | Behavior |
|---|---|---|
| `ids` | `list[str] \| None` | Keep records whose `uid` is in the list |
| `types` | `list[str] \| None` | Keep records whose `type` is in the list |
| `status` | `str \| list[str] \| None` | Keep records whose `str(status)` matches |
| `created_after` | `datetime \| None` | Keep records with `created_at >= value` |
| `created_before` | `datetime \| None` | Keep records with `created_at <= value` |
| `modified_after` | `datetime \| None` | Keep records with `modified_at >= value` |
| `modified_before` | `datetime \| None` | Keep records with `modified_at <= value` |
| `parent_id` | `str \| None` | Keep records whose `parent_ref.id == value` |
| `predicate` | `Callable[[Record], bool] \| None` | Arbitrary caller-supplied function |

### Sort and pagination fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `sort_by` | `str \| None` | `None` | Attribute name to sort by |
| `sort_desc` | `bool` | `True` | Descending order |
| `limit` | `int \| None` | `None` | Max records to return |
| `offset` | `int` | `0` | Skip this many records |

### Usage example

```python
from flow_sdk.fs_store.record_query import RecordQuery
from datetime import datetime

q = RecordQuery(
    types=["session"],
    status="active",
    modified_after=datetime(2026, 1, 1),
    sort_by="modified_at",
    sort_desc=True,
    limit=20,
)

results = record_list.query(q)
```
