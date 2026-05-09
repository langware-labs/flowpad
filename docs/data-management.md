# Data Management

This document provides an overview of the data management architecture in flow-cli and links to detailed sub-documents for each subsystem.

## Architecture Overview

Flow-cli uses a two-layer data model:

- **Filesystem Records** (`flow_sdk/fs_store/`) -- the source of truth for all domain data. Records are Python objects backed by JSON files on disk (split format: `metadata.json` for identity + `_data.json` for domain fields). They are the canonical store for things like Claude sessions, settings, MCP configs, and agent-created entities. The `fs_store` package is a collection of modules (there is no single `FsStore` class). Each Record uses a single internal `_data` dict; the `_META_FIELDS` frozenset controls which fields are written to `metadata.json` vs `_data.json` on disk.
- **Database Entities** (`flow_sdk/core/entity/`) -- SQLite-backed, queryable indexes that mirror key metadata from Records. Entities support fast filtered queries (by status, date, project) that would require O(N) filesystem scans if done directly against Records. The FTS5 virtual table (`entities_fts`) provides full-text search over records that opt in via the `content` property.

**Record is primary — Entity is cache.** The write path always goes disk first:

```
record.save()          → JSON file on disk (source of truth)
record.sync_to_db()    → Entity row + FTS entry updated from the saved record
```

The two layers are kept in sync through a combination of:
- `rec.sync_to_db()` called explicitly after every fs-records POST/PUT
- Entity deletion by id before disk deletion on DELETE
- `_reflect_entity()` + FTS sync in the listen/webhook pipeline
- Lazy mtime staleness checks on API GET (Entity refreshes from Record if stale)

**fs-records vs Entity/graph API at a glance:**

| | fs-records | Entity / graph API |
|---|---|---|
| Storage | JSON files on disk | SQLite rows |
| Content | Full record payload | Metadata subset (`_ENTITY_META_FIELDS`) |
| Query | O(N) scan | Indexed SQL + FTS5, plus path-based descendant query (see below) |
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

The codebase uses the word "index" for three unrelated systems. Understanding the distinction is essential:

| System | What it is | Where it lives | Updated by |
|--------|-----------|----------------|------------|
| **RecordState** | Per-record property cache (`state.json`) | `flow_sdk/fs_store/record_state.py` | `Record.discovery()`, `Record.save()`, `Record.get_prop()` |
| **Entity Index** | SQLite rows mirroring Record metadata | `flow_sdk/core/entity/entity_model.py` | `Record.sync_to_db()` via `Entity.from_record()` |
| **FTS Index** | Full-text search virtual table | `entities_fts` in SQLite | `Record.sync_to_db()` via `fts_upsert()` (only if `content` is not None) |

See [Entity-Index Sync](data-management/entity-index-sync.md) for details on this naming distinction.

### Three Entity Creation Paths

Entities can be created through three independent paths:

| Path | Trigger | Creates Record? | Creates Entity? | Updates FTS? |
|------|---------|-----------------|-----------------|--------------|
| **ComputeNode fs-records** | HTTP CRUD on Records | Yes | Yes (via `rec.sync_to_db()`) | Yes |
| **Listen webhook** | `POST /api/v1/webhook/listen` | No | Yes (via `_reflect_entity()`) | Yes (via `_fts_sync_entity()`) |
| **MCP `flow_entity_crud`** | Claude Code MCP tool | Yes (via SDK Record layer) | Yes (via `rec.sync_to_db()`) | Yes |

All three paths now produce fully indexed entities visible to FTS search. See [ARCHITECTURE_ISSUES.md](data-management/ARCHITECTURE_ISSUES.md) for historical context.

### Data Flow

```
Claude CLI / external tool
       |
       |  POST /api/v1/webhook/listen  (hook_op)
       v
  listen_action()
       |  _reflect_entity()     -> Entity CREATE/UPDATE/DELETE in SQLite
       |  _fts_sync_entity()    -> FTS upsert (or _fts_delete_entity on DELETE)
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
       +- flow_entity_crud tool  -> record_cls(**fields).save() -> rec.sync_to_db()
```

