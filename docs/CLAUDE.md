---
id: "e54d4265-bef1-5abb-8f25-d8204141caed"
---

# Record System Requirements

1. Disk is the source of truth. Records are scanned from disk; Entities are a DB index for fast query only. The entire Entity/DB layer can be deleted and rebuilt from disk without any data loss.

2. `FSRef` (`flow_sdk/fs_store/fs_ref/base.py`) is a lightweight declarative file/folder reference — wraps a path with read/write/child/stat methods plus `record_type`, `scope`, `project_id`, and `json_path` tags used by the indexer walk. Subclasses live beside it in `flow_sdk/fs_store/fs_ref/`: `JSONFsRef` (write-through JSON), `TextFsRef` (plain text), `FrontmatterRef`, `BinaryRef`. All exported from `flow_sdk/fs_store/__init__.py`.

   * Use FSRef (or subclasses) for all file-pointing inside records — never hardcode `record_dir / "filename"` strings.

   * `FSRef.to_dict(type_id)` serializes to `{path, ref_type, read_only, type_id}`. TypeScript: `FSRef.fromJson(json)` reconstructs from the dict (`ts_sdk/src/fs/FSRef.ts`).

   * See `docs/fs-ref.md` for the full FSRef doctrine.

3. `FSRecord` (`flow_sdk/fs_store/fs_record.py`) is the **single concrete record class** — there are no Record subclasses. Per-type behavior lives in the registered `TypeInfo` slots (`from_disk_fn`, `gen_uuid_fn`, `asset_hash_fn`, `post_sync_fn`, `meta_model`, `default_body_fn`, `owns_main_ref`, `main_subdir`/`main_layout`/`main_ext`), authored in `flow_sdk/schema/type_info/<type>_*info.py` and registered via `register_all()`. FSRecord itself knows nothing about types.

   * The following were **deliberately removed** with the old `Record` class and must not be reintroduced: `state.json` / `RecordState` / `PropertyRecord` caching, `raw_json` + dict-like item access, auto-save on attribute mutation, `parent_ref`/`children_refs`/`origin_ref` on the record (the Entity DB owns edges), and polymorphic legacy load fallbacks.

4. A Record's shadow folder is always `<records_root>/<type>/<type>-@<id>/` and contains `metadata.json` plus at most one zero-byte `.hash` index sentinel. There is no other layout.

   * `records_root` is **per-instance** (`InstanceSettings.records_root`). Resolve it via `get_default_records_root()` / redirect in tests via `set_default_records_root()` — both in `flow_sdk/fs_store/record_paths.py`; always restore in teardown.

5. `metadata.json` is the record's only persisted state — a flat JSON dict of identity + meta fields. `FSRecord.save_metadata(patch)` is the **single DB→disk writer**: partial-merge (unmentioned keys preserved, `None` values skipped so a stale field never clobbers a fresh on-disk one), with `type`/`id` always anchored from the record identity.

6. `meta_dict()` returns the flat dict used to build the Entity DB row: `type`, `id`, `asset_ref` (path string), and every non-system, non-`None` instance attribute. Meta fields live directly on `__dict__`; `record.meta` returns them as a `TypeInfo.meta_model` Pydantic instance when one is registered.

7. Read-only is FSRef-level: `FSRef.read_only` is inherited from the parent ref — marking a parent read-only blocks writes on all its children. External and read-only are independent axes.

8. Entity ids are UUID v4/v5 only, minted through `mint_uuid(key=None, *, namespace=...)` (`flow_sdk/fs_store/identifier.py`): `uuid5(namespace, key)` for a stable key, else `uuid4`. Foreign/non-conforming ids (e.g. a hand-authored v7) are normalized on adopt, never kept. See the repo-root CLAUDE.md entity-id policy.

9. `FSRecord.fingerprint` is the deterministic identity key: `uuid5(NAMESPACE_URL, f"{type}:{asset_ref.path or name}")`. When no explicit `id` is given, `save()` mints the id from `fingerprint`. Constructor-provided `id` always wins.

