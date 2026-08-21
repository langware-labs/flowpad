---
id: b67adcb2-5fd1-52b8-9ae2-21dabce099fc
version: 3
---

# Data Management

This document provides an overview of the data management architecture in flow-cli and links to detailed sub-documents for each subsystem.

## Architecture Overview

Flow-cli uses a two-layer data model:

* **Filesystem Records** (`flow_sdk/fs_store/`) -- the source of truth for all domain data. The base class is `FSRecord` (`flow_sdk/fs_store/fs_record.py`), a lean on-disk manifest (the old `Record` class and `record.py` were removed). Each record lives at `<records_root>/<type>/<type>-@<id>/metadata.json`, holding an `asset_ref` (`FSRef` to the user-facing source file) plus free-form meta fields stored as direct instance attributes (per-type typed metadata models are opt-in via `TypeInfo.meta_model`). They are the canonical store for things like Claude sessions, settings, MCP configs, and agent-created entities. `FSRecord` itself knows nothing about types — per-type parsing and identity policy are registered on `TypeInfo`; portable named metadata is stored through the independent `flow_sdk/capsules/` package. `TypeInfo.mint_entity_id()` owns filesystem identity resolution — carrier → owning row → derive — and passes the result into `from_disk_fn(ref, resolved_id)`. See [Asset capsules](data-management/asset-capsules.md).

* **Database Entities** (`flow_sdk/core/entity/`) -- SQLite-backed, queryable indexes that mirror key metadata from Records. Entities support fast filtered queries (by status, date, project) that would require O(N) filesystem scans if done directly against Records. The FTS5 virtual table (`entities_fts`) provides full-text search over records that opt in via the `content` property.

**Record is primary — Entity is cache.** The write path always goes disk first:

```
record.save()          → metadata.json on disk (source of truth)
record.sync_to_db()    → Entity row + FTS entry updated from the saved record
```

The two layers are kept in sync through a combination of:

* `rec.sync_to_db()` called explicitly after every fs-records POST/PUT

* Entity deletion by id before disk deletion on DELETE

* `_reflect_entity()` in the listen/webhook pipeline (FTS is updated downstream via `Entity.from_record()`/`sync_to_db()`, not by a dedicated `_fts_sync_entity()` call in listen.py)

* Lazy mtime staleness checks on API GET (Entity refreshes from Record if stale)

**fs-records vs Entity/graph API at a glance:**

| <br />   | fs-records                                  | Entity / graph API                                                          |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Storage  | JSON files on disk                          | SQLite rows                                                                 |
| Content  | Full record payload                         | Metadata subset (record meta fields)                                        |
| Query    | O(N) scan                                   | Indexed SQL + FTS5, plus path-based descendant query (see below)            |
| Use when | You need full field data or unindexed types | You need filtered queries, full-text search, or "all assets under folder X" |

**Querying entities under a filesystem folder:**

`Entity.assets_by_path(PathQueryOptions)` returns entities whose `asset_ref`
is a strict descendant of any of the supplied search dirs, optionally filtered
by type. The HTTP wrapper is `GET /api/v1/assets/by-path?folder=...&record_type=...`
(both `folder` and `record_type` are repeatable). Implementation pushes a
half-open lex range `asset_ref >= "<dir>/" AND asset_ref < "<dir>0"` down to
SQL via `json_extract(data, '$.asset_ref')` — multiple dirs are OR'd, types
are AND'd via `IN`. Reads `asset_ref` only; `parent_path` and `vault_root`
are not consulted by this query. Path strings are stored in canonical POSIX
form (`flow_sdk/fs_store/path_utils.canonical_posix_path`) so the range
matches across macOS / Linux / Windows on the same host.

### Three "Index" Systems

