---
id: 63694603-d4ad-5cbb-bba2-e2abf32ac21c
---

# Entity Index Sync

## Naming Clarification

There are three distinct "index" concepts in the codebase:

| Name | Location | Purpose |
|------|----------|---------|
| **Hash sentinel** (`<epoch>_<hash>_<pathdigest>.hash`) | record shadow folder | Per-record index-staleness token read by `index_required`. See [record-model.md](record-model.md). |
| **Entity Index** (SQLite `entities` table) | `Entity` class: `flow_sdk/core/entity/entity_model.py` | Queryable database of record metadata. **This document.** |
| **FTS5 Index** (`entities_fts`) | `flow_sdk/db/drivers/sqlite/sqlite_driver.py` | Full-text search virtual table, populated alongside Entity Index. |

(A third historical "index" — the per-record `state.json`/`RecordState` property cache — was removed with the `FSRecord` refactor and no longer exists.)

---

## Conceptual Model

DB Entities are SQLite-backed queryable indexes. The filesystem Record is the source of truth for domain data. These two layers are linked but deliberately kept separate: the Entity stores only a small, indexed subset of Record metadata, while the Record holds the full domain content.

The Entity and its Record share the same `id` (derived from the same `uuid5`/natural key on both sides — see `docs/CLAUDE.md` rule 20), so the link is the `(type, id)` pair, not a stored cross-reference column. The Entity also mirrors the Record's on-disk `asset_ref` path string so path-based queries (`Entity.assets_by_path`) work without filesystem reads.

```
Record (filesystem, source of truth)
    |
    |  shared (type, id)  <-- same uuid5 on both sides; Entity also mirrors asset_ref path
    |
    |  Record.sync_to_db()   <-- explicit async call after CRUD
    |
    v
Entity (SQLite, queryable index)    entities_fts (FTS5 virtual table)
    |
    |  DataOpMessage    <-- WebSocket notification to frontend
    v
Frontend (reactive UI)
```

### Why This Separation

**Query entity (SQLite) when:**
- You need filtered results across many items (e.g., "all tasks with status=open in project X")
- You need relationship traversal (HostedBy, ConnectedTo, etc.)
- You need pagination or sorting
- You need full-text search across record content
- Performance matters -- SQLite indexed reads are orders of magnitude faster than filesystem scans

