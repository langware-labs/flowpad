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
    browseable_by: ViewMode | None = None   # minimum view mode; None ⇒ never browseable
    creatable: bool = False
    api_visible: bool = False
    icon: str | None = None
    parent_type: str | None = None    # string only, resolved lazily
    locations: list[str] = ...        # "index" (and/or "record")
    display_name: str | None = None   # presentational; deliberately NOT hashed

    # --- Runtime refs (NOT in hash, NOT persisted) ---
    entity_cls: type | None            # the Entity subclass (db_base_record)
    asset_spec: type | None            # the DataSpec that IS the type's layout
    post_sync_fn / from_disk_fn / asset_hash_fn / default_body_fn / derive_fields_fn: Any
    capsules: tuple[CapsuleSpec, ...]
    identity_carrier: IdentityCarrier | None
    identity_key_fn / id_stable_key_fn: Any   # v5 key (preferred / escape hatch)
    id_namespace: UUID = NAMESPACE_URL
    owns_main_ref / parent_share_on_default / shared_child / db_only: bool
    cloud_file_transport: "embedded" | "git"
    metadata: Any                      # the TypeMetadata instance it was built from
    meta_model: Any                    # per-type pydantic FS↔DB schema model

    # --- Serialization slots (HOW/WHERE; runtime-only) ---
    default_origin_kind: str = "local"          # "db" for db_only types
    name_from_path: bool = False
    manifest_layout: str | None = None          # "sections" | "flat"
    rows_layout_field: str | None = None
    hub_main_file: str | None = None
    natural_key / digest_fields: tuple[str, ...] | None
    digest_field: str = "content_digest"
    fts_content: tuple[str, ...] = ()

    # --- Placement axis (replaces the fused ``.claude/…`` subdir) ---
    asset_class: AssetClass | None     # "internal" | "harness" | "shared" | "repo" | "docs" | …
    harness: HarnessType | None
    family: str | None                 # bare leaf subdir ("skills", "docs")
    main_layout: str = "file"          # "file" | "folder"
    main_file: str | None = None       # inner main file of a folder asset ("SKILL.md")
    main_file_is_asset_ref: bool = False
    main_ext: str = ".md"
    # main_subdir is a DERIVED read-only property (claude-default family subdir)

    # --- Sharing / reception seams (runtime-only) ---
    assignee_owned_fields / pack_exclude: tuple
    setup_skill: str | None; reception_verb: str = "Open"
    receive_policy: str | None; receive_row_overrides: dict | None
```

`main_subdir` is no longer a stored field: it is a property derived from the placement axis (`asset_class` / `harness` / `family`), kept so legacy consumers keep working. Serialization-slot fields are tagged `metadata={"serialization": True}` (`_SERIALIZATION_SLOTS`) and merge by "declared non-default value wins".

There is **no `record_cls` field** — `FSRecord` is now the single concrete record class (no `Record` subclasses), so a per-type record class is no longer registered. Per-type record behavior lives in free functions and declarative runtime slots (`from_disk_fn`, `capsules`, `identity_carrier`, etc.) attached to the `TypeInfo`, not on a subclass.

`TypeInfo.mint_entity_id(ref, *, proposed_id=None, owner_id=None, live_ids=None)` is the ONE identity seam (read the carrier → owning row → mint and write); `TypeInfo.read_id(ref)` is the pure read; `extract_id`/`mint_id`/`resolve_id`/`_observe`/`_derive` are gone. The type's `identity_carrier` says where the id lives (a markdown main document's frontmatter, a folder's json capsule, a report's JSON root, or derived), reads legacy carriers, and TypeInfo applies the UUID v4/v5 adoption policy.

Resolution order is **carrier → owning row → mint**, by carrier LIVENESS: the carrier wins unless a row owns this path (`owner_id`) AND the carrier is provably dead (`live_ids` is the oracle; `None` means "cannot prove dead", so only the index walk — which holds the complete per-type id set — may conclude a carrier is a fossil). The signature is `mint_entity_id(ref, *, proposed_id=None, owner_id=None, live_ids=None) -> str`; a `proposed_id` that is not a valid v4/v5 raises. There are no `derive`/`overwrite` flags any more — the write decision is made from the ref and the carrier alone: a write happens only when the carrier is writable, the ref is not `read_only`, and carrier writes are not suppressed for a git-tracked source (`carrier_writes_are_suppressed`). Those gates are the same for every caller.

An INVALID carrier (a hand-written v7) keeps its bytes and gets a stable path-derived v5; only an ABSENT carrier is stamped. A legacy markdown capsule is converted into the frontmatter in place, id unchanged. Deterministic types supply `identity_key_fn` (key text `f"{type}:{key}"`) or the `id_stable_key_fn` escape hatch, plus `id_namespace`; `TypeInfo.stable_key_for(ref)` is the one place that shape is resolved. The read-only probe is `read_id(ref)`; per-type `*_peek_entity_id` helpers (e.g. `subagent_peek_entity_id`) wrap it for request handlers that must never write. Parsers receive the resolved value and do not mint.

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
    icon="FileBadge",
    displayName="Skills",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    cloud_file_transport="git",
    index_fields=["description"],
    asset_class="shared",
    family="skills",
    main_layout="folder",
    main_file="SKILL.md",
    hub_main_file="SKILL.md",
    fts_content=("name", "description", "body"),
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=folder_md_identity(skill_id_from_folder),
    asset_hash_fn=skill_asset_hash,
    asset_spec=SkillSpec,                 # from_disk_fn defaults to spec_extractor
    derive_fields_fn=derive_skill,
    setup_skill=EntityType.SKILL.value,
    reception_verb="Run",
)
```

