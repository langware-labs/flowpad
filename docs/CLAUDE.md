# Record System Requirements

1. Disk is the source of truth. Records are scanned from disk; Entities are a DB index for fast query only. The entire Entity/DB layer can be deleted and rebuilt from disk without any data loss.

2. `FSRef` (`flow_sdk/fs_store/fs_ref.py`) is a lightweight declarative file/folder reference — wraps a path with read/write/child/stat methods. `JSONFsRef(FSRef)` is a write-through JSON ref: attribute writes go directly to the file; `_json_data: dict` is the in-memory cache. `TextFsRef(FSRef)` wraps plain-text files. All exported from `flow_sdk/fs_store/__init__.py`.
   - Use FSRef (or subclasses) for all file-pointing inside records — never hardcode `record_dir / "filename"` strings.
   - Named child refs are computed properties on the record class.
   - `record.self_ref` → record folder FSRef; `record.asset_ref` → primary external content FSRef (Python-side); `record.main_ref` → primary content ref exposed to frontend (default: `data/_data.json` as `JSONFsRef`; subclasses override, e.g. `SkillRecord.main_ref` → `TextFsRef(SKILL.md)`).
   - `FSRef.to_dict(type_id)` serializes to `{path, ref_type, read_only, type_id}`. TypeScript: `FSRef.fromJson(json)` reconstructs from the dict. `entity.record()` calls `GET /record/refs` and returns a `Record` with `selfRef` + `mainRef`.

3. A Record folder contains: `metadata.json` (`JSONFsRef`, identity fields: id, type, name), `state.json` (`JSONFsRef`, discovery/property cache), zero-size `<hash>.<timestamp>.hash` sentinel files, and a `data/` subfolder (subclass-owned namespace).
   - `_data` is the single in-memory dict — never read `metadata.json` directly; use record property accessors.

4. A Record is always a folder at `~/.flow/records/<type>/<type>-@<uid>/`. There is no other layout.
   - `record.self_ref` points to the record folder; `record.asset_ref` points to the primary content file.
   - Use `get_default_records_root()` / `set_default_records_root()` (both in `flow_sdk/fs_store/record.py`) to redirect in tests — always restore in teardown.

5. `state.json` is a `JSONFsRef` in the record folder — stores discovery timestamps and cached `PropertyRecord` values. Writes are direct JSON updates; no batch API.
   - Fields: `fields` (dict of cached PropertyRecord values, keyed by property name).

6. `metadata.json` is a `JSONFsRef` — holds identity fields (`id`, `type`, `name`). `meta_dict()` reads from it and returns a structured dict for the Entity DB row.
   - Override `meta_dict()` in subclasses to add extra entity columns. Use `self.id`, `self.name`, etc. — never read `_data` directly inside `meta_dict()`.

7. The `data/` subfolder (`record_data_dir`) is a subclass-owned namespace. Subclasses declare named `JSONFsRef` children as computed properties (e.g. `JSONFsRef(self.record_data_dir / "name.json")`). The base class writes nothing to `data/`.

8. Write protection is FSRef-level: `_is_read_only()` checks whether `asset_ref` or `self_ref` carries `read_only=True`. Read-only is inherited from parent FSRef — marking a parent read-only blocks writes on all its children. External and read-only are independent axes.

9. `Record.fingerprint` is an overridable hook returning a unique content string. When no explicit `id` is given at construction and `fingerprint` returns a non-empty value, the record id is `uuid5(NAMESPACE_DNS, fingerprint)`. No fingerprint → random `uuid4`. Constructor-provided `id` always wins.
   - Subclasses override `fingerprint` to use mtime+size of external files, content hashes, or any stable unique string.

10. `record.asset_ref` is an `FSRef` pointing to the record's primary content file — may be inside the record folder or anywhere on the filesystem. `record.self_ref` points to the record's own metadata folder. Only `asset_ref` path is persisted in `metadata.json`; `self_ref` is computed at runtime. Neither lives in `_data`.

11. Parent, child, and origin refs are plain TypeId strings.
    - `record.parent_ref` → `str | None`; `record.children_refs` → `list[str]`; `record.origin_ref` → `str | None`.
    - `record.add_child(child)` accepts a `Record` or TypeId string. Dedup applied by id.

12. Record has `type`, set from `_record_type: ClassVar[str]` which subclasses declare; registers the type in `SchemaRegistry` via `__init_subclass__`.
    - Every concrete `Record` subclass must declare `_record_type: ClassVar[str] = RecordType.XYZ`.
    - `RecordType` constants live in `flow_sdk/fs_store/record_types.py`. Add new types there first.

13. `record.id` is the sole stable identity — used for both filesystem paths and the Entity DB row. Either constructor-provided or derived from `fingerprint` (see rule 9). There is no separate `uuid` property.

14. `JSONFsRef` has a `hash` property — SHA256 of the file content. `FSRef` has a `fingerprint` property — lightweight mtime+size-based content token. `Record.fingerprint` overrides this with a subclass-specific string for deterministic id derivation.

15. The index staleness sentinel is an empty file named `<record.fingerprint>.<timestamp>.hash` stored in the record folder. Written by `record.write_hash_file()`, called automatically by `sync_from_entity()` after a successful entity sync.
    - Old sentinel files are deleted when a new one is written. Multiple `.hash` files indicate an interrupted write — the newest wins.

16. `Record.index_required` returns `True` when the hash sentinel file is absent — the record has not been indexed since last write. Does NOT check fingerprint match or TTL.
    - TTL-based staleness is `record.record_update_required(ttl=30.0)` — use this for live-refresh decisions.
    - `sync_from_entity()` writes the sentinel, making `index_required` return `False` immediately.
    - To force re-index: delete the `.hash` sentinel files. `SchemaRegistry` incremental indexing uses `index_required` to decide which records to process.

17. `Entity.store()` syncs entity fields down to `metadata.json` via `record.sync_from_entity(self)`. The record is loaded once (or initialised on first call if it doesn't exist). Subsequent `store()` calls write updated fields directly.
    - Errors are logged as `RecordError` and never propagated — `store()` returns `None` on failure.

18. TypeScript: `asset.assetRefFor(fsTypeId)` returns `FSRef | undefined` with `.read()` and `.write()` async methods. Use this instead of direct `fsManager.download()` / `fsManager.writeFile()` calls.
    - `FSRef` is defined in `ts_sdk/src/fs/FSRef.ts`. Never call `fsManager` methods directly from asset editor components. `BaseAssetEditor` already uses this pattern.

19. `type` and `id` are the universal identity pair across the entire system. A `TypeId` (`type:id`) uniquely identifies any object — Record, Entity, or API resource. `SchemaRegistry` is the single source of truth for types: every type name must be registered there; no type string should be defined or looked up outside of it.

20. Entity–Record ID sync is achieved by deriving the same `uuid5` from the same natural key field on both sides. `Entity.allocate_id(data)` returns `uuid4` by default. Entity subclasses with a stable filesystem identity (e.g. `Project` with `fs_storage_mount_path`) override `allocate_id` to return `uuid5(NAMESPACE_DNS, f"{type}:{key_value}")`. The corresponding `Record` subclass sets the same value as its `fingerprint` (rule 9), producing the same uuid5. This guarantees that indexing an existing entity's record never creates a duplicate — `Entity.from_record()` finds the entity by its deterministic id.
