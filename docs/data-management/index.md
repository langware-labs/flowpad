---
type: markdown_index
id: markdown_index-66704284-b246-51c2-849b-cf3c916f33de
inputs_hash: fc1fa459991c4e17e88615586f8183a100b0b29dafe120fc734d8f7e8c688e2e
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-25T12:04:30Z'
latest_process_ref: ''
file_count: 26
subfolder_count: 0
---

# data-management

## Self-Summary
> How disk and database stay one thing: assets and their identity capsules, the indexer walk and entity sync, DataSpec as the single shape system with its kind registry, data sources and datasets, records, search and the SQLite layer underneath.

## Files
- [Asset capsules](asset-capsules.md) — Storing named JSON metadata inside filesystem assets: folder, markdown-comment and source-comment capsule carriers, their shared CapsuleData shape, and the read/write API.
- [Asset management](asset-management.md) — flow_sdk.assets — filesystem asset discovery, identity resolution, install, removal, projection and inventory, built on frozen Asset and AssetFolder values.
- [ComputeNode `fs-records` Action](compute-node-fs-records.md) — The fs-records CRUD action on ComputeNode over disk-backed typed records: type and path routing, the write path, and when to prefer the Entity API.
- [Data source assets](data-source-asset.md) — Data sources as folder assets: data_driver.json manifest plus source.py discovered by convention, and the separate DataSource asset holding config, owner and cadence.
- [Data Sources UI (Frontend)](data-sources-ui.md) — Frontend Data Sources screen: grid, cards, add/edit dialog driven by DataDrivers, menus, replay, and liveness display.
- [Data sources](data-sources.md) — Data sources: one DataSource reads one stream via a driver, owning query, cursor and origin, and the fetch-to-SourceItem ingestion pipeline.
- [DataSpec — shape as Pydantic, the spec as the layout](data-spec.md) — DataSpec design: every shape is Pydantic, runtime shapes compile via DataSpec.parse, spec_kind links shapes to the registry, and an asset's disk layout is its class.
- [Database Architecture](database.md) — SQLite layer architecture: one async engine, pooling, pragmas, BEGIN IMMEDIATE on writers, batched indexer commits with writer-lock hand-over, and driver session resolution.
- [Dataset Layout (Authoring Guide)](datasets.md) — Authoring a dataset on disk: the dataset.json manifest, csv versus io_folder layouts, example and slot sidecars, and the metadata/data convention.
- [Entity Index Sync](entity-index-sync.md) — How filesystem Records and the SQLite Entity index stay linked by a shared (type, id), what sync_to_db does, and when to query which layer.
- [On-Disk Folder Layout](folder-layout.md) — The on-disk layout of flow-cli: the per-instance ~/.flow home, records and records_data roots, shadow folder naming, RecordType constants and the source-file check.
- [Filesystem Discovery Benchmark](fs_find.md) — Cross-platform benchmark of four recursive file-discovery methods, answering whether an OS-native index beats a Python walker and where the crossover lies.
- [Gitignore-Aware Filesystem Walk](gitignore-walk.md) — gitignore_walk(), the one pre-order scandir DFS every tree walker shares, and the single skip policy deciding which directories are descended into.
- [Content Invalidation (file change → reindex → refresh)](invalidation.md) — The invalidation loop that turns an out-of-band file write into fresh UI content: the re-index trigger and the file-body re-read at the two outer edges.
- [Items & origins](items_origins.md) — Origins as value objects saying where a thing really lives: the FSOrigin git/local union, its tolerant discriminator, rel_path placement, and how CloudOrigin differs.
- [Listen Action and CRUD Event Pipeline](listen-action.md) — Webhook POST to frontend cache update: listen_action, the two webhook types, _reflect_entity, DataOpMessage broadcast, recipient resolution, and the TypeScript subscription layer.
- [The LLM Folder-Index Pipeline](llm-index.md) — The index.md folder-index pipeline: LLMIndexer's hash-cache-assemble Merkle build, the on-disk artifacts, and the MarkdownIndex entity that indexes them.
- [MCP Server Operations](mcp-operations.md) — The flow_sdk MCP server Claude Code spawns over stdio: how it launches, its FastMCP and raw-debug modes, and the entity, tag, context and session tools.
- [Record Model](record-model.md) — The FSRecord class and flow_sdk/fs_store: disk as source of truth, per-type behaviour on TypeInfo, meta models, and what the lean rewrite deliberately dropped.
- [Record Search (FTS5/SQLite)](record-search.md) — Record search on SQLite FTS5: how FSRecord.sync_to_db indexes entries, how Entity.search and the search route query them, and how bulk reindexing runs.
- [Scan and Discovery](scan-and-discovery.md) — How FSIndexer walks roots through waypoints and per-type parsers, commits in batches handing the writer lock to queued writers, plus session lookup and index actions.
- [Schema Registry](schema-registry.md) — SchemaRegistry as the single source of type metadata: declarative TypeInfo modules, entity self-registration, merge semantics, kind resolution and persistence.
- [The source contract and the sync runtime](source-contract-boundary.md) — The boundary between the flow_sdk/sources contract (async sources, pages, ack) and the ingest sync runtime, with its one dependency direction.
- [Stream inbox projection — ingested messages become conversations](stream-inbox-projection.md) — One-way projection of ingested records into stream-inbox conversations: reference rows, the timestamp law, self-healing reindex, the two lanes and purge semantics.
- [System Tools Service (Frontend)](system-tools.md) — SystemToolsService, the frontend service for backup, archive, restore, clear, scan and index, and the compute-node action paths it calls through apiClient.
- [Transcript Indexing](transcript-indexing.md) — The opt-in transcript indexer that parses a session JSONL and runs handlers for side effects only, versus the FSIndexer that walks the filesystem.