The codebase uses the word "index" for two related systems (a third, the per-record `state.json`/`RecordState` cache, was removed when `Record` became `FSRecord` — per-type extractors now precompute derived fields straight into the record's meta). Understanding the distinction is essential:

| System            | What it is                                                                                             | Where it lives                                                    | Updated by                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Hash sentinel** | Per-record index-staleness token (`<epoch>_<hash>_<pathdigest>.hash` file in the record shadow folder) | `flow_sdk/fs_store/fs_record.py` (`write_hash`, `index_required`) | The indexer, after the DB batch commits (write-ahead ordering); also `Entity.check_and_refresh_record()` after a GET-time re-sync |
| **Entity Index**  | SQLite rows mirroring Record metadata                                                                  | `flow_sdk/core/entity/entity_model.py`                            | `FSRecord.sync_to_db()` via `Entity.from_record()`                                                                                |
| **FTS Index**     | Full-text search virtual table                                                                         | `entities_fts` in SQLite                                          | `FSRecord.sync_to_db()` via `fts_upsert()` (only if `content` is not None)                                                        |

See [Entity-Index Sync](data-management/entity-index-sync.md) for details on this naming distinction.

### Three Entity Creation Paths

Entities can be created through three independent paths:

| Path                           | Trigger                       | Creates Record?                    | Creates Entity?                 | Updates FTS?        |
| ------------------------------ | ----------------------------- | ---------------------------------- | ------------------------------- | ------------------- |
| **ComputeNode fs-records**     | HTTP CRUD on Records          | Yes                                | Yes (via `rec.sync_to_db()`)    | Yes                 |
| **Listen webhook**             | `POST /api/v1/webhook/listen` | No                                 | Yes (via `_reflect_entity()`)   | No — see note below |
| **MCP** **`flow_entity_crud`** | Claude Code MCP tool          | Via optional `plugin_records` only | No (does not touch core SQLite) | No                  |

Only the ComputeNode fs-records path produces fully FTS-indexed core entities. The listen webhook path (`_reflect_entity()`) writes Entity rows directly without an FTS upsert, so those entities are not visible to FTS search until a manual reindex. The MCP `flow_entity_crud` tool delegates to an optional `plugin_records` layer separate from the core Entity model and does not write to core SQLite or FTS at all. See [Entity-Index Sync](data-management/entity-index-sync.md) and [Record Search](data-management/record-search.md) for details on the webhook gap.

### Data Flow

```
Claude CLI / external tool
       |
       |  POST /api/v1/webhook/listen  (hook_op)
       v
  listen_action()
       |  _reflect_entity()     -> Entity CREATE/UPDATE/DELETE in SQLite
       |                           (FTS upsert/delete happens inside Entity.from_record/sync_to_db)
       |  DataOpMessage         -> WebSocket broadcast
       v
  Frontend (TypeScript)
       |  FlowSyncStore.onDataOp()
       v
  React component re-render


ComputeNode fs-records action  (POST/PUT/DELETE)
       |
       |- record_list.create/update()   -> Record written to disk
       |- rec.sync_to_db()              -> Entity row + FTS upsert
       +- _broadcast_fs_record_op()     -> WebSocket DataOpMessage (notification only)

ComputeNode fs-records DELETE
       |
       |- Entity delete by id           -> Entity row + FTS entry removed
       |- record_list.delete()          -> Record removed from disk
       +- _broadcast_fs_record_op()     -> WebSocket DataOpMessage


MCP server (stdio, FastMCP)
       |
       +- flow_entity_crud tool  -> delegates to optional `plugin_records` handlers
                                     (separate from the core Entity model; does not
                                     itself write to SQLite or FTS)
```

### Type System

All record and entity types are managed by the **SchemaRegistry** (`flow_sdk/fs_store/schema_registry.py`), which provides:

* O(1) type registration and lookup via `TypeInfo` dataclasses (each `TypeInfo.locations` lists which layers a type lives in, e.g. `["index"]`)

* Entity-side auto-registration: `DBBaseRecord.__init_subclass__` (`flow_sdk/db/drivers/db_base_record.py`) registers each concrete entity with `locations=["index"]` and `entity_cls=cls`. Record-side per-type behavior (`from_disk_fn`, icons, etc.) is registered via `register_all` in `flow_sdk/schema/type_info/` and the indexer registrations (`flow_sdk/fs_store/indexer/registrations.py`) — `FSRecord` itself has no `__init_subclass__`.

* Per-type JSONL run logs at `~/.flow/.../schema/types/<type>/` (`scan_log.jsonl` / `index_log.jsonl`; note `type_info.json` is NOT persisted — see [Schema Registry](data-management/schema-registry.md))

* Index orchestration: `clear_index()`, `get_index_status()` (note: the older `discover()`/`rebuild_index()`/`incremental()` SchemaRegistry methods no longer exist; scan/index walking now lives in `flow_sdk/fs_store/indexer/`)

The single canonical type enum is **`EntityType`** (`flow_sdk/schema/types.py`). It replaced the two historical enums — `RecordType` (formerly `fs_store/record_types.py`) and `BuiltinEntityType` (db layer) — which are now thin aliases re-exported for backward compatibility (`flow_sdk/fs_store/record_types.py` aliases `RecordType = EntityType`). String values are DB/filesystem-persisted and must never change.

The **TypeId** (`flow_sdk/fs_store/type_id.py`; also re-exported from `flow_sdk/api/api_types/type_id.py`) is the universal identifier format: `{type}-{id}`. It is a plain Python class (not a Pydantic BaseModel) with Pydantic v2 compatibility hooks. Five identifier types are supported: UUID, Namespace, PropId, Named (`@uname`), and Unknown.

One legacy type registry shim remains: the Entity `type_registry` (`schema/entity_factory.py`), which fully delegates to SchemaRegistry. (The FS Record `type_registry` shim at `fs_store/factory/type_registry.py` was removed — `factory/` is now empty.) `SchemaRegistry` is authoritative for all Record and Entity lookups.

## Sub-documents

### [Items & Origins](data-management/items_origins.md)

Where the real thing lives. The three parallel origin families — `FSOrigin` (an asset's **bytes**), `CloudOrigin` (a record's **truth**), `SecretOrigin` (a **value**, resolved at worker launch and never persisted) — and why they are deliberately not one type. Covers the `FSOrigin` model and its `kind`-tagged discriminated union (`git`, `local`), the kind-keyed driver registry (`materialize`/`matches`/`detect`/`key`), the tolerant kind-less-reads-as-git rule, and `key()` as a cross-machine dedup handle that is an entity id in exactly one place (`Folder.id_for_origin`). Also documents the four *different jobs* origin-shaped fields do (polymorphic `FSOriginField` on Folder/Artifact, deliberately git-narrow on Project/Task, the SHARED hub wire dict on `Entity`, a raw bundle buffer on `MessageAttachment`), the byte-exact wire contract that dict carries, and the checklist for adding a new kind.

**Key source files:** `flow_sdk/builtin/fs_origin.py`, `fs_origin_field.py`, `fs_origin_driver.py`, `git_origin.py`, `local_origin.py`, `flow_sdk/builtin/drivers/`, `flow_sdk/assets/git_origin.py`, `flow_sdk/builtin/flow_message_bundle.py`

***

### [Data Sources](data-management/data-sources.md)

How something that is not the local filesystem gets into the graph. The `DataSource` → `DataSourceCursor` → driver shape, the heartbeat-not-jobs dispatcher, and the three properties one poll cycle guarantees (per-stream isolation, records before cursor, a budget rather than a backoff). Covers the driver contract and its *declared* traits (`stream_budget`, `stamps_identity`, `origin_id_for`, `source_root`, `verify`, `send`), the opaque cursor `state` that lets one loop serve conditional-GET, changed-ids and a commit sha without branching, and the separation of `status` (should this run) from `health` (is it working) with `config_error` as the only thing that parks a scope. Documents the **two destinations** — `ingest_items` as the single `SourceItem` chokepoint versus reflection onto disk — the seven reflect modes and the two warts in them (`none` and `in-place` are one behaviour, `symlink` is an addressing no-op), identity resolved by `origin_id` lookup rather than read out of the bytes, and the change envelope whose `refs` are an optimization and never a guarantee.

**Key source files:** `flow_sdk/builtin/data_source.py`, `data_source_cursor.py`, `source_item.py`, `flow_sdk/ingest/`

***

### [Record Model](data-management/record-model.md)

The `FSRecord` base class (formerly `Record`): on-disk manifest at `<records_root>/<type>/<type>-@<id>/metadata.json`, free-form meta fields as instance attributes (typed `meta_model` opt-in via `TypeInfo`), `asset_ref`/`self_ref` FSRefs, the `<epoch>_<digest>.hash` index sentinel, per-type behavior via free functions on `TypeInfo`, `StorageLayout` (FILE/FOLDER), entity-side auto-registration via `DBBaseRecord.__init_subclass__` → `SchemaRegistry`, `RecordRef`/`RecordDataRef`, `RecordList`, `RecordQuery` filtering, and `CollectionManifest` for O(1) staleness checks. (The removed `Record` machinery — `_data` dict, `_META_FIELDS`, `RecordStatus`, `RecordState`/`state.json`, `ResourceRecordList`/`SourceFileRecordList`, `data.json`/`_data.json` split — no longer applies; see the `FSRecord` module docstring for the full removal list.)

**Key source files:** `flow_sdk/fs_store/fs_record.py`, `record_types.py`, `storage_layout.py`, `record_ref.py`, `record_list.py`, `source_file_records.py`, `record_query.py`, `manifest.py`

***

### [Folder Layout](data-management/folder-layout.md)

On-disk directory structure for both FlowPad records (`~/.flow/records/`) and Claude Code records (`~/.claude/`). Covers naming conventions (`<type>-@<uid>`), the canonical per-record folder (`metadata.json` + `<epoch>_<digest>.hash` sentinel), project directory encoding, all `EntityType` constants grouped by category, and the `is_allowed_source_path()` security whitelist check. (Note: the type enum is now `EntityType` in `flow_sdk/schema/types.py`; `RecordType` is a backward-compat alias.)

**Key source files:** `flow_sdk/schema/types.py` (`EntityType`), `flow_sdk/fs_store/record_types.py` (alias shim), `flow_sdk/fs_store/source_file_records.py` (`is_allowed_source_path`), `flow_sdk/fs_records/` (claude/, codex/ submodules)

***

### [Dataset Layout (Authoring Guide)](data-management/datasets.md)

User-facing contract for laying out a **dataset** on disk: a folder under `assets/datasets/<slug>/` marked by a `dataset.json` manifest, in either the `csv` layout (`data.csv`, one row per example) or the `io_folder` layout (`examples/<name>/` with `input`/`output`/`ground_truth` slots). Covers slot forms (single file, folder, numbered `<slot>-N` for multiple outputs / consensus annotations), `<slot>.json` metadata sidecars, `example.json`/`meta.json` per-example metadata, the gold = `ground_truth` rule, file-beats-folder, binary-safe reads, and id-pinning for portability.

**Key source files:** `flow_sdk/builtin/dataset.py` (`Dataset`, `Example`, `ExampleSlot`, `ExampleArtifact`), `flow_sdk/fs_store/indexer/functions/dataset.py` (walker + `iter_examples` parser), `flow_sdk/schema/type_info/dataset_type_info.py`

***

### [Scan and Discovery](data-management/scan-and-discovery.md)

The filesystem scan layer: `FSRecord.discover(type)` (O(N) directory scan over `<records_root>/<type>/`) plus the indexer walkers in `flow_sdk/fs_store/indexer/` that orchestrate scan/index across types with JSONL logging (the older `SchemaRegistry.discover()`/`Record.discover_one()` no longer exist). Covers the `RecordQuery` filter/sort/paginate pipeline and the error/claude\_error parallel discovery path. (Note: scan API endpoints are driven through the index orchestration / system-tools layer, not a `POST /api/v1/search/reindex` route, which no longer exists.)

**Key source files:** `flow_sdk/fs_store/fs_record.py`, `flow_sdk/fs_store/schema_registry.py`, `flow_sdk/fs_store/indexer/`, `flow_sdk/builtin/claude_session.py`, `flow_sdk/fs_store/record_query.py`, `flow_sdk/fs_store/operations/record_error.py`, `flow_sdk/fs_store/operations/claude_error.py`

***

### [Gitignore-Aware Walk](data-management/gitignore-walk.md)

The single shared filesystem traversal (`gitignore_walk()`) used by the indexer's folder walkers, the asset-menu walk, and the LLM index scanner. Covers the hardcoded `_WALK_IGNORED` denylist, the per-directory `.gitignore` stack (last-match-wins, deliberately monotonic — child `!` re-includes of ancestor-ignored paths are not honored), the `.claude/` force-include with the `.claude/worktrees` carve-out, symlink policy, and the `IndexerOptions.gitignore` flag.

**Key source files:** `flow_sdk/fs_store/indexer/walk.py`, `flow_sdk/fs_store/indexer/gitignore.py`

***

### [Transcript Indexing](data-management/transcript-indexing.md)

The transcript indexer: an async walker over Claude/Codex session JSONLs that routes entries to registered `TranscriptHandler`s (e.g. `PlanHandler` cross-linking ClaudePlan ↔ AgenticProcess). Covers its `updated_date`-vs-mtime freshness (distinct from the `.hash` sentinel), the handler contract, and the `_index_single_file` self-heal wrappers behind the dock loader's `?hint_path=` 404 recovery.

**Key source files:** `flow_sdk/fs_store/transcript_indexer/`, `flow_sdk/fs_store/transcript_indexer/handlers/`

***

### [LLM Index (Merkle docs index)](data-management/llm-index.md)

The LLMIndexer → `index.md` → MarkdownIndex-entity pipeline — a separate system from the FSIndexer. Covers the deterministic Merkle folder index with cached LLM summaries (`stamp`/`rebuild`/`diff`), the produced `index.md` + `.md.json` sidecar, the `markdown_index` entity type rebuilt by an AgenticProcess, the serving routes, and how it differs from the FSIndexer.

**Key source files:** `flow_sdk/llm_index/`, `flow_sdk/builtin/markdown_index.py`, `flow_sdk/fs_store/operations/markdown_index.py`, `flow_sdk/server/routes/markdown_index.py`, `flow_sdk/server/routes/docs_graph.py`

***

### [Wiki Link Graph](llm_wiki.md)

Project-scoped Wiki namespaces plus the `[[wiki-link]]` occurrence graph: `Wiki`/`WikiEntry`, default-Wiki resolution, local and Hub URL/API contracts, link parsing, edge extraction inside every `sync_to_db()`, backlinks, and cleanup on delete/orphan sweep.

**Key source files:** `flow_sdk/builtin/wiki.py`, `flow_sdk/wiki/`, `flow_sdk/app/actions/wiki_action.py`, `flow_sdk/fs_store/fs_record.py` (`sync_to_db`, `get_links`/`get_backlinks`)

***

### [Record Search](data-management/record-search.md)

FTS5-backed full-text search for Records. Covers the `search_content` opt-in property (default: `content` or `body` field), inline indexing via `FSRecord.sync_to_db()` (no background worker), the FTS status post-filter limitation, and the FTS gap for webhook-created entities.

**Key source files:** `flow_sdk/server/routes/search.py`, `flow_sdk/db/drivers/sqlite/sqlite_driver.py` (`fts_upsert`, `fts_search`, `fts_delete`), `flow_sdk/fs_store/fs_record.py` (`search_content`, `sync_to_db`)

***

### [ComputeNode fs-records Action](data-management/compute-node-fs-records.md)

The `fs-records` custom action on `ComputeNode` -- the primary HTTP API for reading and writing Records. Full routing table (GET list, GET single, POST create, PUT update, DELETE, plus file-path variants), `_parse_record_query()` supported parameters, `_embed_includes()` session join, path-based source-file routing, security checks, TypeRegistry lookup, error response format, and DataOp broadcast on mutations.

**Key source files:** `flow_sdk/builtin/faas/fs_records_actions.py` (`_fs_records_action` and helpers; `ComputeNode.fs_records_action` delegates to it), `flow_sdk/fs_store/source_file_records.py`, `flow_sdk/fs_store/record_query.py`

***

### [Entity-Index Sync](data-management/entity-index-sync.md)

How SQLite Entities stay in sync with filesystem Records. Covers the "index" naming disambiguation (hash sentinel vs Entity Index vs FTS Index), the `Record.sync_to_db()` pipeline (`Entity.from_record()` → `sync_from_entity` mirror-back → FTS upsert → wiki edges → `post_sync_fn`), when `sync_to_db()` is called, `RecordError` on indexing failure, `DataOpMessage` structure and the fs-records CRUD → broadcast flow, `SchemaRegistry` index bookkeeping (`clear_index()`, `get_index_status()`, JSONL scan/index logs), staleness semantics (`index_required`), and the FTS gap for webhook-created entities.

**Key source files:** `flow_sdk/core/entity/entity_model.py`, `flow_sdk/app/actions/graph_crud_actions.py`, `flow_sdk/builtin/faas/fs_records_actions.py` (`_broadcast_fs_record_op`), `flow_sdk/core/network/resource_tracker.py`, `flow_sdk/api/messages.py`, `flow_sdk/fs_store/schema_registry.py`, `flow_sdk/fs_store/operations/record_error.py`

***

### [Content Invalidation](data-management/invalidation.md)

The generic `file change → re-index → entity change → refresh` loop that keeps an open asset editor in sync when its backing file is written out-of-band (an agent turn, an external editor, or an explicit push). Covers the three re-index triggers (GET-time `check_and_refresh_record`, the `POST /fs-records/invalidate` push endpoint → `reindex_paths`, and the agentic turn-end seam fired from all three transports), inner-file→owning-folder resolution + forced fresh re-parse via `discover_record_by_path(..., notify=True)`, the `updated_date = max(folder mtime, inner-file mtime)` change token, and the frontend `useFSRefContent` `reloadKey` body re-read with its unsaved-edits dirty guard. The middle (sync + broadcast) is [Entity-Index Sync](data-management/entity-index-sync.md).

**Key source files:** `flow_sdk/fs_store/reindex.py`, `flow_sdk/builtin/faas/fs_records_actions.py` (`_handle_fs_records_invalidate`, `discover_record_by_path`), `flow_sdk/builtin/agentic_process/agentic_process.py` (turn-end seams), `flow_sdk/core/entity/entity_model.py` (`_asset_updated_epoch`), `ui/src/hooks/use-fs-ref-content.ts`, `ui/src/utils/entity-reload-key.ts`

***

### [Schema Registry](data-management/schema-registry.md)

Unified type system for Record + Entity layers. `TypeInfo` per type (structural fields + hash + runtime refs + `locations`), `SchemaRegistry` class with O(1) registration/lookup, entity-side auto-registration via `DBBaseRecord.__init_subclass__` with merge semantics (record-side per-type behavior registered via `register_all` in `schema/type_info/`), centralized filesystem identity through `TypeInfo.mint_entity_id`, `TypeInfo.scans`/`append_scan`/`append_index` JSONL readers/writers, inheritance index for subtype discovery, convenience methods (`get_entity_cls`, `is_entity_type`, `get_all_entity_types`, `is_api_visible`, `is_creatable`, etc. — note there is no `get_record_cls`), duplicate entity registration guard (`ValueError` on `entity_cls` conflict), and index orchestration (`clear_index`, `get_index_status`). The Entity `type_registry` (`schema/entity_factory.py`) remains a backward-compat shim that delegates to SchemaRegistry. (The `fs_store/factory/type_registry.py` shim and the `SchemaRecord` class no longer exist.)

**Key source files:** `flow_sdk/fs_store/schema_registry.py`, `flow_sdk/db/drivers/db_base_record.py` (`DBBaseRecord.__init_subclass__`), `flow_sdk/schema/type_info/` (`register_all`), `flow_sdk/schema/entity_factory.py` (backward-compat shim, delegates to SchemaRegistry)

***

### [MCP Operations](data-management/mcp-operations.md)

The `flow-sdk-mcp` stdio server built on FastMCP. All five registered tools: `flow_ping` (health), `flow_entity_crud` (CRUD via optional `plugin_records` -- separate from core Entity model, does not write to SQLite or FTS), `flow_tag` (XML progress events + skill lifecycle), `flow_context` (per-session key-value store), and `session_analysis` (JSONL transcript summary/entry lookup). Covers how MCP tools differ from graph API actions, the debug JSON-RPC mode, and `.mcp.json` configuration.

**Key source files:** `flow_sdk/mcp_server/__init__.py`, `flow_sdk/mcp_server/mcp_api.py`, `flow_sdk/mcp_server/context_store.py`, `flow_sdk/mcp_server/debug.py`

***

### [Listen Action and CRUD Event Pipeline](data-management/listen-action.md)

The webhook listener (`POST /api/v1/webhook/listen`) that drives real-time entity synchronization. Covers the two webhook types (`hook_op` and `agent_hook`), `_reflect_entity()` idempotent create/update/delete algorithm (note: does NOT update FTS index), `_broadcast_to_sniffer()` for the annotation gutter, `_route_to_source_process()` for AgenticProcess routing, skill usage enrichment, annotation auto-creation side effects, write path tracking, `DataOpMessage` broadcast, `resource_tracker` recipient resolution, the WebSocket connection lifecycle, TypeScript-side `FlowSyncStore.onDataOp()` and `FsRecordDataOpHandler`, and the full end-to-end flow from CLI hook to React re-render.

**Key source files:** `flow_sdk/app/actions/listen.py`, `flow_sdk/api/messages.py`, `flow_sdk/core/network/resource_tracker.py`, `server/routes/websocket.py`, `ts_sdk/src/` (ConnectionManager, FlowSyncStore, FsRecordDataOpHandler)

***

### [System Tools (Frontend)](data-management/system-tools.md)

`SystemToolsService` — the TypeScript SDK service for backup, archive, restore, clear, scan, and index operations. Extends `EventEmitter` to emit `'state_changed'` whenever `currentActivity`, `progressTable`, or `scanInfo` changes. `useSystemTools()` hook provides `useSyncExternalStore`-based subscription so all components share the same activity state. Includes `resetAndRescan()` compound operation (archive → clear → scan → index) exposed as the refresh button in `SearchView`. Shared UI: `ActivityProgressBar` and `ActivityProgressModal` in `ui/src/components/search-index/ActivityProgressModal.tsx`.

**Key source files:** `ts_sdk/src/services/system-tools-service.ts`, `ui/src/hooks/use-system-tools.ts`, `ui/src/components/search-index/ActivityProgressModal.tsx`

***

## Quick Reference

| Question                                                                  | Where to look                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What fields does a Record have?                                           | [Record Model](data-management/record-model.md)                                                                                                             |
| Where are files stored on disk?                                           | [Folder Layout](data-management/folder-layout.md)                                                                                                           |
| How do I lay out a dataset (examples, gold, multiple annotations)?        | [Dataset Layout (Authoring Guide)](data-management/datasets.md)                                                                                             |
| How do I list all Claude sessions?                                        | [Scan and Discovery](data-management/scan-and-discovery.md)                                                                                                 |
| How do I search records by text?                                          | [Record Search](data-management/record-search.md)                                                                                                           |
| How do I find all entities under a filesystem folder?                     | `Entity.assets_by_path(PathQueryOptions)` / `GET /api/v1/assets/by-path`. See [Record Model](data-management/record-model.md#asset_ref-and-folder-queries). |
| How do I read/write Records via HTTP?                                     | [ComputeNode fs-records Action](data-management/compute-node-fs-records.md)                                                                                 |
| How does the DB stay in sync with disk?                                   | [Entity-Index Sync](data-management/entity-index-sync.md)                                                                                                   |
| How does an open editor refresh when its file changes on disk?            | [Content Invalidation](data-management/invalidation.md)                                                                                                     |
| How do I push a changed-file set to re-index (invalidate)?                | `POST /fs-records/invalidate` — [Content Invalidation](data-management/invalidation.md#edge-1--the-trigger-what-causes-a-re-index)                          |
| How does Claude Code write entity data?                                   | [MCP Operations](data-management/mcp-operations.md)                                                                                                         |
| What types are registered and what are their schemas?                     | [Schema Registry](data-management/schema-registry.md)                                                                                                       |
| How do I scan or index all records?                                       | [Scan and Discovery](data-management/scan-and-discovery.md) + [Schema Registry](data-management/schema-registry.md)                                         |
| When does indexing run (triggers)?                                        | [Scan and Discovery](data-management/scan-and-discovery.md#when-does-indexing-run)                                                                          |
| Which files/folders does the walk skip?                                   | [Gitignore-Aware Walk](data-management/gitignore-walk.md)                                                                                                   |
| How do session transcripts get indexed?                                   | [Transcript Indexing](data-management/transcript-indexing.md)                                                                                               |
| What builds the `index.md` docs indexes?                                  | [LLM Index](data-management/llm-index.md)                                                                                                                   |
| How do `[[wiki links]]` and backlinks work? | [Wiki Link Graph](llm_wiki.md)                                                                                                                              |
| How do frontend components get live updates?                              | [Listen Action and CRUD Event Pipeline](data-management/listen-action.md)                                                                                   |
| What are the three "index" systems?                                       | [Entity-Index Sync](data-management/entity-index-sync.md)                                                                                                   |
| Why don't webhook entities appear in search?                              | [Entity-Index Sync](data-management/entity-index-sync.md) / [Record Search](data-management/record-search.md)                                               |
| How do I trigger backup/clear/scan/index from the UI?                     | [System Tools (Frontend)](data-management/system-tools.md)                                                                                                  |
| How does the search refresh button work?                                  | [System Tools (Frontend)](data-management/system-tools.md)                                                                                                  |
| Where does an asset's bytes / a record's truth / a secret's value live?   | [Items & Origins](data-management/items_origins.md)                                                                                                         |
| How do I add a new origin kind (s3, gdrive)?                              | [Items & Origins](data-management/items_origins.md#adding-a-kind)                                                                                           |
| Why is `Entity.git_origin` a dict and not a typed model?                  | [Items & Origins](data-management/items_origins.md#the-wire-contract)                                                                                       |
| How does a feed / mailbox / repo get into the graph?                      | [Data Sources](data-management/data-sources.md)                                                                                                             |
| How do I add a new data source?                                           | [Data Sources](data-management/data-sources.md#adding-a-source)                                                                                             |
| Does a source copy files, or index them where they are?                   | [Data Sources](data-management/data-sources.md#the-two-destinations)                                                                                        |
| Why doesn't indexing a git repo dirty the working tree?                   | [Data Sources](data-management/data-sources.md#identity)                                                                                                    |
