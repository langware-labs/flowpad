---
id: ab331b9d-eea6-58a5-b44e-bbd65be5f867
---

# Schema Registry

The `SchemaRegistry` is the single source of truth for all type metadata across the Record and Entity layers. It replaces the two separate, unconnected registries that previously existed (`fs_store/factory/type_registry.py` and `schema/entity_factory.py`).

**Key source file:** `flow_sdk/fs_store/schema_registry.py`

---

## TypeInfo

Every registered type has exactly one `TypeInfo` object:

```python
@dataclass
class TypeInfo:
    # Structural (included in hash, persisted to disk)
    type_name: str
    uid_field: str = "id"
    index_fields: list[str] = ...
    defaults: dict[str, Any] = ...
    read_only: bool = False
    indexed_by_default: bool = False
    parent_type: str | None = None    # string only, resolved lazily
    locations: list[str] = ...        # "record", "index", or both

    # Runtime refs (NOT persisted)
    record_cls: type | None = ...     # the Record subclass
    entity_cls: type | None = ...     # the DBBaseRecord subclass
```

### Dynamic properties

| Property | Description |
|----------|-------------|
| `schema_hash` | MD5 of structural fields as canonical JSON (first 16 hex chars). Used to gate disk writes. |
| `extends` | Resolves `parent_type` string → `TypeInfo` via registry lookup. |
| `subtypes` | All direct children registered with `parent_type == self.type_name`. |
| `scans` | Last 20 entries from `~/.flow/schema/types/<type>/scan_log.jsonl`. Read on access, not persisted. |

---

## Registration

Types register themselves automatically via `__init_subclass__` hooks:

### Record subclasses (`flow_sdk/fs_store/record.py`)

When a `Record` subclass declares `_record_type`, `__init_subclass__` (line 212) fires and:
1. Resolves `parent_type` by walking the MRO for the first base class with its own `_record_type`
2. Registers with `SchemaRegistry` using `locations=["record"]`, `record_cls=cls`
3. Also registers with the legacy `fs_store/factory/type_registry` as a fallback

Additional fields extracted from the class:
- `uid_field` from `cls.uid_field_name` (defaults to `"id"`)
- `index_fields` from `cls.index_fields`
- `defaults` from `cls._DATA_DEFAULTS`
- `read_only` from `cls._read_only`
- `indexed_by_default` from `cls._indexed_by_default` (defaults to `False`)

Types marked as indexed by default:
- `SkillRecord` (`skill`)
- `MemoRecord` (`memo`)
- `AgentRecord` (`agent`)
- `TaskResource` (`task`)
- `AgenticProcessRecord` (`agentic_process`)

**Note:** `error` and `claude_error` record types are NOT in the default index types. They have their own parallel discovery mechanism via `ClaudeErrorRecordList._do_sync()`, which bypasses SchemaRegistry's scan/index orchestration entirely.

### Entity subclasses (`flow_sdk/db/drivers/db_base_record.py`)

When a `DBBaseRecord` subclass registers via `__init_subclass__` (line 59):
1. Calls `cls.get_type()` to resolve the type name
2. Registers with `SchemaRegistry` using `locations=["index"]`, `entity_cls=cls`
3. Also registers with the legacy `schema/entity_factory.type_registry`

Bootstrap entities (User, Project, ComputeNode) have `locations=["index"]` only — no `record_cls`.

### Merge semantics

`register()` is idempotent. When the same `type_name` registers twice (once as Record, once as Entity):
- Locations are merged: `["record", "index"]`
- `record_cls` and `entity_cls` are each set on the first non-None value

This is the normal path for types like `agentic_process` that exist in both layers — the Record subclass registers first with `locations=["record"]`, then the Entity subclass enriches the same `TypeInfo` with `locations=["record", "index"]`.

---

## Persistence (`type_info.json`)

Each type gets a `~/.flow/schema/types/<type>/type_info.json` file containing structural fields and `schema_hash`. Writes are hash-gated: if the structural hash matches the last-written value, no file write occurs.

`SchemaRegistry.load_persisted()` can restore structural metadata from disk at startup without requiring Python class imports.

---

## Scan/Index Orchestration

`SchemaRegistry` owns all scan and index operations (previously `SchemaRecord`).

### Method reference

| Method | Description |
|--------|-------------|
| `discover(types, trigger, limit_per_type, actions)` | Full scan+index for given or default types. Returns `(scan_results, index_results)`. Also aliased as `sync()`. |
| `incremental(request: IndexRequest)` | Scan+index types not indexed since `request.start_time`. Aliased as `sync_incremental()`. |
| `index_type(type_or_cls, limit, clear_first)` | Index one type. Accepts type name string or Record class (backward compat). |
| `_scan_type(type_or_cls, include_records, limit)` | Scan one type, return `ScanResult`. |
| `rebuild_index(types, trigger)` | Clear then re-index. Aliased as `rebuild()`. |
| `clear_index(types)` | Clear FTS index, entities, and per-type logs. Aliased as `clear()`. |
| `get_index_status(types)` | Return `IndexStatus` with freshness info for all default types. Aliased as `get_status()`. |
| `get_errors(type_name)` | Return `RecordError` list, optionally filtered by type. |
| `get_default_index_types()` | Return list of `indexed_by_default=True` types. Falls back to built-in list if registry is empty. |

