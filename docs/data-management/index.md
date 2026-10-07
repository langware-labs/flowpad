---
type: markdown_index
id: markdown_index-66704284-b246-51c2-849b-cf3c916f33de
inputs_hash: 3195fb8984a69e1498b9a6f66e6244b2cacf1c081a5ac66e7630e4915d1e44a4
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-07T14:46:43Z'
latest_process_ref: ''
file_count: 28
subfolder_count: 0
---

# data-management

## Self-Summary
> How disk and database stay one thing: assets and their identity capsules, the indexer walk and entity sync, DataSpec as the one schema system (kind, schema, value) with its kind registry, data sources and datasets, evals, records, search and the SQLite layer underneath.

## Files
- [Asset capsules](asset-capsules.md) — Asset capsules: named JSON metadata stored in folders, Markdown comments and source-file comments, with read, write, remove operations and typed errors.
- [Asset management](asset-management.md) — flow_sdk.assets — filesystem asset discovery, identity resolution, install, removal, projection and inventory, built on frozen Asset and AssetFolder values.
- [ComputeNode `fs-records` Action](compute-node-fs-records.md) — The fs-records CRUD action on ComputeNode over disk-backed typed records: type and path routing, the write path, and when to prefer the Entity API.
- [Data source assets](data-source-asset.md) — Layout and conventions of data driver and data source asset folders: manifest, source.py, helper modules, tests, and the DataSourceSpec file authored per configured source.
- [Data Sources UI (Frontend)](data-sources-ui.md) — Frontend reference for the Data Sources screen: its components, add/edit/pause/replay/delete actions, and per-source health display
- [Data sources](data-sources.md) — How a DataSource ingests one external stream (driver, config, cursor, origin) into SourceItem records, from connecting to curating into a dataset.
- [DataSpec — schemas as Pydantic, the schema as the layout](data-spec.md) — DataSpec, the Pydantic base class for every schema: kinds versus schemas versus values, frozen extra-forbid behavior, and compiling runtime-arriving schemas into subclasses.
- [Database Architecture](database.md) — SQLite layer architecture: one async engine, pooling, pragmas, BEGIN IMMEDIATE on writers, batched indexer commits with writer-lock hand-over, and driver session resolution.
- [Dataset Layout (Authoring Guide)](datasets.md) — Authoring guide to dataset folder layout on disk: dataset.json manifest, csv versus io_folder layouts, example normalization, and the metadata plus data JSON convention.
- [Entity Index Sync](entity-index-sync.md) — How filesystem Records and the SQLite Entity index stay linked by a shared (type, id), what sync_to_db does, and when to query which layer.
- [Evals — a dataset's own eval, standard results, one report](evals.md) — Dataset evals: eval.json spec, eval.py contract, example and run result kinds, verdicts, metrics, slices and the standard report
- [On-Disk Folder Layout](folder-layout.md) — The on-disk layout of flow-cli: the per-instance ~/.flow home, records and records_data roots, shadow folder naming, RecordType constants and the source-file check.
- [Filesystem Discovery Benchmark](fs_find.md) — Cross-platform benchmark of four recursive file-discovery methods, answering whether an OS-native index beats a Python walker and where the crossover lies.
- [Gitignore-Aware Filesystem Walk](gitignore-walk.md) — The shared gitignore_walk() directory traversal: pre-order scandir DFS, symlink and unreadable-directory handling, and the single skip policy for gitignore and denylist.
- [Content Invalidation (file change → reindex → refresh)](invalidation.md) — The invalidation loop that turns an out-of-band file write into fresh UI content: the re-index trigger and the file-body re-read at the two outer edges.
- [Items & origins](items_origins.md) — Items and origins: FSOrigin value objects (git, local) locating asset bytes, contrasted with CloudOrigin, plus driver registry and shape.
- [Listen Action and CRUD Event Pipeline](listen-action.md) — Webhook POST to frontend cache update: listen_action, the two webhook types, _reflect_entity, DataOpMessage broadcast, recipient resolution, and the TypeScript subscription layer.
- [The LLM Folder-Index Pipeline](llm-index.md) — The index.md folder-index pipeline: LLMIndexer's hash-cache-assemble Merkle build, the on-disk artifacts, and the MarkdownIndex entity that indexes them.
- [MCP Server Operations](mcp-operations.md) — The flow_sdk MCP server Claude Code spawns over stdio: how it launches, its FastMCP and raw-debug modes, and the entity, tag, context and session tools.
- [Meeting sources — Zoom, Teams, Google Meet](meeting-sources.md) — Research comparing Zoom, Teams and Google Meet recordings, transcripts and AI notes as data sources, covering auth, permissions, push mechanisms and driver-model fit.
- [Record Model](record-model.md) — The FSRecord class and flow_sdk/fs_store: disk as source of truth, per-type behaviour on TypeInfo, meta models, and what the lean rewrite deliberately dropped.
- [Record Search (FTS5/SQLite)](record-search.md) — Record search on SQLite FTS5: how FSRecord.sync_to_db indexes entries, how Entity.search and the search route query them, and how bulk reindexing runs.
- [Scan and Discovery](scan-and-discovery.md) — Disk-to-index discovery in flow_sdk: the FSIndexer DFS walker, per-type slots, explicit-only indexing, session lookup, RecordQuery filtering and error records
- [Schema Registry](schema-registry.md) — SchemaRegistry as the single source of type metadata: TypeInfo authoring, registration, kind binding to DataSpec schemas, and the EntityType enum.
- [The source contract and the sync runtime](source-contract-boundary.md) — Boundary between the flow_sdk.sources contract (open, fetch, iterate, send, react, notify) and the sync runtime, with dependency direction rules.
- [Stream inbox projection — ingested messages become conversations](stream-inbox-projection.md) — Design of the one-way projection from ingested source items into stream inbox conversations, using reference-row messages, looked-up identity, dedupe locks and reindex repair.
- [System Tools Service (Frontend)](system-tools.md) — SystemToolsService, the frontend service for backup, archive, restore, clear, scan and index, and the compute-node action paths it calls through apiClient.
- [Transcript Indexing](transcript-indexing.md) — The opt-in transcript indexer that parses a session JSONL and runs handlers for side effects only, versus the FSIndexer that walks the filesystem.
