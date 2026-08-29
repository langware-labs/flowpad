---
id: ab331b9d-eea6-58a5-b44e-bbd65be5f867
---

# Schema Registry

The `SchemaRegistry` is the single source of truth for all type metadata across the Record and Entity layers. It replaces the two separate, unconnected registries that previously existed (`fs_store/factory/type_registry.py` and `schema/entity_factory.py`).

Per-type metadata is **authored declaratively** in `flow_sdk/schema/type_info/<type>_info.py` modules (one `TypeMetadata` instance each) and **registered** into `SchemaRegistry` as `TypeInfo` by `register_all()`. Entity classes additionally self-register their `entity_cls` via `Entity.__init_subclass__`. See [Registration](#registration).

**Key source files:**
- `flow_sdk/fs_store/schema_registry.py` — `SchemaRegistry` + `TypeInfo`
- `flow_sdk/schema/type_info/__init__.py` — `TypeMetadata` + `register_all()`
- `flow_sdk/schema/type_info/<type>_info.py` — per-type metadata authoring
- `flow_sdk/schema/types.py` — `EntityType`, the single canonical type-name enum

---
> The layer below this one is [`DataSpec`](data-spec.md) — runtime shapes
> compiled to Pydantic, and `TypeInfo.asset_spec`, the spec whose types ARE a type's layout. Kinds bind
> here too: `SchemaRegistry.register_kind(kind, cls)` / `kind_type(kind)` / `kind_for(cls)` share
> the type-name namespace, so an entity type name is a kind. A `DataSpec`
> subclass with a `spec_kind` registers itself on definition.
> `TypeInfo` is the resolver for entity-backed kinds; it is not a competing type
> system.


## TypeInfo

Every registered type has exactly one `TypeInfo` object:

```python
@dataclass
class TypeInfo:
    # --- Structural fields (included in schema_hash) ---
    type_name: str
    uid_field: str = "id"
    index_fields: list[str] = ...
    defaults: dict[str, Any] = ...
    indexed_by_default: bool = False
    browseable: bool = False
    creatable: bool = False
    api_visible: bool = False
    icon: str | None = None
    parent_type: str | None = None    # string only, resolved lazily
    locations: list[str] = ...        # "index" (and/or "record")

    # --- Runtime refs (NOT in hash, NOT persisted) ---
    entity_cls: type | None = ...     # the Entity subclass (db_base_record)
    post_sync_fn / from_disk_fn / asset_hash_fn / default_body_fn: Any
    capsules: tuple[CapsuleSpec, ...]
    identity_backend: IdentityBackend | None
    id_stable_key_fn: Any
    id_namespace: UUID
    metadata: Any                     # the TypeMetadata instance it was built from
    meta_model: Any                   # per-type pydantic FS↔DB schema model
    main_subdir: str | None = None    # scope-relative asset subdir
    main_layout: str = "file"         # "file" | "folder"
```

There is **no `record_cls` field** — `FSRecord` is now the single concrete record class (no `Record` subclasses), so a per-type record class is no longer registered. Per-type record behavior lives in free functions and declarative runtime slots (`from_disk_fn`, `capsules`, `identity_backend`, etc.) attached to the `TypeInfo`, not on a subclass.

`TypeInfo.mint_entity_id(ref, *, owner_id=None, live_ids=None, proposed_id=None, derive=False, overwrite=False)` is the ONE identity seam; `extract_id`/`mint_id`/`resolve_id` are gone. Its backend observes the canonical named capsule then ordered read-only legacy/native candidates, and TypeInfo applies the UUID v4/v5 adoption policy.

Resolution order is **carrier → owning row → derive**, by carrier LIVENESS: the carrier wins unless a row owns this path AND the carrier is provably dead (`live_ids` is the oracle; `None` means "cannot prove dead", so only the index walk may conclude it). Two orthogonal flags, both defaulting to the inert corner:

| `derive` | `overwrite` | behaviour | callers |
|---|---|---|---|
| `False` | `False` | probe — answers only from evidence, returns `None` when there is none | collision-identity ranking, create guards, assertions, read-only mounts |
| `True` | `False` | compute the id the indexer would assign, write nothing | request handlers |
| `True` | `True` | compute AND commit, healing an ABSENT carrier | the index walk |

A derived value is NOT an acceptable substitute for the probe's `None`: it makes two unstamped copies look identical to the collision ranker. An INVALID carrier keeps its bytes even under `overwrite` — only an ABSENT one is stamped. Deterministic types supply `id_stable_key_fn`/`id_namespace`. Parsers receive the resolved value and do not mint.

### Dynamic properties

| Property | Description |
|----------|-------------|
| `schema_hash` | MD5 of structural fields as canonical JSON (first 16 hex chars). Stable across runs. |
| `extends` | Resolves `parent_type` string → `TypeInfo` via `SchemaRegistry.get`. |
| `subtypes` | All direct children registered with `parent_type == self.type_name` (returns `list[TypeInfo]`). |
| `type_id` | A `TypeId(type=self.type_name)` for this type. |

---

## Registration

A type's `TypeInfo` is assembled from up to two sources that merge into one entry:

### 1. Declarative metadata (`flow_sdk/schema/type_info/<type>_info.py`)

Each `<type>_info.py` module declares one (or more) `TypeMetadata` instance at module scope. Example (`skill_type_info.py`):

```python
SKILL = TypeMetadata(
    type=EntityType.SKILL,
    icon="Sparkles",
    browseable=True,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    main_subdir=".claude/skills",
    main_layout="folder",
    fts_content=("name", "description", "body"),   # from_disk_fn defaults to spec_extractor
    capsules=(CapsuleSpec("identity"),),
    identity_backend=capsule_identity(skill_id_from_folder),
    asset_hash_fn=skill_asset_hash,
)
```

`register_all()` (in `flow_sdk/schema/type_info/__init__.py`) walks every sibling `*_info` module via `pkgutil`, finds module-scope `TypeMetadata` instances, and calls `.register()` on each — which converts the `TypeMetadata` to a `TypeInfo` (`to_type_info()`, `locations=["index"]`) and hands it to `SchemaRegistry.register()`.

`register_all()` is wired into startup by importing `flow_sdk.fs_store.indexer.registrations` (which calls it at module load — `registrations.py:49`); `flow_sdk/server/app.py` imports that module so the declarative metadata (icons, `from_disk_fn`, etc.) lands before the first bootstrap.

`TypeMetadata` is the *declarative authoring* shape; `TypeInfo` is the *runtime registry record* it produces. A type may subclass `TypeMetadata` to add type-specific extras; the instance is attached to `TypeInfo.metadata` so base classes can read those extras, while the flat `TypeInfo` fields remain the single serialized surface.

### 2. Entity subclasses (`flow_sdk/db/drivers/db_base_record.py`)

When an `Entity` (`DBBaseRecord`) subclass is defined, `__init_subclass__` (`db_base_record.py:58`) fires and — unless the class is `_abstract` — resolves the type name via `cls.get_type()` and calls `SchemaRegistry.register(TypeInfo(type_name=..., locations=["index"], entity_cls=cls, browseable/creatable/indexed_by_default/api_visible/icon from the class `_*` ClassVars))`.

This is the **only** remaining `__init_subclass__` auto-registration. There is no `Record`/`_record_type` `__init_subclass__` registration — `flow_sdk/fs_store/record.py` does not exist; `FSRecord` (`flow_sdk/fs_store/fs_record.py`) is the lone record class and carries no per-type config.

### Merge semantics

`register()` is idempotent and **merges on re-register** (`schema_registry.py:357`). The declarative `TypeMetadata` and the Entity `__init_subclass__` typically both register the same `type_name`; the merge:
- unions `locations`,
- fills `entity_cls`, `metadata`, `meta_model`, and the per-type runtime refs (`post_sync_fn`, `from_disk_fn`, `capsules`, `identity_backend`, stable-key/namespace policy, `asset_hash_fn`, `default_body_fn`) on first non-None,
- OR-merges the boolean flags (`browseable`, `creatable`, `indexed_by_default`, `api_visible`),
- overwrites `icon`, `main_subdir`, `main_layout`, `index_fields` when the new value is set.

Registration order does not matter — whichever side imports first creates the entry, the other enriches it.

---

## Persistence

The `TypeInfo` registry is **rebuilt in-memory on every startup** from `register_all()` + Entity `__init_subclass__`; it is **not** persisted to disk. `TypeInfo` exposes `to_dict()` / `from_dict()` and a `schema_hash` property, but there is no code that writes a per-type `type_info.json`, and there is no `load_persisted()` method. (The module docstring at `schema_registry.py:6` still mentions a `type_info.json` file — that is stale.)

What *is* written under `~/.flow/schema/` is the scan/index **run-history JSONL** logs (see below), not type metadata.

---

## Scan/Index Orchestration

The actual scan/index **walk** is owned by the indexer package — `FSIndexer` (`flow_sdk/fs_store/indexer/`), built via `build_default_indexer()` and accessed through `get_shared_indexer()`. The HTTP-facing orchestration lives in `FsRecordsActionsMixin` (`flow_sdk/builtin/faas/fs_records_actions.py`) on the ComputeNode, which calls `get_shared_indexer().scan(...)`.

`SchemaRegistry` itself retains only the **registry queries, default-type list, run-history logging, status, clear, and errors** helpers below. The old `discover` / `incremental` / `index_type` / `_scan_type` / `rebuild_index` methods (and their `sync` / `sync_incremental` / `rebuild` aliases) are **no longer on `SchemaRegistry`** — that orchestration moved into the indexer + the ComputeNode mixin handlers.

### Method reference

| Method | Description |
|--------|-------------|
| `register(info)` / `register_crud_type(type_name, *, icon)` | Register or enrich a `TypeInfo`. `register_crud_type` adds a CRUD-only type with no indexer walker. |
| `get(type_name)` | Return the `TypeInfo` for a type name or `TypeId`, or `None`. |
| `get_subtypes(type_name)` | Direct children as `list[TypeInfo]`. |
| `get_entity_cls` / `is_entity_type` / `is_implemented` / `is_public_entity` | Entity-class lookups / predicates. |
| `get_all_entity_types` / `get_all_entity_classes` / `get_public_entity_types` | Bulk entity-type/class listings. |
| `is_api_visible` / `get_icon` / `is_browseable` / `is_creatable` / `is_indexed_by_default` | Presentation read-through getters. |
| `get_default_index_types()` | Return `indexed_by_default=True` types. Falls back to `_BUILTIN_DEFAULT_TYPES` if the registry list is empty. |
| `append_scan(...)` / `append_index(...)` | Write a scan/index entry to the run-history JSONL logs (global + per-type). |
| `get_last_scan_at` / `get_last_index_at` | Read the latest timestamp from a type's run-history JSONL. |
| `clear_index(types)` | Clear FTS index, entities, per-type index logs, and record errors. Aliased as `clear()`. |
| `get_index_status(types, scope)` | Return `IndexStatus` freshness snapshot (DB-free for freshness). Aliased as `get_status()`. |
| `get_errors(type_name)` | Return `RecordError` list (via `FSRecord.discover(RECORD_ERROR)`), optionally filtered by type. |

### Log files

All operations are logged to JSONL files:

```
~/.flow/schema/
  scan_log.jsonl              # global scan log (all types)
  index_log.jsonl             # global index log (written only by clear; see note)
  types/
    skill/
      scan_log.jsonl          # per-type scan log
      index_log.jsonl         # per-type index log
    agent/
      ...
```

(No `type_info.json` is written — `TypeInfo` is rebuilt in-memory at startup, not persisted.)

Each log file is capped at `_MAX_LOG_ENTRIES` = 100 entries (oldest trimmed on append). Note: `append_index` writes **per-type** logs only; the global `index_log.jsonl` is created/removed by `clear_index`, and the "global" last-indexed time is derived as `max(per_type.last_indexed_at)` in `get_index_status`.

### Result types

| Type | Fields |
|------|--------|
| `ScanResult` | `type_name`, `count`, `total_bytes`, `scan_ms`, `last_scan_at`, `records`, `avg_bytes`, `min_bytes`, `max_bytes` |
| `IndexResult` | `type_name`, `indexed`, `skipped`, `duration_ms`, `last_index_at`, `errors`, `fresh` |
| `IndexRequest` | `types`, `actions`, `start_time`, `end_time`, `trigger`, `limit_per_type` |
| `ClearResult` | `fts_cleared`, `entities_cleared`, `types_cleared` |
| `IndexStatus` | `never_indexed`, `last_indexed_at`, `stale`, `default_types`, `per_type`, `total_orphans` |
| `TypeIndexStatus` | `type_name`, `last_indexed_at`, `entity_count`, `stale`, `orphan_count` |

(`IndexRequest` is still a defined dataclass, but `SchemaRegistry` no longer has an `incremental(request)` method that consumes it.)

---

## Backward Compatibility

The old `flow_sdk/fs_records/schema_record.py` `SchemaRecord` re-export shim and the `fs_store/factory/type_registry.py` record-registry shim **no longer exist**. The only remaining legacy shim is the Entity registry:

- `schema/entity_factory.py` — `type_registry` is an `_EntityRegistryShim` instance that delegates all lookups to `SchemaRegistry` (`get(name)` → `SchemaRegistry.get_entity_cls(name)`, `is_registered`/`is_implemented`/`is_public`, `entity_models`, etc.). `register()` is a no-op (registration now happens via Entity `__init_subclass__` → SchemaRegistry). The `TypeRegistry` class alias is retained for `db_driver.py` type annotations; `RegistryEntry` has been removed.

The single canonical type-name enum is `EntityType` (`flow_sdk/schema/types.py`). The historical `RecordType` (`fs_store/record_types.py`) and `BuiltinEntityType` enums are now **aliases of `EntityType`**, re-exported from their old modules for backward compatibility — `RecordType = EntityType`.

`SchemaRegistry` is authoritative for both Record (`FSRecord`) and Entity lookups.

### Convenience methods on SchemaRegistry

| Method | Returns | Description |
|--------|---------|-------------|
| `get_entity_cls(type_name)` | `type \| None` | Entity class for the given type, or None |
| `is_entity_type(type_name)` | `bool` | True if an entity class is registered for this type |
| `is_implemented(type_name)` | `bool` | Alias for `is_entity_type()` |
| `is_public_entity(type_name)` | `bool` | True if entity class exists and `api_visible` is True |
| `get_all_entity_types()` | `list[str]` | All type names with a registered entity class |
| `get_all_entity_classes()` | `list[type]` | All registered entity classes |
| `get_public_entity_types()` | `list[str]` | Entity type names where `api_visible` is True |
| `get_all_record_types()` | `list[str]` | **Note:** currently returns type names with a registered entity class (same predicate as `get_all_entity_types`) — there is no separate `record_cls` concept. There is no `get_record_cls()`. |

### Duplicate entity registration

`SchemaRegistry.register()` raises `ValueError` if the same `type_name` is registered with two **different** entity classes (by fully-qualified class name). The first registration wins. This prevents silent shadowing bugs where a stub class could overwrite the full implementation.

---

## HTTP Endpoints

The ComputeNode (`FsRecordsActionsMixin` in `flow_sdk/builtin/faas/fs_records_actions.py`) exposes these `fs-records` endpoints, which read type metadata from `SchemaRegistry` and drive the shared `FSIndexer`:

| Endpoint | Handler | Description |
|----------|---------|-------------|
| `GET /fs-records/scan` | `_handle_fs_records_scan` | Aggregate or per-type scan stats |
| `POST /fs-records/index` | `_handle_fs_records_index` | Index all or one type, with optional `?rebuild=true` |
| `GET /fs-records/index-status` | `_handle_fs_records_index_status` | Freshness info |
| `DELETE /fs-records/index` | `_handle_fs_records_index_clear` | Clear FTS + entity DB |

---

## Usage Example

```python
# Register declarative per-type metadata (icons, browseable, from_disk_fn, ...).
# Importing the indexer registrations module runs register_all() as a side effect.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.fs_store.schema_registry import SchemaRegistry

# Inspect a type
info = SchemaRegistry.get("skill")
print(info.locations)           # ["index"]
print(info.schema_hash)         # "a3f1c2d4..."
print(info.indexed_by_default)  # True
print(info.from_disk_fn)        # <function extract_skill ...> (the generic spec_extractor)

# Find subtypes
children = SchemaRegistry.get_subtypes("transcript_entry")  # list[TypeInfo]

# Run a full scan via the shared indexer (orchestration is NOT on SchemaRegistry)
from flow_sdk.fs_store.indexer import get_shared_indexer
nodes = await get_shared_indexer().scan(...)

# Get freshness status
status = await SchemaRegistry.get_index_status()
print(status.never_indexed)  # True if never indexed
```