### Log files

All operations are logged to JSONL files:

```
~/.flow/schema/
  scan_log.jsonl              # global scan log (all types)
  index_log.jsonl             # global index log (all types)
  types/
    skill/
      type_info.json          # TypeInfo structural fields + hash
      scan_log.jsonl          # per-type scan log
      index_log.jsonl         # per-type index log
    memo/
      ...
```

Each log file is capped at 100 entries (oldest trimmed on append).

### Result types

| Type | Fields |
|------|--------|
| `ScanResult` | `type_name`, `count`, `total_bytes`, `scan_ms`, `last_scan_at`, `records`, `avg_bytes`, `min_bytes`, `max_bytes` |
| `IndexResult` | `type_name`, `indexed`, `skipped`, `duration_ms`, `last_index_at`, `errors` |
| `IndexRequest` | `types`, `actions`, `start_time`, `end_time`, `trigger`, `limit_per_type` |
| `ClearResult` | `fts_cleared`, `entities_cleared`, `types_cleared` |
| `IndexStatus` | `never_indexed`, `last_indexed_at`, `stale`, `default_types`, `per_type` |
| `TypeIndexStatus` | `type_name`, `last_indexed_at`, `last_scan_at`, `entity_count`, `stale` |

---

## Backward Compatibility

`flow_sdk/fs_records/schema_record.py` is a thin re-export shim:

```python
from flow_sdk.fs_store.schema_registry import SchemaRegistry as SchemaRecord
```

All existing code that imports `SchemaRecord` continues to work. The old method names (`discover`, `incremental`, `rebuild_index`, `clear_index`, `get_index_status`) are kept as primary names on `SchemaRegistry`; the new names (`sync`, `sync_incremental`, `rebuild`, `clear`, `get_status`) are aliases.

Both legacy type registries are now thin backward-compat shims that fully delegate to `SchemaRegistry`:

- `fs_store/factory/type_registry.py` — `type_registry` is an `_FsRegistryShim` instance. `get(type_name)` delegates to `SchemaRegistry.get_record_cls(type_name)`. `register()` is a no-op (registration now happens via `__init_subclass__` → SchemaRegistry).
- `schema/entity_factory.py` — `type_registry` is an `_EntityRegistryShim` instance. `get(name)` delegates to `SchemaRegistry.get_entity_cls(name)`. `register()` is a no-op. `TypeRegistry` class alias retained for type annotations. `RegistryEntry` has been removed.

`SchemaRegistry` is now authoritative for **both** Record and Entity lookups.

### New convenience methods on SchemaRegistry

| Method | Returns | Description |
|--------|---------|-------------|
| `get_entity_cls(type_name)` | `type \| None` | Entity class for the given type, or None |
| `get_record_cls(type_name)` | `type \| None` | Record class for the given type, or None |
| `is_entity_type(type_name)` | `bool` | True if an entity class is registered for this type |
| `is_implemented(type_name)` | `bool` | Alias for `is_entity_type()` |
| `is_public_entity(type_name)` | `bool` | True if entity class exists and `api_visible()` returns True |
| `get_all_entity_types()` | `list[str]` | All type names with a registered entity class |
| `get_all_entity_classes()` | `list[type]` | All registered entity classes |
| `get_public_entity_types()` | `list[str]` | Entity type names where `api_visible()` is True |
| `get_all_record_types()` | `list[str]` | All type names with a registered record class |

### Duplicate entity registration

`SchemaRegistry.register()` raises `ValueError` if the same `type_name` is registered with two **different** entity classes (by fully-qualified class name). The first registration wins. This prevents silent shadowing bugs where a stub class could overwrite the full implementation.

---

## HTTP Endpoints

The ComputeNode exposes these `fs-records` endpoints that use `SchemaRegistry`:

| Endpoint | Handler | Description |
|----------|---------|-------------|
| `GET /fs-records/scan` | `_handle_fs_records_scan` | Aggregate or per-type scan stats |
| `POST /fs-records/index` | `_handle_fs_records_index` | Index all or one type, with optional `?rebuild=true` |
| `GET /fs-records/index-status` | `_handle_fs_records_index_status` | Freshness info |
| `DELETE /fs-records/index` | `_handle_fs_records_index_clear` | Clear FTS + entity DB |

---

## Usage Example

```python
import flow_sdk.fs_records  # triggers auto-registration of all Record types

from flow_sdk.fs_store.schema_registry import SchemaRegistry

# Inspect a type
info = SchemaRegistry.get("skill")
print(info.locations)       # ["record", "index"]
print(info.schema_hash)     # "a3f1c2d4..."
print(info.indexed_by_default)  # True

# Find subtypes
children = SchemaRegistry.get_subtypes("transcript_entry")

# Run a full scan+index
scan_results, index_results = await SchemaRegistry.discover(trigger="manual")

# Get status
status = SchemaRegistry.get_index_status()
print(status.never_indexed)  # True if never indexed
```