### Type System

All record and entity types are managed by the **SchemaRegistry** (`flow_sdk/fs_store/schema_registry.py`), which provides:
- O(1) type registration and lookup via `TypeInfo` dataclasses
- Dual auto-registration: `Record.__init_subclass__` registers with `locations=["record"]`, `DBBaseRecord.__init_subclass__` registers with `locations=["index"]`
- Per-type persistence at `~/.flow/schema/types/<type>/type_info.json` (hash-gated writes)
- Scan/index orchestration: `discover()`, `rebuild_index()`, `incremental()`, `clear_index()`, `get_index_status()`

The **TypeId** (`flow_sdk/fs_store/type_id.py`) is the universal identifier format: `{type}-{id}`. It is a plain Python class (not a Pydantic BaseModel) with Pydantic v2 compatibility hooks. Five identifier types are supported: UUID, Namespace, PropId, Named (`@uname`), and Unknown.

Two legacy type registries exist as thin backward-compat shims: the FS Record `type_registry` (`fs_store/factory/type_registry.py`) and the Entity `type_registry` (`schema/entity_factory.py`). Both fully delegate to SchemaRegistry — `SchemaRegistry` is authoritative for all Record and Entity lookups.

## Sub-documents

### [Record Model](data-management/record-model.md)
The `Record` base class: single internal `_data` dict, `_META_FIELDS` frozenset for split-format file writes, attribute routing, `RecordStatus` enum, constructor patterns, `StorageLayout` (FILE/LIST_ITEM/FOLDER), auto-registration via `TypeRegistry` and `SchemaRegistry`, `RecordRef` structure, `RecordList` / `ResourceRecordList` / `SourceFileRecordList` differences, `RecordQuery` filtering, `CollectionManifest` for O(1) staleness checks, companion files, the meta/origin pattern for read-only records, and the split on-disk format (`metadata.json` + `_data.json` with `data.json` as legacy fallback).

**Key source files:** `flow_sdk/fs_store/record.py`, `record_types.py`, `storage_layout.py`, `record_ref.py`, `record_list.py`, `resource_record_list.py`, `source_file_record_list.py`, `factory/type_registry.py`, `record_query.py`, `record_state.py`, `manifest.py`

---

### [Folder Layout](data-management/folder-layout.md)
On-disk directory structure for both FlowPad records (`~/.flow/records/`) and Claude Code records (`~/.claude/`). Covers naming conventions (`<type>-@<uid>`), the split format (`metadata.json` + `_data.json`) with legacy `data.json` and `.flow_record/record.json` fallbacks, project directory encoding, all `RecordType` constants grouped by category, the `SourceFileRegistry` whitelist, and `is_allowed_source_path()` security check.

**Key source files:** `flow_sdk/fs_store/record_types.py`, `flow_sdk/fs_store/source_file_registry.py`, `flow_sdk/fs_records/` (all submodules)

---

### [Scan and Discovery](data-management/scan-and-discovery.md)
Two scan layers: `Record.discover()` (O(N) filesystem directory scan) and `SchemaRegistry.discover()` (orchestration across types with JSONL logging). Covers `Record.discover_one()` (O(1) path lookup), subclass overrides for source-file-backed records, the `ClaudeActiveSessionFsRecord` mtime staleness algorithm, `RecordQuery` filter/sort/paginate pipeline, scan API endpoints (`POST /api/v1/search/reindex`), and error/claude_error parallel discovery via `ClaudeErrorRecordList._do_sync()`.

**Key source files:** `flow_sdk/fs_store/record.py`, `flow_sdk/fs_store/schema_registry.py`, `flow_sdk/fs_records/claude/claude_active_session.py`, `claude_active_sessions.py`, `claude_session.py`, `flow_sdk/fs_store/source_file_record_list.py`, `record_query.py`, `flow_sdk/fs_records/record_error.py`, `flow_sdk/fs_records/claude/claude_error.py`

---