**Scan filesystem (Records) directly when:**
- You need the full domain data for one specific record (title, description, body, custom fields)
- You need data that was never mirrored to the Entity (only the fields in the type's `meta_model` plus a few base columns like `scope`, `project_id`, `asset_ref` are mirrored)
- You are doing a one-off traversal of a known directory tree
- You need data that has not been indexed yet

The Entity layer answers "which ones" and "how many"; the Record layer answers "what is in this one".

---

## Entity ↔ Record Linkage

The `Entity` base class (`flow_sdk/core/entity/entity_model.py`) does **not** carry a `record_data_ref` or `indexed_content` field anymore. (A legacy `record_data_ref` *column* still exists on the SQLite `entities` table from an old migration in `sqlite_driver.py`, but the model no longer reads or writes it.)

The link is implicit: the Entity and its Record share the same `(type, id)` pair, where the `id` is the same `uuid5` derived from the same natural key on both sides (`Entity.allocate_id` ↔ `Record.fingerprint`; see `docs/CLAUDE.md` rules 9 and 20). The Entity additionally mirrors the Record's `asset_ref` path string (a base column) so path-range queries work without disk reads.

### Loading the Record from an Entity

`Entity.get_record()` is the async accessor that resolves the Entity back to its filesystem Record:

```python
async def get_record(self) -> "FSRecord | None":
    from flow_sdk.fs_store.fs_record import FSRecord
    return FSRecord.load_or_none(self.get_type(), self.id)
```

It looks the record up by `(type, id)` — there is no `"type/id"` string to parse and no `record` property.

---

## `Record.sync_to_db()` Implementation

```python
async def sync_to_db(self, fts_batch: list | None = None, notify: bool = True) -> None:
```

Defined on `FSRecord` in `flow_sdk/fs_store/fs_record.py`. **The way to get a Record into the Entity DB with full FTS + wiki indexing.**

### Step-by-Step Algorithm

The whole pipeline runs inside a single shared DB session (`async with _db_session()`) for cache coherence:

1. **Entity row via `Entity.from_record(self, notify=notify)`.** Looks up the entity by deterministic id (or creates it), copies `meta_dict()` fields plus any missing domain fields and the FSRef-derived `scope`/`project_id`, then saves. The DataOp WebSocket emission happens here, via `entity.save(notify=notify)` (NOT in `sync_to_db` directly).

2. **Mirror DB state back to disk.** `await asyncio.to_thread(self.sync_from_entity, entity)` pulls canonical `id`, `scope`, `project_id`, `asset_ref`, `updated_date` from the DB row back into the in-memory record (and onto `metadata.json`).

3. **FTS5 upsert.** Builds an `FtsEntry(entity_id, entity_type, name, title, description, content)` — populated from the record's `search_title` / `search_description` / `search_content` readers (no per-record re-parse). If `fts_batch` is provided the entry is appended for a later bulk flush; otherwise `driver.fts_upsert(entry)` runs immediately.

4. **Wiki edge re-extraction.** `await wiki.index(self.type, self.id, self.wiki_body())`. Failures here are logged as warnings, not fatal.

5. **Type-specific `post_sync_fn` hook.** If the type's `TypeInfo.post_sync_fn` is set (registered from the per-type `TypeMetadata`), it is awaited: `await info.post_sync_fn(self)`. Failures are logged as warnings, not fatal.

6. **Error handling.** On any exception in the pipeline, `from_exception(self, exc, trigger="sync_to_db")` (in `flow_sdk/fs_store/operations/record_error.py`) builds and `.save()`s a `RecordError` before re-raising.

> Note: the index sentinel (`write_hash` / the `<ts>_<hash>.hash` file) is **not** stamped by `sync_to_db` itself — it is written by the indexer (`FSIndexer`) after a successful index pass. `sync_to_db` updates the Entity row, FTS, and wiki only.

### Removing a Record from the Index

There is no `Record.deindex()` method. De-indexing is done by the caller: the fs-records DELETE handler (below) calls `driver.fts_delete(entity.id)` then `entity.delete()`. On the Entity side, `Entity.removeSearchIndex()` wraps `fts_delete`, and `Entity.destroy()` removes both the DB row and the on-disk record folder.

### When sync_to_db() Is Called

| Trigger | Location | Notes |
|---------|----------|-------|
| Record CRUD via fs-records API | `FsRecordsActionsMixin._fs_records_action()` | `sync_to_db()` on every POST/PUT; DELETE removes the row + FTS directly |
| Indexer scan/index pass | `FSIndexer.index()` / `.scan()` (`flow_sdk/fs_store/indexer/index_function.py`) | Walk roots, index per-type via registered indexer functions |
| Discover-or-recover by path | `FsRecordsActionsMixin._handle_fs_records_discover_by_path()` | `sync_to_db()` after recovering a record by path |
| GET-time freshness refresh | `Entity.check_and_refresh_record()` (via `handle_get_by_id`) | Re-sync iff `index_required`; then stamps the sentinel |
| Push invalidate / agent turn-end | `reindex_paths()` → `discover_record_by_path(..., notify=True)` | Force re-parse of a changed-file set — see [Content Invalidation](invalidation.md) |
| Explicit application code | anywhere | `await record.sync_to_db()` |
| `Entity.get_all()` / `get_one()` | (none) | NOT triggered -- performance |

`get_all()` and `get_one()` do not call `sync_to_db()`. Running it on every list query would cause O(N) filesystem reads per list request.

The end-to-end **invalidation loop** (what triggers a re-index when a file
changes out-of-band, and how the frontend re-reads the body afterward) is
documented separately in [Content Invalidation](invalidation.md) — this document
covers the middle (`sync_to_db` pipeline + `DataOpMessage`); that one covers the
outer edges (trigger + FE `useFSRefContent` `reloadKey` re-read).

### Entities NOT FTS-indexed

Entities created via `_reflect_entity()` (the listen/webhook path in `flow_sdk/app/actions/listen.py`) do NOT get FTS-indexed: that path calls `entity.save()` directly, writing the Entity row without an `fts_upsert`. Only the `sync_to_db()` / `FSIndexer` path performs full indexing (Entity row + FTS5 + wiki).

---

## Indexer Orchestration & SchemaRegistry

Scan/index *orchestration* lives in `FSIndexer` (`flow_sdk/fs_store/indexer/index_function.py`), which walks the configured roots and indexes records per type using the indexer functions in `flow_sdk/fs_store/indexer/functions/`. `SchemaRegistry` (`flow_sdk/fs_store/schema_registry.py`) is the type *metadata* registry plus index logging / status / clear helpers.

### FSIndexer

| Method | Description |
|--------|-------------|
| `FSIndexer.index(...)` | Walk roots, index matching records (calls `sync_to_db`, batches FTS, writes hash sentinels). Returns `IndexResult` / per-type `PerTypeIndexResult`. |
| `FSIndexer.scan(...)` | Read-only scan for stats / orphan detection (no DB writes). |
| `FSIndexer.add_function()` / `add_root()` | Register an indexer function / a root `FSRef` to walk. |

### SchemaRegistry (type metadata + index bookkeeping)

| Method | Signature | Description |
|--------|-----------|-------------|
| `get()` | `(type_name) -> TypeInfo \| None` | Look up the registered `TypeInfo` for a type |
| `register()` | `(info: TypeInfo)` | Register a type (called by `TypeMetadata.register()`) |
| `get_entity_cls()` | `(type_name) -> type \| None` | Resolve the `Entity` subclass for a type |
| `clear_index()` | `async (types)` | Delete Entity rows + FTS entries + clear hash sentinels for the given types |
| `get_index_status()` | `async (types)` | Per-type status: `last_indexed_at`, `stale` (= `index_required`) |
| `get_errors()` | `(type_name)` | List `RecordError`s from failed indexing |
| `append_scan()` / `append_index()` | `(...)` | Append a scan/index log entry |
| `get_default_index_types()` | `()` | Types to index by default (see below) |

### Default Indexed Types

`SchemaRegistry.get_default_index_types()` returns the types whose `TypeMetadata.indexed_by_default=True` (collected at `register()` time).

### Staleness

`get_index_status()` reports `stale = index_required`, i.e. the record's current source hash differs from the hash captured in the `.hash` sentinel at last index. It is **not** a wall-clock (e.g. 24h) threshold — staleness means "the source changed since the last index", evaluated via `FSRecord.index_required`.

### Logging

Scan/index operations are appended to per-type JSONL logs via `append_scan()` / `append_index()`, with last-scan/last-index timestamps available via `get_last_scan_at()` / `get_last_index_at()`.

---

## FTS5 Integration

### `entities_fts` Virtual Table Schema

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    entity_id, type, name, title, description, content,
    tokenize='porter unicode61'
);
```

- Populated by `fts_upsert()` -- no database triggers
- `porter` stemmer for English-language search (run -> runs -> running)
- `unicode61` tokenizer for Unicode text
- Search ranks columns with `bm25(...)` weights (title/description/content weighted higher than entity_id/type)

Rows are written via the `FtsEntry` dataclass (`entity_id`, `entity_type`, `name`, `title`, `description`, `content`).

### Driver Methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `fts_upsert` | `(entry: FtsEntry \| list[FtsEntry], batch_size=500)` | Delete + insert (full replace). Called by `sync_to_db()`; accepts a batch. |
| `fts_delete` | `(entity_id)` | Remove a row from FTS table. Called on record deletion. |
| `fts_search` | `(query, limit, record_type, status, calibration)` | FTS5 MATCH, joins `entities_fts` to `entities`. Returns hydrated Entity objects. |
| `browse_by_type` | `(entity_type, limit, status)` | Filter-only browsing (no query) with FTS metadata, ordered by recency. |

All are methods on the SQLite driver class (`flow_sdk/db/drivers/sqlite/sqlite_driver.py`).

---

## fs-records CRUD

The fs-records CRUD gateway lives in `FsRecordsActionsMixin` (`flow_sdk/builtin/faas/fs_records_actions.py`), exposed by `ComputeNode` via the `fs-records` action. For each write the handler indexes first, then broadcasts:

```
POST   /fs-records/{type}        -> create on disk -> rec.sync_to_db() -> _broadcast_fs_record_op("create", ...)
PUT    /fs-records/{type}/{uid}  -> update on disk -> rec.sync_to_db() -> _broadcast_fs_record_op("update", ...)
DELETE /fs-records/{type}/{uid}  -> fts_delete + entity.delete() + remove from disk -> _broadcast_fs_record_op("delete", ...)
```

- **`rec.sync_to_db()`** updates (or creates) the Entity row, FTS5 entry, and wiki edges. The entity-create/update DataOp is emitted inside `from_record` → `entity.save(notify=True)`.
- **`_broadcast_fs_record_op()`** is **notification-only**: it constructs `DataOpMessage(op=..., to_entity=TypeId(type, uid), data=...)` and calls `handle_entity_op()` for WebSocket delivery to watching frontend connections. It performs no Entity/FTS work (the docstring states this explicitly).

For `delete`, the handler removes the Entity row + FTS entry directly (`fts_delete(entity.id)` then `entity.delete()`), deletes the record folder and the live `asset_ref` file/folder from disk, then broadcasts the delete DataOp. There is no `Record.deindex()`.

---

## DataOpMessage Structure

```python
class DataOpMessage(EntityMessage):
    model_config = ConfigDict(use_enum_values=True)
    message_type: str = "data_op_msg"   # WSMessageType.DATA_OP_MSG.value
    op: OperationType   # "create" | "update" | "delete"
    data: Any = None
    # inherited from EntityMessage: from_entity: TypeId | None, to_entity: TypeId
    # inherited from BaseMessage:   message_id: str, instance_id: int