`register_all()` (in `flow_sdk/schema/type_info/__init__.py`) walks every sibling `*_info` module via `pkgutil` (skipping `_`-prefixed helpers such as `_report.py`), finds module-scope `TypeMetadata` instances, and calls `.register()` on each — which converts the `TypeMetadata` to a `TypeInfo` (`to_type_info()`, `locations=["index"]`, every slot copied by name with only `type→type_name` / `displayName→display_name` renamed) and hands it to `SchemaRegistry.register()`. Each module is registered independently: a module that fails to import or register is **logged and skipped** (that one type is missing; the registry stays usable) rather than wedging startup — the guard against a stale `*_type_info.py` referencing a removed `EntityType` member. After the loop, `SchemaRegistry.check_asset_specs()` runs once every entity class is complete and **raises** on a spec/row mismatch.

`register_all()` is wired into startup by importing `flow_sdk.fs_store.indexer.registrations` (which calls it at module load — `registrations.py:68`, after the entity and walker imports so `entity_cls` merges in); `flow_sdk/server/app.py` imports that module so the declarative metadata (icons, `from_disk_fn`, etc.) lands before the first bootstrap. `build_default_indexer()` imports it too, so building the indexer is a second chokepoint that guarantees a complete registry.

`TypeMetadata` is the *declarative authoring* shape; `TypeInfo` is the *runtime registry record* it produces. A type may subclass `TypeMetadata` to add type-specific extras; the instance is attached to `TypeInfo.metadata` so base classes can read those extras, while the flat `TypeInfo` fields remain the single serialized surface.

### 2. Entity subclasses (`flow_sdk/db/drivers/db_base_record.py`)

When an `Entity` (`DBBaseRecord`) subclass is defined, `__init_subclass__` (`db_base_record.py:103`) fires and — unless the class is `_abstract` — resolves the type name via `cls.get_type()` and calls `SchemaRegistry.register(TypeInfo(type_name=..., locations=["index"], entity_cls=cls, browseable_by/creatable/indexed_by_default/api_visible/icon from the class `_*` ClassVars))`.

This is the **only** remaining `__init_subclass__` auto-registration. There is no `Record`/`_record_type` `__init_subclass__` registration — `flow_sdk/fs_store/record.py` does not exist; `FSRecord` (`flow_sdk/fs_store/fs_record.py`) is the lone record class and carries no per-type config.

### Merge semantics

