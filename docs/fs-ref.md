---
id: 1b0e33a4-9337-56ff-ae6b-ca0d3c303ba5
title: fs-ref
---
# FSRef — declarative file/folder references

`FSRef` (`flow_sdk/fs_store/fs_ref/base.py`) is the lightweight declarative reference used everywhere the record system points at a file or folder. It wraps a `Path` with I/O methods and carries the walk metadata the indexer relies on. **Doctrine: use FSRef (or a subclass) for all file-pointing inside records — never hardcode `record_dir / "filename"` strings.**

## The class family (`flow_sdk/fs_store/fs_ref/`)

| Class | File | Purpose |
|---|---|---|
| `FSRef` | `base.py` | Base ref: path + tags + text I/O (`read`/`write`/`write_md`/`delete`/`mkdir`/`child`/`children`) |
| `JSONFsRef` | `json_ref.py` | Write-through JSON ref: `get`/`set`/`update` flush directly to the file; `load()`/`as_dict()` for bulk reads |
| `TextFsRef` | `text_ref.py` | Plain-text file ref |
| `FrontmatterRef` | `frontmatter_ref.py` | Markdown with YAML frontmatter: `read_frontmatter`/`read_body`/`write_frontmatter`/`write_body`/`write_doc` |
| `BinaryRef` | `binary_ref.py` | Binary content ref |

All are exported from `flow_sdk/fs_store/__init__.py`.

## Walk tags

Beyond the path, an FSRef carries tags stamped by the indexer walk and inherited down the parent chain:

- `record_type` — the `RecordType`/`EntityType` discriminator the `FSIndexer` dispatches on.
- `scope` / `project_id` — provenance inherited from the root FSRef (USER_HOME_FOLDER → `user`, REAL_PROJECT_CWD/CWD_ROOT → `project` + project id, SYSTEM_ROOT → `system`); stamped onto records at index time.
- `json_path` — RFC-6901 pointer for fragment records (multiple records extracted from one source file, e.g. hooks in `settings.json`); part of the walk's dedup key so fragments aren't collapsed.

## Read-only semantics

`FSRef.read_only` is computed: a ref is read-only when its own flag is set **or its parent ref is read-only** — marking a parent read-only blocks writes on all children derived from it. External and read-only are independent axes.

## Freshness token

`FSRef.fingerprint` is the lightweight mtime+size content token used as the default index-freshness source (`FSRecord.get_hash()` digests it; types may override via `TypeInfo.asset_hash_fn`). See [data-management/record-model.md](data-management/record-model.md).

## Serialization and the TypeScript side

- `FSRef.to_dict(type_id)` → `{path, ref_type, read_only, type_id}`; `FSRef.from_dict(d)` reconstructs (subclass chosen by `ref_type`). Pydantic v2 schema hooks make FSRef usable directly in models.
- TypeScript: `FSRef.fromJson(json)` (`ts_sdk/src/fs/FSRef.ts`) reconstructs on the frontend; `entity.record()` calls `GET /record/refs` and returns a `Record` with `selfRef` + `mainRef`.
- In asset editors, use `asset.assetRefFor(fsTypeId)` (returns an `FSRef` with async `.read()`/`.write()`) — never call `fsManager.download()`/`fsManager.writeFile()` directly.

## How records use FSRefs

- `record.asset_ref` — the primary content file (anywhere on disk); the only ref path persisted (`metadata.json`). `record.main_ref` is an alias for it.
- `record.record_folder_ref` / `record.metadata_ref` — computed refs into the shadow folder (`<records_root>/<type>/<type>-@<id>/`).

Normative rules live in [docs/CLAUDE.md](CLAUDE.md); the record model detail is in [data-management/record-model.md](data-management/record-model.md).
