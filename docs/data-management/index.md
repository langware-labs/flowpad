---
type: markdown_index
id: markdown_index-f8c2dd24-51c7-5d6b-9374-e56547a6d0b0
inputs_hash: 4f7049e931b17d6f0e4d413b62cf07ff8d59685dac13272b7533dc37568a308e
template_version: 1
prompt_version: 1
parent_ref: markdown_index-0909616b-4692-5d1d-a02e-a155e2fe2bbb
vault_root: /Users/tzahi/_dev/langware/github/flowpad-open-source/docs
generated_at: '2026-10-20T12:52:40.795640+00:00'
latest_process_ref: ''
file_count: 32
subfolder_count: 0
---

# data-management

## Self-Summary
> How Flowpad stores, discovers and indexes data: filesystem-backed records and assets, the SchemaRegistry, DataSpec schemas and datasets, data sources and their ingest contract, the SQLite entity index and full-text search, folder indexing, invalidation, and measured disk-IO benchmarks and interface proposals.

## Files
- [Asset capsules](asset-capsules.md) — Asset capsules: named JSON metadata stored in folders, markdown comments, or source-file line comments, with read/write carriers and identity carriers
- [Asset management](asset-management.md) — The flow_sdk.assets API for filesystem asset discovery, identity resolution, install, removal, projection, usage matching and inventory, using Asset and AssetFolder handles.
- [ComputeNode `fs-records` Action](compute-node-fs-records.md) — ComputeNode fs-records action: type-based and path-based CRUD routes for filesystem-backed records, query parameters, entity sync, WebSocket broadcast, errors.
- [Data source assets](data-source-asset.md) — Data source asset folder layout: data_driver manifest, source.py, DataSource config files, runtime state, ownership, and manifest fields such as auth, webhook, reflect
- [Data Sources UI (Frontend)](data-sources-ui.md) — Frontend Data Sources screen: components under ui/src/components/data-sources, dataManager entities and actions, URL-first navigation, status and health rendering, channels still to connect.
- [Data sources](data-sources.md) — Backend model of data sources: pipeline from driver fetch to SourceItem ingestion, source contract and traits, status and health, identity, change envelope.
- [DataSpec — schemas as Pydantic, the schema as the layout](data-spec.md) — DataSpec base class for Pydantic schemas: kind registration, parsing schemas arriving as data, RowSpec and DatasetSpec generics, and asset layouts modeled by the schema class.
- [Database Architecture](database.md) — SQLite database architecture after the async refactor: single engine, pooling, pragmas, BEGIN IMMEDIATE, per-request transactions, session resolution, and fixes for database-is-locked errors
- [Dataset Layout (Authoring Guide)](datasets.md) — Authoring guide for dataset folder layout: dataset.json manifest, csv and io_folder layouts, slots, sidecars, row metadata, parsing rules, typed rows, and editors.
- [diskio — measured results](diskio-benchmarks.md) — Measured diskio benchmark results comparing base, python and rust backends: methodology, per-operation speedups, what did not improve, correctness checks, and the shadow-folder rename migration
- [Benchmark results (FIXED unless a benchmark is rerun)](diskio-design-benchmarks.md) — Benchmark results comparing Python SDK disk-IO paths (walk, gitignore, frontmatter, hashing, git, session stats) against throwaway Rust implementations, with speedups and verdicts per unit.
- [Interface proposal — v6 — FINAL (iteration 6)](diskio.md) — Final v6 interface proposal for the flow_sdk diskio kernel: eight Protocol pieces (walker, scanner, reader, hasher), Python and Rust backends, rules, open decisions, excluded I/O.
- [Entity Index Sync](entity-index-sync.md) — How filesystem Records sync into the queryable SQLite Entity index and FTS5 search: sync_to_db algorithm, indexer orchestration, staleness, DataOpMessage notifications, and query trade-offs.
- [Evals — a dataset's own eval, standard results, one report](evals.md) — Dataset eval framework: EvalSpec, RowEval and EvalRun schemas, the eval.py contract, running evals with report output, REST endpoints, and the SmartNavigator eval.
- [On-Disk Folder Layout](folder-layout.md) — On-disk layout of per-instance Flowpad home, record shadow folders, Claude Code directories, RecordType constants, source-file extractors and config filename whitelist.
- [Filesystem Discovery Benchmark](fs_find.md) — Cross-platform benchmark of filesystem discovery methods (Python walkers, find, plocate, mdfind, Everything) prompted by slow markdown discovery during bootstrap, with methodology and per-OS setup.
- [Gitignore-Aware Filesystem Walk](gitignore-walk.md) — The shared gitignore_walk() directory walker: pre-order scandir contract, two-stage skip (hardcoded denylist, nested .gitignore stack), .claude force-include, indexer option and consumers.
- [Content Invalidation (file change → reindex → refresh)](invalidation.md) — Content invalidation loop from out-of-band file change to reindex, updated_date change token, and frontend body re-read, covering triggers, gotchas, and key files.
- [Items & origins](items_origins.md) — FSOrigin and origin value objects: shape, kind-keyed driver registry, dedup key semantics, wire contract, bundle, and how to add a new origin kind.
- [Listen Action and CRUD Event Pipeline](listen-action.md) — Pipeline from webhook POST through listen_action, hook_op and agent_hook handling, entity reflection, DataOpMessage WebSocket broadcast and recipient resolution to frontend cache updates
- [The LLM Folder-Index Pipeline](llm-index.md) — LLMIndexer pipeline that builds Merkle-tree index.md folder indexes with cached LLM summaries, plus the MarkdownIndex entity, rebuild process, server routes, and contrast with FSIndexer
- [MCP Server Operations](mcp-operations.md) — The flow_sdk MCP server: launch paths, tool registration, the registered tools (ping, entity CRUD, tag, context, session analysis), .mcp.json configuration and logging.
- [Meeting sources — Zoom, Teams, Google Meet](meeting-sources.md) — Research comparing Zoom, Teams and Google Meet recordings, transcripts, AI notes, auth, webhooks and plan limits as data sources, with fit to the driver model.
- [Mirroring a system of record](mirroring-a-system-of-record.md) — Mirroring typed rows from an external system of record such as a CRM: credential, driver, source and dataset roles, field ownership, failure handling, deliberate gaps.
- [Record Model](record-model.md) — FSRecord class and fs_store infrastructure: on-disk record layout, identity, save/load, DB sync, SchemaRegistry and TypeInfo, RecordList, RecordQuery and CollectionManifest.
- [Record Search (FTS5/SQLite)](record-search.md) — SQLite FTS5 record search: indexing via sync_to_db, FTS table, TypeInfo index_fields, Entity.search, HTTP search and reindex endpoints, and performance notes
- [Scan and Discovery](scan-and-discovery.md) — FSIndexer depth-first disk walker design: roots, walker registration, per-type dispatch, RecordQuery, when indexing runs, scan/index API endpoints, error records, performance and known issues.
- [Schema Registry](schema-registry.md) — SchemaRegistry and TypeInfo type metadata: declarative registration, persistence, scan and index orchestration with index-run logs, backward compatibility, HTTP endpoints, usage examples.
- [The source contract and the sync runtime](source-contract-boundary.md) — Boundary between the flow_sdk.sources contract (source sessions, frozen values, capabilities, errors) and the ingest sync runtime (polling, cursors, idempotent writes, health parking).
- [Stream inbox projection — ingested messages become conversations](stream-inbox-projection.md) — One-way projection of ingested cloud messages into stream inbox conversations as reference FlowMessage rows: identity lookup, timestamp rules, reindex healing, lanes, and purge behavior.
- [System Tools Service (Frontend)](system-tools.md) — Frontend SystemToolsService reference: backup, archive, restore, clear, scan and index operations, backend actions used, progress events, conflict detection, useSystemTools hook, methods and callers.
- [Transcript Indexing](transcript-indexing.md) — Opt-in TranscriptIndexer that parses session JSONL transcripts into side-effect handlers, contrasted with FSIndexer, including its timestamp-based freshness check and idempotent forced reindex.
