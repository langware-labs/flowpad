# Dev Skill Learnings

## Record/Index/Scan System (2026-03-15)

- Three unrelated systems are all called "index" in the codebase: RecordIndex (per-record property cache), Entity Index (SQLite rows), and FTS Index (full-text search). Always disambiguate when discussing index-related work.
- `FsStore` is not a class — it's a package of modules. Docs that imply a single `FsStore` class are wrong.
- Records use a single internal `_data` dict (not separate `_meta_data` + `_data` dicts). The `_META_FIELDS` frozenset controls split-format file writes only.
- Three entity creation paths exist with different indexing behavior: ComputeNode fs-records (full), Listen webhook (no FTS), MCP plugin_records (separate system entirely).
- Webhook-created entities via `_reflect_entity()` do NOT get FTS-indexed — invisible to `/api/v1/search`.
- `TypeId` is a plain Python class with Pydantic v2 compat hooks, NOT a Pydantic BaseModel.
- `error`/`claude_error` record types are NOT in `_BUILTIN_DEFAULT_TYPES` — they use a parallel discovery path via `ClaudeErrorRecordList._do_sync()` with 30s throttle.
- `docs/discovery.md` (PropertyRecord TTL) and `flow_sdk/discovery/` (app-level Flowpad discovery) are completely different systems — neither references the other.
- MEMORY.md references `POST /fs-records/index?limit_per_type=N` and `GET /fs-records/scan?limit_types=N` which do not exist in the codebase — remove or update.
- Entity registry (`entity_factory.py`) does NOT delegate to SchemaRegistry — they are fully independent. Types registered only in SchemaRegistry won't be found by the Entity factory.