10. `record.asset_ref` is an `FSRef` pointing to the record's primary content file — may be anywhere on the filesystem. `record.main_ref` is an **alias for `asset_ref`**. Only the `asset_ref` path is persisted in `metadata.json`; the shadow folder (`shadow_dir` / `record_folder_ref`) is computed at runtime from `(type, id)`.

11. Parent/child/origin relationships are Entity-side (DB relationships), not record fields. Do not add edge fields to `metadata.json`.

12. `EntityType` (`flow_sdk/schema/types.py`) is the single consolidated type-name enum. `RecordType` (`flow_sdk/fs_store/record_types.py`) is a backward-compat **alias** of it — import `EntityType` directly in new code. Add new types to `EntityType` first, then author the type's `TypeInfo` in `flow_sdk/schema/type_info/`.

13. `record.id` is the sole stable identity — used for both the shadow path and the Entity DB row. There is no separate `uuid` property.

14. Freshness tokens: `FSRef.fingerprint` is a lightweight mtime+size content token; a type may override the token via `TypeInfo.asset_hash_fn` (e.g. folder types combine inner-file mtimes). `FSRecord.get_hash()` digests the token (blake2b, 8 bytes) into the filename-safe hash used by the sentinel.

15. The index sentinel is a single empty file in the shadow folder named `<int_epoch>_<contenthash>_<pathdigest>.hash` (legacy 2-part form without the path digest still reconciles). It is written by `record.write_hash()` — stamped **by the indexer after the DB batch commits** (write-ahead ordering: a crash before commit leaves no sentinel, so the record re-indexes next run). `sync_to_db()` itself does NOT stamp it; the GET-time refresh (`Entity.check_and_refresh_record()`) stamps it after its own re-sync.

16. `FSRecord.index_required` is True when the source content hash differs from the sentinel's captured hash (or no sentinel exists), **or** when the source relocated (path digest drift — mtime+size survives `cp -p`/wheel installs, so location is checked separately). To force re-index: `clear_hash()` (or `clear_hashes_for_type()`); the indexer's skip-fresh additionally requires a live Entity DB row, so a stale sentinel can't mask a cleared DB. TTL-based staleness does not exist at the record layer.

17. `Entity.store()` syncs entity fields DOWN to disk: partial-merges `metadata_payload()` into `metadata.json` via `save_metadata`, upserts the main body via `upsert_main_ref` (writes `default_body_fn` output iff the file doesn't exist — or on every save for `owns_main_ref` types), then FTS-upserts. Errors are logged as `RecordError` and never propagated — `store()` returns `None` on failure.

18. TypeScript: `asset.assetRefFor(fsTypeId)` returns `FSRef | undefined` with `.read()` and `.write()` async methods. Use this instead of direct `fsManager.download()` / `fsManager.writeFile()` calls. Never call `fsManager` methods directly from asset editor components; `BaseAssetEditor` already uses this pattern.

19. `type` and `id` are the universal identity pair across the entire system. A `TypeId` (`type:id`) uniquely identifies any object — Record, Entity, or API resource. `SchemaRegistry` (`flow_sdk/fs_store/schema_registry.py`) is the single source of truth for types: every type name must be registered there; no type string should be defined or looked up outside of it.

20. Entity–Record ID sync: `Entity.allocate_id(data)` keeps a conforming (v4/v5) provided id, normalizes a non-conforming one to `uuid5(type:id)`, and mints `uuid4` otherwise. `Project` deliberately does NOT derive its id from the path anymore — project ids are opaque uuid4 like every other entity (so a project can be shared under its own id); dedup on re-index is `Project.find_by_cwd` (the canonical `fs_storage_mount_path` natural key) inside `Project.from_record`, and `derive_id_for_path` survives only as a record-match alias, never the entity id.

21. Indexing pipeline and freshness/orphan semantics are documented in `docs/data-management/` — start at `docs/data-management/scan-and-discovery.md` (walker, triggers) and `docs/data-management/entity-index-sync.md` (`sync_to_db` pipeline, FTS, wiki edges).
