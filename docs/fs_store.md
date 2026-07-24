---
id: 305e2927-497f-554c-b0d4-d307d3c921fa
---

# fs_store: Record System Architecture

The `flow_sdk.fs_store` package provides file-system backed records. There is no single `FsStore` class — the package is a collection of modules that together provide record storage, indexing, querying, and lifecycle management.

> **Note:** this file used to describe the pre-refactor `Record` class (`_data` dict, `RecordState`/`state.json`, `RecordRef`, `StorageLayout`, `CollectionManifest`). That machinery was removed with the `FSRecord` refactor — `flow_sdk/fs_store/record.py` no longer exists. The current documentation lives in `docs/data-management/`; this page is a directory.

## Where things are documented now

| Subject | Doc |
|---|---|
| The record class (`FSRecord`), meta, save/load, index-state (`.hash` sentinel, `index_required`, `orphan`) | [record-model.md](data-management/record-model.md) |
| Shadow-folder layout (`<records_root>/<type>/<type>-@<id>/`), per-type source mapping | [folder-layout.md](data-management/folder-layout.md) |
| Entity ↔ Record sync (`sync_to_db` pipeline, FTS5, wiki edges, DataOps) | [entity-index-sync.md](data-management/entity-index-sync.md) |
| The FSIndexer walk (roots, walkers, skip-fresh, orphan actions, triggers) | [scan-and-discovery.md](data-management/scan-and-discovery.md) |
| Gitignore-aware traversal used by the walkers | [gitignore-walk.md](data-management/gitignore-walk.md) |
| Session-transcript indexing (handlers, single-file self-heal) | [transcript-indexing.md](data-management/transcript-indexing.md) |
| Full-text search layer | [record-search.md](data-management/record-search.md) |
| Type registry (`SchemaRegistry`, `TypeInfo`) | [schema-registry.md](data-management/schema-registry.md) |
| CRUD gateway (`fs-records` actions on ComputeNode) | [compute-node-fs-records.md](data-management/compute-node-fs-records.md) |
| Record system rules (normative, agent-facing) | [CLAUDE.md](CLAUDE.md) |

## One clarification worth keeping

The word "index" is overloaded. The **filesystem records** under `records_root` are the source-of-truth manifests; the **SQLite `entities` table is NOT part of fs_store** — it is a rebuildable query index derived from records via `sync_to_db()`. Deleting the DB loses nothing; a re-index rebuilds it from disk. See [entity-index-sync.md](data-management/entity-index-sync.md) for the naming disambiguation table.
