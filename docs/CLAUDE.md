---
id: "e54d4265-bef1-5abb-8f25-d8204141caed"
---

# Record System Requirements

1. Disk is the source of truth. Records are scanned from disk; Entities are a DB index for fast query only. The entire Entity/DB layer can be deleted and rebuilt from disk without any data loss.

2. `FSRef` (`flow_sdk/fs_store/fs_ref/base.py`) is a lightweight declarative file/folder reference — wraps a path with read/write/child/stat methods plus `record_type`, `scope`, `project_id`, and `json_path` tags used by the indexer walk. Subclasses live beside it in `flow_sdk/fs_store/fs_ref/`: `JSONFsRef` (write-through JSON), `TextFsRef` (plain text), `FrontmatterRef`, `BinaryRef`. All exported from `flow_sdk/fs_store/__init__.py`.

   * Use FSRef (or subclasses) for all file-pointing inside records — never hardcode `record_dir / "filename"` strings.

   * `FSRef.to_dict(type_id)` serializes to `{path, ref_type, read_only, type_id}`. TypeScript: `FSRef.fromJson(json)` reconstructs from the dict (`ts_sdk/src/fs/FSRef.ts`).

   * See `docs/fs-ref.md` for the full FSRef doctrine.

3. `FSRecord` (`flow_sdk/fs_store/fs_record.py`) is the **single concrete record class** — there are no Record subclasses. Per-type behavior lives in the registered `TypeInfo` slots (`from_disk_fn`, `capsules`, `identity_carrier`, `id_stable_key_fn`, `id_namespace`, `asset_hash_fn`, `post_sync_fn`, `meta_model`, `default_body_fn`, `owns_main_ref`, `main_subdir`/`main_layout`/`main_ext`, `serializer()`/`default_origin_kind`), authored in `flow_sdk/schema/type_info/<type>_*info.py` and registered via `register_all()`. `TypeInfo.mint_entity_id()` is the single filesystem identity seam — it reads the type's carrier, prefers the row that already owns the path, and only then mints (and writes); `TypeInfo.read_id()` is the pure read. Parsers receive the resolved id as `from_disk_fn(ref, resolved_id)` and never resolve it themselves. FSRecord itself knows nothing about types.

   * The following were **deliberately removed** with the old `Record` class and must not be reintroduced: `state.json` / `RecordState` / `PropertyRecord` caching, `raw_json` + dict-like item access, auto-save on attribute mutation, `parent_ref`/`children_refs`/`origin_ref` on the record (the Entity DB owns edges), and polymorphic legacy load fallbacks.

4. A Record's shadow folder is always `<records_root>/<type>/<id>/` and contains `metadata.json` plus at most one zero-byte `.hash` index sentinel. There is no other layout.

   * `records_root` is **per-instance** (`InstanceSettings.records_root`). Resolve it via `get_default_records_root()` / redirect in tests via `set_default_records_root()` — both in `flow_sdk/fs_store/record_paths.py`; always restore in teardown.

5. `metadata.json` is the record's only persisted state — a flat JSON dict of identity + meta fields. `FSRecord.save_metadata(patch)` is the **single DB→disk SHADOW writer** (the asset itself is written by the type's `DataSerializer`): partial-merge (unmentioned keys preserved, `None` values skipped so a stale field never clobbers a fresh on-disk one), with `type`/`id` always anchored from the record identity.

6. `meta_dict()` returns the flat dict used to build the Entity DB row: `type`, `id`, `asset_ref` (path string), and every non-system, non-`None` instance attribute. Meta fields live directly on `__dict__`; `record.meta` returns them as a `TypeInfo.meta_model` Pydantic instance when one is registered.

7. Read-only is FSRef-level: `FSRef.read_only` is inherited from the parent ref — marking a parent read-only blocks writes on all its children. External and read-only are independent axes.

8. Entity ids are UUID v4/v5 only, minted through `mint_uuid(key=None, *, namespace=...)` (`flow_sdk/api/api_types/identifier.py`): `uuid5(namespace, key)` for a stable key, else `uuid4`. Filesystem assets resolve identity through ONE call to `TypeInfo.mint_entity_id()`: carrier → the row that owns the path → mint. A read-then-mint pair is banned (it forks the entity when a rewrite has wiped the carrier); `TypeInfo.read_id()` is the pure read and may answer `None`. **The type declares WHERE the id lives** (`identity_carrier`): a markdown main document carries it as its first frontmatter key `id:` (markdown, memory, rules, subagents, commands, plans, prompts, agents, specs, and the `SKILL.md`/`task.md`/`WHITE_BOARD.md` of folder types); a folder whose main is JSON uses `.flow/capsules/identity.json`; a report carries it in its own JSON root; provider files derive it and are never written. A legacy markdown HTML-comment capsule is read and converted into the frontmatter in place on the next index; `asset_id:` and `.flow/id` stay read-only fallbacks. Foreign/non-conforming ids (e.g. v7) produce a stable v5 without rewriting invalid bytes. See `docs/data-management/asset-capsules.md`.

