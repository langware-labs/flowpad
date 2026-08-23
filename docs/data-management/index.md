---
type: markdown_index
id: markdown_index-66704284-b246-51c2-849b-cf3c916f33de
inputs_hash: fcb04e90d3eb573170adebfaedc205a0eb8e008492f1aebc58eb57e625ea06d0
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: "2026-08-23T22:20:45.823073+00:00"
latest_process_ref: ''
file_count: 21
subfolder_count: 0
---

# data-management

## Self-Summary
> The data layer: filesystem records as the source of truth, with Entity and FTS rows as rebuildable indexes. Covers origins, data sources, the record model and on-disk layout, dataset authoring, scan and discovery, the gitignore walk, invalidation, search, the schema registry, and the LLM folder index.

## Files
- [Asset capsules](asset-capsules.md) — Portable named metadata carriers: the flowpad:capsule tag format, versioned data and tags sections, and how capsules integrate with entity identity resolution.
- [ComputeNode `fs-records` Action](compute-node-fs-records.md) — The ComputeNode fs-records action: full routing table, type-based CRUD over on-disk records, type-registry lookup on entry, and read-only record handling.
- [Data source assets](data-source-asset.md) — The data_source.json manifest a source ships as: schema, requires, name, auth, reflect, config form, traits, and runtime discovered by file presence.
- [Data sources](data-sources.md) — Ingestion from remote systems: the poller, sync and ingestor pipeline, driver contract and traits, status versus health, record-or-asset destinations, identity, and change envelope.
- [Database Architecture](database.md) — SQLite architecture: NullPool rationale, each pragma, BEGIN IMMEDIATE, driver session resolution, what stays synchronous, and the scaffolded per-request transaction.
- [Dataset Layout (Authoring Guide)](datasets.md) — Authoring contract for a dataset folder: the dataset.json manifest, two-section JSON convention, csv and io_folder layouts, slots, sidecars, and portability.
- [Entity Index Sync](entity-index-sync.md) — How Records on disk and Entity rows stay aligned: sync_to_db's algorithm, entity-record linkage, index removal, FTS exclusions, and indexer orchestration.
- [On-Disk Folder Layout](folder-layout.md) — On-disk layout of the per-instance FlowPad home and records root: folder naming, the flat metadata file, asset_ref, hash sentinel, and Claude directories.
- [Filesystem Discovery Benchmark](fs_find.md) — Benchmark of OS filesystem-discovery indexers (plocate, mdfind, Everything) against synthetic and real trees, with results and conclusions.
- [Gitignore-Aware Filesystem Walk](gitignore-walk.md) — The gitignore-aware walk: a hardcoded denylist stage, the nested .gitignore stack, the force-include of .claude, and the gitignore option flag.
- [Content Invalidation (file change → reindex → refresh)](invalidation.md) — The file-change to reindex to refresh loop: lazy GET-time refresh, explicit invalidate, turn-end push, updated_date as change token, and frontend body re-read.
- [Items & origins](items_origins.md) — FSOrigin, the locator saying where an asset's bytes live: the git and local union, driver registry, key() as dedup handle, wire contract, and bundle files.
- [Listen Action and CRUD Event Pipeline](listen-action.md) — The listen webhook and CRUD event pipeline: envelope shape, the hook_op and agent_hook types, sync operations, and dispatch to entity reflection.
- [The LLM Folder-Index Pipeline](llm-index.md) — The index.md Merkle folder-index pipeline: the standalone llm_index library, content hashing, the LLMIndexer engine, summary cache, on-disk artifacts, and rebuild.
- [MCP Server Operations](mcp-operations.md) — The MCP server: launch paths and transport, the tool-registration pattern, and the registered tools including entity CRUD, tag, context, and session analysis.
- [Record Model](record-model.md) — FSRecord as the single concrete record class: instance storage, identity and fingerprint minting, on-disk layout, save and load, FSRefs, and index state.
- [Record Search (FTS5/SQLite)](record-search.md) — Full-text record search on SQLite FTS5: the virtual table, what gets indexed via index_fields, sync and delete operations, the HTTP API, and performance.
- [Scan and Discovery](scan-and-discovery.md) — The FSIndexer walk: roots, transient waypoint types, the walker registration graph and expanders, type-gated dispatch, chunked DFS, and out-of-process scanning.
- [Schema Registry](schema-registry.md) — SchemaRegistry as the one registry for every record and entity type: how TypeInfo is declared and merged from two sources, and what it orchestrates.
- [System Tools Service (Frontend)](system-tools.md) — The frontend system-tools service: the activity model, progress_report WebSocket events, conflict detection, the useSystemTools hook, and shared UI components.
- [Transcript Indexing](transcript-indexing.md) — The opt-in side-effect pass over parsed transcript entries: freshness versus hash sentinels, the handler contract, shipped handlers, and the 404 self-heal path.