```

Wire format example:

```json
{
  "message_type": "data_op_msg",
  "message_id": "a1b2c3d4...",
  "instance_id": 42,
  "to_entity": "task-abc123",
  "op": "update",
  "data": {
    "id": "abc123",
    "type": "task",
    "name": "My Task",
    "status": "open"
  }
}
```

---

## End-to-End Flow

### Scenario: Record Created via API

```
1. Client sends:  POST /api/v1/graph/compute_node-@local/fs-records/task

2. fs-records action handler (FsRecordsActionsMixin._fs_records_action):
   - record_list.create(body) writes a new Record folder to disk
   - Awaits rec.sync_to_db():
       * Entity.from_record(rec) -> lookup-or-create entity, save(notify=True)
         (this is where the entity create/update DataOp is emitted)
       * sync_from_entity mirrors DB state back to metadata.json
       * fts_upsert(FtsEntry(...)) from search_title/description/content
       * wiki.index(...) for wiki edges
       * TypeInfo.post_sync_fn(rec) if registered
   - Stamps scope from the resolved asset path (if entity was born scope=None)
   - Calls _broadcast_fs_record_op("create", "task", uid, rec.meta_dict())
       * notification-only: DataOpMessage(op=CREATE, to_entity=TypeId("task", uid))
       * handle_entity_op(data_op_msg) -> broadcast to watching connections

