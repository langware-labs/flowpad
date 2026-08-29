---
id: 7c2c149b-83be-576f-8dd0-d91b1ef11f39
---

# Record Model

This document describes the `FSRecord` class and the surrounding infrastructure in `flow_sdk/fs_store/`. The record layer is the on-disk shadow / index-source for every typed object in flow-cli: agent sessions, tasks, skills, hooks, settings, transcript entries, and more. Disk is the source of truth; the Entity/DB layer is a rebuildable index over it.

> **Renamed: `Record` → `FSRecord`.** The old `Record` base class (with a `_data` dict, `RecordStatus`, multiple `StorageLayout` variants, split `metadata.json` + `_data.json`, `__init_subclass__` auto-registration, and a `discover()` family) has been **deleted**. The current class is `FSRecord` in `flow_sdk/fs_store/fs_record.py` — a lean filesystem manifest. There are **no `FSRecord` subclasses**; all per-type behaviour lives in free functions registered on `TypeInfo` (see [TypeInfo and the SchemaRegistry](#typeinfo-and-the-schemaregistry)).

## Overview

`FSRecord` is a single concrete class. Construct as `FSRecord(type, id, **fields)`. The on-disk shadow lives at `<records_root>/<type>/<id>/metadata.json`. Meta fields are stored as **direct instance attributes** on the object's `__dict__` (not a `_data` dict). The record holds an `asset_ref` (`FSRef` to the user-facing source file) and a free-form bag of meta fields. Per-type typed metadata is `TypeInfo.effective_meta_model`: a hand-written `meta_model` when a type declares one, else — for a type with an `asset_spec` — derived as `BaseMeta ∪ spec fields ∪ Persist.TRUE fields − Persist.FALSE fields`.

The class deliberately omits, by design (see the module docstring at `flow_sdk/fs_store/fs_record.py:13`):

- `state.json` / `RecordState` / `PropertyRecord` lazy-cache machinery — per-type extractors precompute derived fields into meta.
- `raw_json` field + dict-like `__getitem__`/`__setitem__` shims.
- `fs_sync` auto-save on attribute mutation.
- `parent_ref` / `children_refs` / `origin_ref` — Entity owns parent/child edges via the DB.
- `discover_one(uid)` / `RecordStatus` / multiple storage layouts.
- polymorphic load fallbacks for legacy on-disk formats.

Source files:

| File | Purpose |
|---|---|
| `flow_sdk/fs_store/fs_record.py` | `FSRecord` class, on-disk + index-state helpers |
| `flow_sdk/fs_store/record_types.py` | `RecordType` / `SkillitRecordType` — backward-compat aliases of `EntityType` |
| `flow_sdk/schema/types.py` | `EntityType` — the single canonical type enum |
| `flow_sdk/fs_store/schema_registry.py` | `SchemaRegistry` singleton + `TypeInfo` per-type metadata |
| `flow_sdk/fs_store/record_paths.py` | records-root path helpers + `record_stem()` |
| `flow_sdk/fs_store/record_ref.py` | `RecordRef` / `RecordDataRef` dataclasses |
| `flow_sdk/fs_store/record_list.py` | `RecordList` (storage-agnostic collection over `FSRecord`) |
| `flow_sdk/fs_store/source_file_records.py` | source-file extractors (settings.json, .mcp.json, …) |
| `flow_sdk/fs_store/record_query.py` | `RecordQuery` filter/sort/paginate helper |
| `flow_sdk/fs_store/manifest.py` | `CollectionManifest` per-type collection manifest |
| `flow_sdk/fs_store/storage_layout.py` | `StorageLayout` enum (legacy; FSRecord is always folder) |

---

## Instance Storage

`FSRecord` has **no `_data` dict**. Every meta field is a plain instance attribute on `__dict__`. A small set of attribute names is reserved as system state and excluded from serialization:

```python
_SYSTEM_ATTRS: frozenset[str] = frozenset({"type", "id", "_asset_ref"})
```

The `meta` property (`fs_record.py:111`) returns a read-only dict view of the meta fields — every attribute that is not in `_SYSTEM_ATTRS` and does not start with `_`. If the record's type has an `effective_meta_model`, `meta` returns an instance of that Pydantic model instead of a dict (falling back to the raw dict on validation error).

`meta_dict()` (`fs_record.py:130`) is the flat dict used for serialization and for building the Entity DB row: it includes `type`, `id`, the `asset_ref` path string, and every non-system, non-`None`, non-`_`-prefixed attribute. `to_dict()` and the `data` property are backward-compat aliases that both delegate to `meta_dict()`.

---

## Identity

`FSRecord` carries exactly two identity fields, both reserved system attrs:

| Field | Type | Notes |
|---|---|---|
| `type` | `str` | Record type string, e.g. `"claude_session"`. Defaults to the `_record_type` ClassVar (empty by default). |
| `id` | `str \| None` | Stable identity for both the filesystem path and the Entity DB row. May be `None` until `save()` mints it. |

There is no `name`/`status`/`uid` property on the base class — `name`, `status`, `scope`, etc. are ordinary meta attributes when a caller sets them.

### `fingerprint` and id minting

`fingerprint` (`fs_record.py:179`) is a deterministic `uuid5(NAMESPACE_URL, f"{type}:{key}")` where `key` is the `asset_ref` path (or the `name` attr if there is no asset). It matches `Entity.allocate_id` so that indexing an existing entity's record never creates a duplicate.

`save()` mints `id = self.fingerprint` when `id` is `None`. A constructor-provided `id` always wins.

### Stem / folder naming

The shadow folder is named by the **bare id** under a `<type>/` parent — no stem, no separator. `record_stem(type, id)` / `parse_record_stem(stem)` (defined in `record_paths.py`, re-exported from `fs_record.py`) build the separate **portable** token `<type>-<id>` (`_NAME_SEP = "-"`) used in flat namespaces such as bundle arcs. The retired `<type>-@<uid>` spelling is still parsed for back-compat and never written.

---

## On-Disk Layout

An `FSRecord` is **always** a folder. There is no FILE or LIST_ITEM layout for `FSRecord` (the `StorageLayout` enum still exists in `storage_layout.py` but is legacy and unused by `FSRecord`).

```
<records_root>/<type>/<id>/
  metadata.json                 # the only file FSRecord writes: identity + meta fields
  <int_epoch>_<hexdigest>.hash  # index freshness sentinel (asset-backed records only)
```

`metadata.json` is a **single flat JSON object** — `meta_dict()` written via `json.dumps(..., indent=2)`. It is **not** wrapped in a `{"data": {...}}` envelope. There is no separate `_data.json`, no `state.json`, and no `_META_FIELDS` / `_ENTITY_META_FIELDS` / `_OLD_META_FIELDS` split.

> `from_dict()` (`fs_record.py:159`) does still unwrap a legacy top-level `{"data": {...}}` envelope on read, for compatibility with files written by the deleted `Record` class. New writes are always flat.

### Records root

`shadow_dir` resolves to `get_default_records_root() / type / record_stem(type, id)`. The root is looked up lazily on every access (`record_paths.get_default_records_root`), so tests can redirect it via `set_default_records_root(path)` / `FS_RECORD_PATH`. Data blobs (when present) live under a separate `get_default_records_data_root()`.

---

## Save / Load / Discover

| Method | Signature | Notes |
|---|---|---|
| `save()` | `() -> Path` | Mints `id` if absent, `mkdir -p`s the shadow folder, writes `metadata.json` (full `to_dict()`). |
| `save_metadata(patch)` | `(dict) -> Path` | The single DB→disk writer. Reads existing `metadata.json`, overlays `patch` (skipping `None` and system/`_` keys), re-anchors `type`/`id`, writes once. Updates in-memory attrs too. |
| `save_metadata_field(key, val)` | `(str, Any) -> Path` | Convenience single-field partial merge. |
| `current_meta_keys()` | `() -> set[str]` | Keys present in the on-disk `metadata.json` (empty set if none). |
| `load(type, id)` | `classmethod -> FSRecord` | Reads `<root>/<type>/<id>/metadata.json`. Raises `FileNotFoundError` if absent. |
| `load_or_none(type, id)` | `classmethod -> FSRecord \| None` | Like `load` but returns `None` on a missing shadow. |
| `load_record(path)` | `classmethod -> FSRecord` | Loads from a shadow folder OR a direct `metadata.json` path. |
| `discover(type)` | `classmethod -> list[FSRecord]` | Walks `<root>/<type>/`, loading each child shadow via `load_record`; skips malformed entries. |
| `count(type)` | `classmethod -> int` | Counts shadow folders for `type` without reading/parsing any `metadata.json`. |

There is **no** `discover_one`, `init_record`, `init`, `clone`, `move`, `read_record`, `save_record_json`, `write_record`, `persist`, or `open()` on `FSRecord`.

---

## FSRefs

`FSRecord` exposes filesystem pointers as computed properties, never as hardcoded path strings:

| Property | Type | Notes |
|---|---|---|
| `record_folder_ref` | `FSRef` | The shadow folder. |
| `metadata_ref` | `FSRef` | `<shadow_dir>/metadata.json`. |
| `asset_ref` | `FSRef \| None` | The primary user-facing content file/folder. Backed by `_asset_ref`; the setter coerces a `str` into an `FSRef`. Only the path string is persisted (in `metadata.json`). |
| `main_ref` | `FSRef \| None` | Alias for `asset_ref`. |
| `shadow_dir` | `Path` | `records_root/<type>/<id>/`. Raises if `type`/`id` unset. |

`ensure_asset_ref()` binds `asset_ref` from a `fs_storage_mount_path` / `cwd` meta attr when it is not already set, so index-state properties resolve for records loaded from disk.

`compute_asset_ref(scope_root, entity)` resolves the user-facing asset location under `scope_root` using the registered `TypeInfo.main_subdir` / `main_layout` (`"file"` → `<safe_name>.md`, `"folder"` → `<safe_name>/`). The asset itself is written by the type's **serializer** (`TypeInfo.serializer(origin).store(entity, origin)`, `flow_sdk/fs_store/serializer/`): `DiskSerializer` renders the `asset_spec`-declared main doc plus every `FileRef` / `FolderSpec` / sub-asset / rows field, writing the main doc iff it does not yet exist (or on every save for `owns_main_ref` types), then commits the entity id to the asset's identity carrier and returns the origin with `id` set. A type with no `asset_spec` renders through `TypeInfo.default_body_fn` under the same exists/owns rule. There is no other writer. When carrier writes are suppressed for the operation (see [asset capsules](asset-capsules.md)) the proposed id is returned untouched and the source file is never rewritten.

---

## Index State (on-disk, zero DB)

The freshness oracle lives beside the record in its `shadow_dir`, never in the DB — so the index layer never reads the store it produces. A single sentinel file named `<int_epoch>_<hexdigest>.hash` encodes both the last-indexed time and the source hash at that index.

| Member | Notes |
|---|---|
| `get_hash()` / `record_hash` | Digest (blake2b, 8-byte) of the asset's current freshness token — `TypeInfo.asset_hash_fn(asset_ref)` if registered, else `FSRef.fingerprint` (mtime+size). Empty string when there is no asset. |
| `indexed_hash` | Source hash captured at the last index, parsed from the sentinel filename; `None` if never indexed. |
| `indexed_at` | ISO-8601 UTC time of the last index, parsed from the sentinel filename. |
| `index_required` | `True` when `record_hash != (indexed_hash or "")` — the source changed since the last index (or was never indexed). |
| `orphan` | `True` when the record's `asset_ref` no longer exists on disk. |
| `write_hash()` | Stamps `<now>_<record_hash>.hash`, replacing any prior sentinel. No-op for asset-less records. |
| `clear_hash()` | Removes the sentinel so the record reads as never-indexed. |
| `clear_hashes_for_type(type)` | Bulk counterpart — drops every sentinel under `<root>/<type>/`. |

---

## `asset_ref` and folder queries

For Entity types whose record carries an external content file (skills, agents, workflows, markdown docs, …), the entity row stores an `asset_ref` field with the absolute path of that file or folder.

**Storage format — canonical POSIX.** Paths are normalised on write via `flow_sdk.fs_store.path_utils.canonical_posix_path` = `unicodedata.normalize("NFC", Path(p).resolve().as_posix())`. This:

- collapses `\` vs `/` (Windows paths become `C:/Users/...`);
- canonicalises case on macOS APFS / Windows NTFS via `Path.resolve()`;
- folds NFD vs NFC differences from macOS APFS filenames.

The conversion runs in `Entity._prepare_for_storage()` at the single write site `flow_sdk/core/entity/entity_model.py:1289`. Existing rows written before this rule was introduced may retain non-canonical values until the next save; a one-shot backfill can re-save them.

**Query — `Entity.assets_by_path(PathQueryOptions)`** (`entity_model.py:295`). Returns entities whose `asset_ref` is a strict descendant of any of `opts.search_dirs`, optionally narrowed by `opts.types`. Pushdown uses a half-open lex range against `json_extract(data, '$.asset_ref')`:

```sql
asset_ref >= '<dir>/'  AND  asset_ref < '<dir>0'
```

`/` is `0x2F`; the next codepoint `0` (`0x30`) terminates the range. Multiple search dirs are OR'd, types are AND'd via `IN`. The query reads `asset_ref` only — `parent_path` and `vault_root` are not consulted.

The dir itself is **not** returned — only strict descendants. Querying for `<dir>` where the dir IS an entity's `asset_ref` returns an empty list.

HTTP wrapper: `GET /api/v1/assets/by-path?folder=<abs>&record_type=<type>` (both `folder` and `record_type` are repeatable). See `flow_sdk/server/routes/assets.py:107`.

---

## Constructor Calling Patterns

The `__init__` signature is:

```python
def __init__(self, type: str = "", id: str | None = None, **fields: Any) -> None
```

```python
r = FSRecord("claude_session", "abc-123", name="my-session", prompt="hello")
# type/id are reserved; everything else lands as a meta attr on __dict__.
# Passing asset_ref="..." (str) is coerced into an FSRef via the setter.
```

`type` falls back to the class `_record_type` ClassVar when omitted. `id` may stay `None` until `save()` mints it from `fingerprint`.

### Loading via `from_dict`

```python
rec = FSRecord.from_dict(flat_dict)
```

Unwraps a legacy `{"data": {...}}` envelope if present, drops `None` values, pops `type`/`id`/`asset_ref`, and rebuilds the instance. The `asset_ref` string is re-wrapped into an `FSRef`.

---

## TypeInfo and the SchemaRegistry

There are no `FSRecord` subclasses and no `__init_subclass__` auto-registration. Type metadata is owned by `SchemaRegistry` (`flow_sdk/fs_store/schema_registry.py`), keyed by the type string. Each entry is a `TypeInfo` dataclass (`schema_registry.py:199`):

| Field | Purpose |
|---|---|
| `entity_cls` | Paired `Entity` subclass for the type (DB index). |
| `icon` / `browseable` / `creatable` / `api_visible` | Catalog/UI metadata. |
| `meta_model` | Optional hand-written Pydantic model for the `meta` view; read via `effective_meta_model`, which derives one from the type's `asset_spec` when absent. |
| `default_origin_kind` / `serializer(origin)` | Which `DataSerializer` stores/loads the type (`"local"` disk, `"db"`, `"hub"`); `name_from_folder`, `rows_layout_field`, `hub_main_file` are its layout facts. |
| `from_disk_fn` | Cold-path parser: `(FSRef, resolved_id) -> list[FSRecord]`. |
| `capsules` / `identity_backend` | Named capsule declarations and the canonical-plus-legacy/native identity carrier. |
| `id_stable_key_fn` / `id_namespace` | Optional deterministic key and UUID namespace used by `TypeInfo.mint_entity_id()` for provider/natural/path-v5 identities. |
| `asset_hash_fn` | Cheap freshness token: `(FSRef) -> ...`. |
| `post_sync_fn` | Async hook run after `sync_to_db`. |
| `default_body_fn` | Default body for a type with no `asset_spec` (`dynamic_workflow`); spec-bearing types render through `DiskSerializer.render`. |
| `main_subdir` / `main_layout` | Asset placement under the user's scope root. |

Per-type `TypeInfo` definitions live in `flow_sdk/schema/type_info/<type>_info.py` and are registered via `SchemaRegistry.register(info)` (merging into any existing entry). `SchemaRegistry` is the single source of truth for types — `get(type)`, `get_all_types()`, `get_entity_cls(type)`, `get_icon(type)`, etc.

### Type enum: `EntityType`

There is now **one** canonical type enum: `EntityType` (a `StrEnum`) in `flow_sdk/schema/types.py`. It replaces the two historical enums — `RecordType` (fs_store) and `BuiltinEntityType` (db) — which are now thin aliases:

```python
# flow_sdk/fs_store/record_types.py
from flow_sdk.schema.types import EntityType
RecordType = EntityType
SkillitRecordType = EntityType
```

String **values** are persisted in the DB and on the filesystem (`record.type`, `TypeId.type`), so they must never change. New code should import `EntityType` directly; the `RecordType` / `SkillitRecordType` names remain only for backward compatibility during the migration.

---

## RecordRef

`RecordRef` is a `@dataclass` in `flow_sdk/fs_store/record_ref.py`. A lightweight pointer used for clone provenance and external-data addressing. `FSRecord` itself **no longer carries `parent_ref` / `children_refs` / `origin_ref` / `data_ref` properties** — Entity owns parent/child edges via the DB. `RecordRef` survives for the source-file / data-pointer use cases.

```python
@dataclass
class RecordRef:
    id: str = ""
    type: str = ""
    path: str | None = None          # filesystem path (to record or data file)
    json_path: str | None = None     # RFC 6901 pointer
    key_field: str | None = None
    key_value: str | None = None
```

`RecordRef.content_hash` is a deterministic 12-char md5 of the addressing fields. `RecordRef.from_dict` returns a `RecordDataRef` subclass when a `format` key is present; `RecordDataRef` adds a `format` field plus `resolve_data_dir()` / `resolve_data_file()` helpers that target the records-data root (`~/.flow/records_data/<type>/<id>/`).

---

## DB integration

`FSRecord` is the bridge into the Entity DB.

### `sync_to_db()`

```python
await record.sync_to_db(fts_batch=None, notify=True)
```

Persists this record into the Entity DB + FTS + wiki, all inside a single shared DB session (`fs_record.py:530`):

1. Entity row via `Entity.from_record(self)`.
2. Mirror DB state back to `metadata.json` via `sync_from_entity`.
3. FTS upsert — an `FtsEntry` read directly from `search_title` / `search_description` / `search_content` instance attrs (batched if `fts_batch` is provided, else immediate).
4. Wiki edge re-extraction over `wiki_body()`.
5. Type-specific `TypeInfo.post_sync_fn(self)`.

On any exception it records a `RecordError` and re-raises.

### `sync_from_entity(entity)`

Pulls canonical state (`id`, `scope`, `project_id`, `updated_date`, `asset_ref`) from the DB back into instance attrs, and `save()`s if anything changed. Returns `True` on change.

### `unindex()` / `destroy()` / `delete()`

`unindex()` removes the Entity row, FTS entry, and wiki edges. `destroy()` calls `unindex()` then `shutil.rmtree(shadow_dir)`. `delete()` is an alias for `destroy()` — full purge.

### Wiki links

`get_links()` / `get_backlinks()` return outgoing / inbound wiki edges via `flow_sdk.wiki`.

---

## Search fields

FTS reads are default readers over instance attrs — type-specific extractors populate these fields directly during parsing:

| Property | Source |
|---|---|
| `search_title` | `title` → `name` |
| `search_content` | `content` → `body` |
| `search_description` | `description` |
| `wiki_body()` | `body` → `content` |

---

## RecordList

`RecordList` in `flow_sdk/fs_store/record_list.py` is a thin storage-agnostic typed collection backed by `FSRecord`. The caller passes a **type name string** (not a record class):

```python
from flow_sdk.fs_store.record_list import RecordList

lst = RecordList(type_name="claude_session", scope=Scope.USER)
```

Discovery is always live (no caching).

| Method | Signature | Notes |
|---|---|---|
| `get(uid)` | `(str) -> FSRecord \| None` | `FSRecord.load_or_none(type_name, uid)` |
| `__iter__` | | `FSRecord.discover(type_name)` |
| `__len__` | | `FSRecord.count(type_name)` — count-only, no parses |
| `create(record \| dict)` | `-> FSRecord` | Raises `ValueError` on duplicate id; calls `save()` |
| `save(record)` | `-> None` | `record.save()` |
| `update(uid, data)` | `-> FSRecord` | `save_metadata(patch)`; raises `KeyError` if missing |
| `delete(uid)` | `async -> bool` | `shutil.rmtree(shadow_dir)`; returns `True` if existed |
| `query(q)` | `-> list[FSRecord]` | Applies a `RecordQuery` in-memory over discovered records |

---

## Source-file extractors

`flow_sdk/fs_store/source_file_records.py` replaces the dissolved `JsonFileRecordList` / `SourceFileRecordList` Record-subclass hierarchy. Each extractor is a **pure function** `(data: dict, source_file: str) -> list[dict]`, where each returned dict carries at least `type` (a `RecordType`/`EntityType` value) and `json_path` (RFC-6901 pointer; empty string for the root record).

Registered extractors (`_EXTRACTORS`): `settings.json`, `settings.local.json`, `managed-settings.json`, `mcp.json`, `.mcp.json`. The allow-list `_ALLOWED_FILENAMES` is derived from `_EXTRACTORS` so it can't drift. Public surface: `known_filename(path)`, `extract_from_data(data, path)`, `extract_records(path)`, plus `load_raw` / `write_raw` and the JSON-pointer set/delete helpers.

The path-based API handler in `fs_records_actions._handle_path_based_source_file` delegates here.

---

## RecordQuery

`RecordQuery` in `flow_sdk/fs_store/record_query.py` is a `@dataclass` for declarative filter, sort, and pagination. All filter fields are optional and AND-ed together. Apply with `q.apply(records)` (or via `RecordList.query(q)`).

### Filter fields

| Field | Type | Behavior |
|---|---|---|
| `ids` | `list[str] \| None` | Keep records whose `id` is in the list |
| `types` | `list[str] \| None` | Keep records whose `type` is in the list |
| `status` | `str \| list[str] \| None` | Keep records whose `str(status)` matches |
| `created_after` / `created_before` | `datetime \| None` | Compare against `created_at` |
| `modified_after` / `modified_before` | `datetime \| None` | Compare against `modified_at` |
| `parent_id` | `str \| None` | Keep records whose `parent_ref.id == value` |
| `child_filter` | `RecordQuery \| None` | Recursive composition |
| `scope` | `Scope \| None` | Value-coerced comparison against `record.scope` |
| `field_predicates` | `dict[str, Any] \| None` | Exact-match `getattr(record, key) == expected` |
| `predicate` | `Callable[[Record], bool] \| None` | Arbitrary caller-supplied function |

### Sort and pagination fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `sort_by` | `str \| None` | `None` | Attribute name to sort by (`None` values pushed to the end) |
| `sort_desc` | `bool` | `True` | Descending order |
| `limit` | `int \| None` | `None` | Max records to return |
| `offset` | `int` | `0` | Skip this many records |

`to_provider_params()` serializes the query to a pushdown-safe dict for external providers.

### Usage example

```python
from flow_sdk.fs_store.record_query import RecordQuery
from datetime import datetime

q = RecordQuery(
    types=["claude_session"],
    status="active",
    modified_after=datetime(2026, 1, 1),
    sort_by="modified_at",
    sort_desc=True,
    limit=20,
)

results = record_list.query(q)
```

---

## CollectionManifest

`CollectionManifest` in `flow_sdk/fs_store/manifest.py` tracks collection-level metadata (a monotonically bumped version) per record type. `bump(op)` is called on collection mutations; `read()` / `needs_refresh(last_seen_version)` / `rebuild(record_ids)` support the discovery layer. Unlike the old `Record.save()`, `FSRecord.save()` does **not** itself bump a manifest — manifest maintenance is driven by the indexer/discovery layer.