### [Record Search](data-management/record-search.md)
FTS5-backed full-text search for Records. Covers the `content` property opt-in, `index_fields` ClassVar, inline indexing via `Record.sync_to_db()` (no background worker), `save()`/`delete()` hooks, the FTS status post-filter limitation, and the FTS gap for webhook-created entities.

**Key source files:** `flow_sdk/server/routes/search.py`, `flow_sdk/db/drivers/sqlite/sqlite_driver.py` (fts_upsert, fts_search), `flow_sdk/fs_store/record.py` (content, index, deindex)

---

### [ComputeNode fs-records Action](data-management/compute-node-fs-records.md)
The `fs-records` custom action on `ComputeNode` -- the primary HTTP API for reading and writing Records. Full routing table (GET list, GET single, POST create, PUT update, DELETE, plus file-path variants), `_parse_record_query()` supported parameters, `_embed_includes()` session join, path-based source-file routing, security checks, TypeRegistry lookup, error response format, and DataOp broadcast on mutations.

**Key source files:** `flow_sdk/builtin/faas/compute_node.py` (fs_records_action and helpers), `flow_sdk/fs_store/source_file_registry.py`, `flow_sdk/fs_store/record_query.py`

---

### [Entity-Index Sync](data-management/entity-index-sync.md)
How SQLite Entities stay in sync with filesystem Records. Covers the three "index" naming distinction (RecordState vs Entity Index vs FTS Index), `Entity.from_record()` delegation, hash file tracking, `RecordError` on indexing failure, `vfs_record` VFS URI link, `vfs_orphan` tombstone, `sync_record()` mtime-based algorithm, `_apply_record_metadata()` field mapping, trigger points (API GET by ID, ComputeNode CRUD), `DataOpMessage` structure, `WSMessageType` enum, `resource_tracker` recipient resolution, SchemaRegistry orchestration methods (`discover()`, `rebuild_index()`, `incremental()`, `clear_index()`, `get_index_status()`), and the FTS gap for webhook-created entities.

**Key source files:** `flow_sdk/core/entity/entity_model.py`, `flow_sdk/app/actions/graph_crud_actions.py`, `flow_sdk/builtin/faas/compute_node.py` (_broadcast_fs_record_op, _sync_entity_from_record), `flow_sdk/core/network/resource_tracker.py`, `flow_sdk/api/messages.py`, `flow_sdk/fs_store/schema_registry.py`, `flow_sdk/fs_records/record_error.py`

---

### [Schema Registry](data-management/schema-registry.md)
Unified type system for Record + Entity layers. `TypeInfo` per type (structural fields + hash + runtime refs), `SchemaRegistry` class with O(1) registration/lookup, dual auto-registration via `__init_subclass__` with merge semantics, per-type `type_info.json` hash-gated persistence, `TypeInfo.scans` dynamic JSONL reader, inheritance index for O(1) subtype discovery, full scan/index orchestration, new convenience methods (`get_entity_cls`, `get_record_cls`, `is_entity_type`, `get_all_entity_types`, etc.), duplicate entity registration guard (`ValueError` on conflict), and error/claude_error parallel discovery path. Both legacy registries (`fs_store/factory/type_registry.py` and `schema/entity_factory.py`) are now shims that fully delegate to SchemaRegistry. Backward compat shim keeps `SchemaRecord` working.

**Key source files:** `flow_sdk/fs_store/schema_registry.py`, `flow_sdk/fs_records/schema_record.py` (thin shim), `flow_sdk/schema/entity_factory.py` (backward-compat shim, delegates to SchemaRegistry), `flow_sdk/fs_store/factory/type_registry.py` (backward-compat shim, delegates to SchemaRegistry)

---

### [MCP Operations](data-management/mcp-operations.md)
The `flow-sdk-mcp` stdio server built on FastMCP. All five registered tools: `flow_ping` (health), `flow_entity_crud` (CRUD via optional `plugin_records` -- separate from core Entity model, does not write to SQLite or FTS), `flow_tag` (XML progress events + skill lifecycle), `flow_context` (per-session key-value store), and `session_analysis` (JSONL transcript summary/entry lookup). Covers how MCP tools differ from graph API actions, the debug JSON-RPC mode, and `.mcp.json` configuration.