`register()` is idempotent and **merges on re-register** (`schema_registry.py:924`). The declarative `TypeMetadata` and the Entity `__init_subclass__` typically both register the same `type_name`; the merge:
- unions `locations`, merges `defaults` (new keys win),
- **overwrites with the incoming value when it is set** for the runtime refs (`post_sync_fn`, `from_disk_fn`, `identity_carrier`, `id_stable_key_fn`, `asset_hash_fn`, `default_body_fn`, `metadata`, `meta_model`), the placement axis (`asset_class`, `harness`, `family`, `main_layout`, `main_file`, `main_ext`), every serialization slot (`_SERIALIZATION_SLOTS` — a declared non-default value wins), `icon`, `display_name`, `index_fields`, and the reception seams,
- merges `capsules` by name and **raises `ValueError`** when two registrations declare the same capsule name differently; likewise raises on two *different* `identity_carrier`s for one type,
- OR-merges the boolean flags (`creatable`, `indexed_by_default`, `api_visible`, `owns_main_ref`, `parent_share_on_default`, `shared_child`, `db_only`, `main_file_is_asset_ref`); `browseable_by` keeps the **more permissive** (lower-ranked) non-null view mode; `cloud_file_transport` latches to `"git"`,
- fills `entity_cls` on first non-None and raises on a different class (see [Duplicate entity registration](#duplicate-entity-registration)).

After the merge, if the final entry has an `asset_spec`, no `from_disk_fn`, and is not `db_only`, `from_disk_fn` is filled with the generic `spec_extractor(type_name)` — the spec IS the parser — and the serializer's `field_kinds` cache is cleared because a new asset type can turn a field into a sub-asset. Registration order does not matter — whichever side imports first creates the entry, the other enriches it.

---

## Persistence

The `TypeInfo` registry is **rebuilt in-memory on every startup** from `register_all()` + Entity `__init_subclass__`; it is **not** persisted to disk. `TypeInfo` exposes `to_dict()` / `from_dict()` and a `schema_hash` property, but there is no code that writes a per-type `type_info.json`, and there is no `load_persisted()` method.

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
| `is_api_visible` / `get_icon` / `get_display_name` / `browseable_by` / `is_browseable_in(type, mode)` / `is_creatable` / `is_indexed_by_default` | Presentation read-through getters (`is_browseable` is gone — visibility is a view-mode question). |
| `get_all_types()` / `get_repo_types()` / `repo_family_to_info()` / `repo_family_to_type()` / `harness_scoped_families()` / `get_shared_child_types()` | Registry-wide listings driven by the placement axis and sharing flags — `get_repo_types()` is what `build_default_indexer()` feeds `repo_assets_fn`. |
| `register_kind(kind, shape)` / `kind_for(shape)` / `kind_type(kind)` | The `DataSpec` kind namespace; `kind_type` falls through to `entity_cls` so an entity type name is a kind. |
| `check_asset_specs()` | Post-registration pass: raises when a type's `asset_spec` disagrees with its entity row. |
| `get_asset_stats(scope)` | Live per-type asset counts for a `ScopeFilter` (`AssetStats`; counts only). |
| `project_never_indexed(project_id)` | Whether a project record has never had its index sentinel stamped. |
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
| `ClearResult` | `fts_cleared`, `entities_cleared`, `types_cleared` |
| `IndexStatus` | `never_indexed`, `last_indexed_at`, `stale`, `default_types`, `per_type`, `total_orphans` |
| `TypeIndexStatus` | `type_name`, `last_indexed_at`, `entity_count`, `stale`, `orphan_count` |
| `AssetStats` | `per_type` (`{type: count}`), `total` |

`ScanResult` and `IndexRequest` no longer exist. The indexer's own run result is `IndexResult` / `PerTypeIndexResult` in `flow_sdk/fs_store/indexer/index_function.py` (`per_type`, `total_indexed`, `total_errors`, `duration_ms`, orphan / same-path-dupe / duplicate-occurrence totals), not a `SchemaRegistry` type.

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
| `get_all_types()` | `list[str]` | Every registered type name, entity-backed or not (waypoints, CRUD-only types included) |

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
| `GET /fs-records/asset-stats` | `_handle_fs_records_asset_stats` | Live per-type counts for a scope (`get_asset_stats`) |
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

## Path → layout

`TypeInfo.layout_of(path, *, verify=False) -> Layout(kind, root, body, ref)` is the one
classifier: a folder type names its folder (`FOLDER`) or the inner main file (`MAIN_FILE`,
root = parent); a file type names the file (`FILE`); `NONE` otherwise. Names compare
case-insensitively; `verify=True` also requires the bytes to exist (the indexer's gate).
`storage_root_for`, `body_path_for` and `carrier_path_for` are one-line
projections of it; `asset_ref_for(root)` is the inverse. Never re-derive "is this the main
file" at a call site.