3. Frontend receives data_op_msg and updates its entity cache
```

### Scenario: Getting the Full Content of a Known Task

```python
entity = await Entity.get_one({"id": task_id})
record = await entity.get_record()   # FSRecord.load_or_none(type, id)
print(record.search_description)
```

No sync needed -- `entity.get_record()` loads the Record from disk by `(type, id)`.

---

## Query Trade-off Guide

| Question | Use |
|----------|-----|
| Find all tasks with status=open in project X | `Entity.get_all()` with `QueryFilter` -- SQLite indexed scan |
| Get the full content of one known task | `await entity.get_record()` -- loads Record from disk |
| Count entities by status across all projects | `Entity.get_all()` with filter -- SQLite aggregation |
| Search for records containing "authentication" | `Entity.search("authentication")` -- FTS5 MATCH |
| List one type, no query, recency-ordered | `Entity.browse(record_type)` -- FTS metadata, no MATCH |
| Find entities under a directory | `Entity.assets_by_path(opts)` -- `asset_ref` lex-range pushdown |
| Find entities modified in the last hour | `Entity.get_all()` with `updated_date` filter |
| Scan all records in a directory tree not yet indexed | `FSIndexer.index(...)` over the roots |
| Rebuild the full index after corruption | `SchemaRegistry.clear_index()` then `FSIndexer.index(...)` |
| Check if index is stale | `SchemaRegistry.get_index_status()` -- `stale` = source changed since last index |

---

## Key Files

| File | Relevant Contents |
|------|-------------------|
| `flow_sdk/core/entity/entity_model.py` | `Entity` base (no `record_data_ref`/`indexed_content`); `search()`, `browse()`, `assets_by_path()`; `from_record()`; `get_record()`, `destroy()`, `updateSearchIndex()`/`removeSearchIndex()`; `allocate_id()` |
| `flow_sdk/fs_store/fs_record.py` | `FSRecord` -- `async def sync_to_db()`, `sync_from_entity()`, `index_required`, `write_hash()`, `meta_dict()`, `search_*` readers |
| `flow_sdk/fs_store/schema_registry.py` | `SchemaRegistry`, `TypeInfo` -- type metadata, `clear_index()`, `get_index_status()`, `get_errors()`, index logging |
| `flow_sdk/fs_store/indexer/index_function.py` | `FSIndexer.index()` / `.scan()` -- scan/index orchestration |
| `flow_sdk/schema/types.py` | `EntityType` -- single consolidated type-name enum (was `RecordType` + `BuiltinEntityType`) |
| `flow_sdk/schema/type_info/` | per-type `TypeMetadata` (`<t>_type_info.py`) + `register_all()`; `post_sync_fn`, `meta_model`, `default_body_fn`, etc. |
| `flow_sdk/db/drivers/sqlite/sqlite_driver.py` | `FtsEntry`, `fts_upsert()`, `fts_delete()`, `fts_search()`, `browse_by_type()`; `entities_fts` schema |
| `flow_sdk/builtin/faas/fs_records_actions.py` | `FsRecordsActionsMixin._fs_records_action()`, `_broadcast_fs_record_op()` -- CRUD gateway + DataOp notify |
| `flow_sdk/core/network/resource_tracker.py` | `handle_entity_op()`, `_resolve_recipients()` |
| `flow_sdk/api/messages.py` | `DataOpMessage`, `WSMessageType`, `OperationType`, `EntityMessage` |
| `flow_sdk/app/actions/watch_registry.py` | `_watched_entities`, `add_watch()`, `get_watched_by()` |
| `flow_sdk/server/routes/search.py` | `GET /api/v1/search` |
| `flow_sdk/fs_store/operations/record_error.py` | `from_exception()` -- persisted indexing errors |