**Key source files:** `flow_sdk/mcp_server/__init__.py`, `flow_sdk/mcp_server/mcp_api.py`, `flow_sdk/mcp_server/context_store.py`, `flow_sdk/mcp_server/debug.py`

---

### [Listen Action and CRUD Event Pipeline](data-management/listen-action.md)
The webhook listener (`POST /api/v1/webhook/listen`) that drives real-time entity synchronization. Covers the two webhook types (`hook_op` and `agent_hook`), `_reflect_entity()` idempotent create/update/delete algorithm (note: does NOT update FTS index), `_broadcast_to_sniffer()` for the annotation gutter, `_route_to_source_process()` for AgenticProcess routing, skill usage enrichment, annotation auto-creation side effects, write path tracking, `DataOpMessage` broadcast, `resource_tracker` recipient resolution, the WebSocket connection lifecycle, TypeScript-side `FlowSyncStore.onDataOp()` and `FsRecordDataOpHandler`, and the full end-to-end flow from CLI hook to React re-render.

**Key source files:** `flow_sdk/app/actions/listen.py`, `flow_sdk/api/messages.py`, `flow_sdk/core/network/resource_tracker.py`, `server/routes/websocket.py`, `ts_sdk/src/` (ConnectionManager, FlowSyncStore, FsRecordDataOpHandler)

---

### [System Tools (Frontend)](data-management/system-tools.md)
`SystemToolsService` — the TypeScript SDK service for backup, archive, restore, clear, scan, and index operations. Extends `EventEmitter` to emit `'state_changed'` whenever `currentActivity`, `progressTable`, or `scanInfo` changes. `useSystemTools()` hook provides `useSyncExternalStore`-based subscription so all components share the same activity state. Includes `resetAndRescan()` compound operation (archive → clear → scan → index) exposed as the refresh button in `SearchView`. Shared UI: `ActivityProgressBar` and `ActivityProgressModal` in `ui/src/components/search-index/ActivityProgressModal.tsx`.

**Key source files:** `ts_sdk/src/services/system-tools-service.ts`, `ui/src/hooks/use-system-tools.ts`, `ui/src/components/search-index/ActivityProgressModal.tsx`

---

## Quick Reference

| Question | Where to look |
|---|---|
| What fields does a Record have? | [Record Model](data-management/record-model.md) |
| Where are files stored on disk? | [Folder Layout](data-management/folder-layout.md) |
| How do I list all Claude sessions? | [Scan and Discovery](data-management/scan-and-discovery.md) |
| How do I search records by text? | [Record Search](data-management/record-search.md) |
| How do I find all entities under a filesystem folder? | `Entity.assets_by_path(PathQueryOptions)` / `GET /api/v1/assets/by-path`. See [Record Model](data-management/record-model.md#asset_ref-and-folder-queries). |
| How do I read/write Records via HTTP? | [ComputeNode fs-records Action](data-management/compute-node-fs-records.md) |
| How does the DB stay in sync with disk? | [Entity-Index Sync](data-management/entity-index-sync.md) |
| How does Claude Code write entity data? | [MCP Operations](data-management/mcp-operations.md) |
| What types are registered and what are their schemas? | [Schema Registry](data-management/schema-registry.md) |
| How do I scan or index all records? | [Scan and Discovery](data-management/scan-and-discovery.md) + [Schema Registry](data-management/schema-registry.md) |
| How do frontend components get live updates? | [Listen Action and CRUD Event Pipeline](data-management/listen-action.md) |
| What are the three "index" systems? | [Entity-Index Sync](data-management/entity-index-sync.md) |
| Why don't webhook entities appear in search? | [Architecture Issues](data-management/ARCHITECTURE_ISSUES.md) (Critical #2) |
| How do I trigger backup/clear/scan/index from the UI? | [System Tools (Frontend)](data-management/system-tools.md) |
| How does the search refresh button work? | [System Tools (Frontend)](data-management/system-tools.md) |