9. `FSRecord` never mints an id. A file-backed record's id comes from `TypeInfo.mint_entity_id()` before `save()`; a row-only entity's id comes from `Entity.allocate_id()` (`flow_sdk/core/entity/entity_model.py`). `FSRecord.content_fingerprint` is a content token used for freshness only and is NOT an entity id. An id-less record reaching `save()` is an error. A constructor-provided `id` is adopted only if it passes `is_valid_entity_id`.

10. `record.asset_ref` is an `FSRef` pointing to the record's primary content file — may be anywhere on the filesystem. `record.main_ref` is an **alias for `asset_ref`**. Only the `asset_ref` path is persisted in `metadata.json`; the shadow folder (`shadow_dir` / `record_folder_ref`) is computed at runtime from `(type, id)`.

11. Parent/child/origin relationships are Entity-side (DB relationships), not record fields. Do not add edge fields to `metadata.json`.

12. `EntityType` (`flow_sdk/schema/types.py`) is the single consolidated type-name enum. `RecordType` (`flow_sdk/fs_store/record_types.py`) is a backward-compat **alias** of it — import `EntityType` directly in new code. Add new types to `EntityType` first, then author the type's `TypeInfo` in `flow_sdk/schema/type_info/`.

13. `record.id` is the sole stable identity — used for both the shadow path and the Entity DB row. There is no separate `uuid` property.

14. Freshness tokens: `FSRef.fingerprint` is a lightweight mtime+size content token; a type may override the token via `TypeInfo.asset_hash_fn` (e.g. folder types combine inner-file mtimes). `FSRecord.get_hash()` digests the token (blake2b, 8 bytes) into the filename-safe hash used by the sentinel.

15. The index sentinel is a single empty file in the shadow folder named `<int_epoch>_<contenthash>_<pathdigest>.hash` (legacy 2-part form without the path digest still reconciles). It is written by `record.write_hash()` — stamped **by the indexer after the DB batch commits** (write-ahead ordering: a crash before commit leaves no sentinel, so the record re-indexes next run). `sync_to_db()` itself does NOT stamp it; the GET-time refresh (`Entity.check_and_refresh_record()`) stamps it after its own re-sync.

16. `FSRecord.index_required` is True when the source content hash differs from the sentinel's captured hash (or no sentinel exists), **or** when the source relocated (path digest drift — mtime+size survives `cp -p`/wheel installs, so location is checked separately). To force re-index: `clear_hash()` (or `clear_hashes_for_type()`); the indexer's skip-fresh additionally requires a live Entity DB row, so a stale sentinel can't mask a cleared DB. TTL-based staleness does not exist at the record layer.

17. `Entity.store()` syncs entity fields DOWN to disk: partial-merges `metadata_payload()` into `metadata.json` via `save_metadata`, writes the asset via `TypeInfo.serializer(origin).store(entity, origin)` (`flow_sdk/fs_store/serializer/` — the ONE `DiskSerializer`: a type's `asset_spec` renders its main doc, a spec-less type renders through `default_body_fn`; the main doc is written iff the file doesn't exist — or on every save for `owns_main_ref` types; a `db_only` type writes no shadow and feeds FTS from the row), then FTS-upserts. Errors are logged as `RecordError` and never propagated — `store()` returns `None` on failure.

18. TypeScript: `asset.assetRefFor(fsTypeId)` returns `FSRef | undefined` with `.read()` and `.write()` async methods. Use this instead of direct `fsManager.download()` / `fsManager.writeFile()` calls. Never call `fsManager` methods directly from asset editor components; `BaseAssetEditor` already uses this pattern.

19. `type` and `id` are the universal identity pair across the entire system. A `TypeId` (`type:id`) uniquely identifies any object — Record, Entity, or API resource. `SchemaRegistry` (`flow_sdk/fs_store/schema_registry.py`) is the single source of truth for types: every type name must be registered there; no type string should be defined or looked up outside of it.

20. Entity–Record ID sync: `Entity.allocate_id(data)` keeps a conforming (v4/v5) provided id, normalizes a non-conforming one to `uuid5(type:id)`, and mints `uuid4` otherwise. `Project` deliberately does NOT derive its id from the path anymore — project ids are opaque uuid4 like every other entity (so a project can be shared under its own id); dedup on re-index is `Project.find_by_cwd` (the canonical `fs_storage_mount_path` natural key) inside `Project.from_record`, and `derive_id_for_path` survives only as a record-match alias, never the entity id.

21. Indexing pipeline and freshness/orphan semantics are documented in `docs/data-management/` — start at `docs/data-management/scan-and-discovery.md` (walker, triggers) and `docs/data-management/entity-index-sync.md` (`sync_to_db` pipeline, FTS, wiki edges). The end-to-end `file change → re-index → entity change → UI refresh` invalidation loop (the `/fs-records/invalidate` push endpoint, the agentic turn-end re-index, the `updated_date` change token, and the frontend `useFSRefContent` `reloadKey` body re-read) is in `docs/data-management/invalidation.md`.
