---
type: markdown_index
id: markdown_index-66704284-b246-51c2-849b-cf3c916f33de
inputs_hash: bd1b2c7ab818ca22364a12decec5299c97d5363b6fa918bf6b3e7e28fdbc9b2e
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-11-11T06:55:22.978113+00:00'
latest_process_ref: ''
file_count: 32
subfolder_count: 0
---

# data-management

## Self-Summary
> How Flowpad stores, discovers and indexes data: filesystem-backed records and assets, the SchemaRegistry, DataSpec schemas and datasets, data sources and their ingest contract, the SQLite entity index and full-text search, folder indexing, invalidation, and measured disk-IO benchmarks and interface proposals.

## Files
- [Asset capsules](asset-capsules.md) — Asset capsules in flow_sdk/capsules: AssetCapsule.from_path storing named JSON metadata in folders, Markdown comment markers, or source-file line comments.
- [Asset management](asset-management.md) — flow_sdk.assets: filesystem asset discovery, identity resolution, install, removal, projection, usage matching and inventory, built on frozen Asset and AssetFolder values.
- [ComputeNode `fs-records` Action](compute-node-fs-records.md) — The fs-records CRUD action on ComputeNode over disk-backed typed records: type and path routing, the write path, and when to prefer the Entity API.
- [Data source assets](data-source-asset.md) — Data driver folder assets (data_driver.json, source.py, helpers, tests) and configured DataSource assets in data_source.json, loaded by convention without flow_sdk registration.
- [Data Sources UI (Frontend)](data-sources-ui.md) — Data Sources screen frontend: DataSourcesView grid, rows, detail and page components, drivers view, channels list and setup button under ui/src/components/data-sources.
- [Data sources](data-sources.md) — Data sources: drivers walking external systems into SourceItems, the data-integrations persona's connect-sample-define flow, config coercion, and sync mechanics.
- [DataSpec — schemas as Pydantic, the schema as the layout](data-spec.md) — DataSpec base class in flow_sdk/schema/data_spec: Pydantic schemas for kinds, runtime-compiled schemas, and asset document layouts modeled as classes.
- [Database Architecture](database.md) — SQLite layer architecture: one async engine, pooling, pragmas, BEGIN IMMEDIATE on writers, batched indexer commits with writer-lock hand-over, and driver session resolution.
- [Dataset stores — where a dataset's rows live](dataset-stores.md) — Dataset row storage: dataset names one data source and path, falls back to project data store or instance folder, NotSetUp refusal until setup.
- [Dataset Layout (Authoring Guide)](datasets.md) — Dataset layout authoring guide: agentic-assets/dataset/<slug>/ with dataset.json manifest, csv or folder data_layout, rows, schemas, and curating a source into a dataset.
- [diskio — measured results](diskio-benchmarks.md) — Measured diskio results comparing base, Python and Rust FLOWPAD_DISKIO_BACKEND variants with interleaved rotated rounds and median timings on a loaded machine.
- [Benchmark results (FIXED unless a benchmark is rerun)](diskio-design-benchmarks.md) — Disk-I/O benchmark results comparing Rust CLIs against Python SDK paths across 13 units like gitignore matching, walks, Merkle tree, with verdicts.
- [Interface proposal — v6 — FINAL (iteration 6)](diskio.md) — Disk-I/O kernel interface proposal v6: eight Protocol pieces (TreeWalker, DocumentReader, ShadowStore, TreeHasher, etc.) with Python and Rust backends selected via kernel(piece).
- [Entity Index Sync](entity-index-sync.md) — How filesystem Records and the SQLite Entity index stay linked by a shared (type, id), what sync_to_db does, and when to query which layer.
- [Evals — a dataset's own eval, standard results, one report](evals.md) — Dataset evals: eval.json EvalSpec plus eval.py contract, RowEval and EvalRun kinds, verdicts, metrics, slices, and generic flow_sdk/evals reporting.
- [On-Disk Folder Layout](folder-layout.md) — Per-instance Flowpad storage layout, records, provider directories, type-to-folder mapping, source extractors, and configuration-file security rules.
- [Filesystem Discovery Benchmark](fs_find.md) — Cross-platform filesystem discovery benchmarks comparing Python walkers, native walkers, and OS indexes, including bootstrap latency findings and scale-dependent tradeoffs.
- [Ignore-File-Aware Filesystem Walk (`.gitignore`, `.flowignore`)](gitignore-walk.md) — gitignore_walk() pre-order os.scandir traversal honoring .gitignore and .flowignore, symlink and denylist policy, shared by all flow_sdk directory walkers.
- [Content Invalidation (file change → reindex → refresh)](invalidation.md) — File-change invalidation through reindexing, entity notifications, and frontend content refresh, including triggers, change tokens, and failure modes.
- [Items & origins](items_origins.md) — Items and origins: FSOrigin locating asset bytes (git, local) versus CloudOrigin locating record truth by kind, namespace, key, resolved through kind-keyed driver registries.
- [Listen Action and CRUD Event Pipeline](listen-action.md) — Webhook POST to frontend cache update: listen_action, the two webhook types, _reflect_entity, DataOpMessage broadcast, recipient resolution, and the TypeScript subscription layer.
- [The LLM Folder-Index Pipeline](llm-index.md) — LLM folder-index pipeline: LLMIndexer builds a Merkle tree of per-folder index.md summaries and sidecars, indexed as MarkdownIndex entities for docs-browse.
- [MCP Server Operations](mcp-operations.md) — The flow_sdk MCP server Claude Code spawns over stdio: how it launches, its FastMCP and raw-debug modes, and the entity, tag, context and session tools.
- [Meeting sources — Zoom, Teams, Google Meet](meeting-sources.md) — Research comparing Zoom, Teams and Google Meet recordings, transcripts and AI notes as data sources, covering auth, permissions, push mechanisms and driver-model fit.
- [Record Model](record-model.md) — The FSRecord class and flow_sdk/fs_store: disk as source of truth, per-type behaviour on TypeInfo, meta models, and what the lean rewrite deliberately dropped.
- [Record Search (FTS5/SQLite)](record-search.md) — Record search on SQLite FTS5: how FSRecord.sync_to_db indexes entries, how Entity.search and the search route query them, and how bulk reindexing runs.
- [Scan and Discovery](scan-and-discovery.md) — FSIndexer DFS discovery from roots through waypoint types with per-type parser slots, explicit-only indexing, auto-index exception, RecordQuery and session lookup.
- [Schema Registry](schema-registry.md) — SchemaRegistry: single source of type metadata, declarative TypeInfo modules in schema/type_info registered by register_all, plus Entity self-registration.
- [The source contract and the sync runtime](source-contract-boundary.md) — Boundary between the flow_sdk.sources contract (open, fetch, iterate, send, react, notify) and the sync runtime, with dependency direction rules.
- [Stream inbox projection — ingested messages become conversations](stream-inbox-projection.md) — Design of the one-way projection from ingested source items into stream inbox conversations, using reference-row messages, looked-up identity, dedupe locks and reindex repair.
- [System Tools Service (Frontend)](system-tools.md) — SystemToolsService, the frontend service for backup, archive, restore, clear, scan and index, and the compute-node action paths it calls through apiClient.
- [Transcript Indexing](transcript-indexing.md) — The opt-in transcript indexer that parses a session JSONL and runs handlers for side effects only, versus the FSIndexer that walks the filesystem.
