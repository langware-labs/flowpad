---
id: a72f9f3e-ebb3-57b9-b3f2-3ece78268f87
---

# Record Search (FTS5/SQLite)

## 1. Overview

Search is SQLite FTS5. No external dependency, no vector embeddings. Records are indexed via `FSRecord.sync_to_db()` (explicit, async). Queries run via `Entity.search()` or `GET /api/v1/search`. Bulk (re)indexing is driven by the `FSIndexer` (`flow_sdk/fs_store/indexer/`) behind `POST /fs-records/index`.

---

## 2. Architecture

```
FSRecord.sync_to_db()                          # flow_sdk/fs_store/fs_record.py
    └─ Entity.from_record(self)                # create/update the Entity row
    └─ entry = FtsEntry(entity_id, entity_type,
                        name, title, description, content)
    └─ driver.fts_upsert(entry)                # single FtsEntry or list[FtsEntry]
           └─ DELETE FROM entities_fts WHERE entity_id IN (...)
           └─ INSERT INTO entities_fts
                  (entity_id, type, name, title, description, content)
    └─ wiki.index(...)                         # wiki-link edges
    └─ TypeInfo.post_sync_fn(self)             # type-specific hook

Entity.search(query, limit, record_type, status, calibration)
    └─ driver.fts_search(...)                  # flow_sdk/db/drivers/sqlite/sqlite_driver.py
           └─ SELECT e.*, bm25(...) AS _bm25_score, snippet(...) ...
              FROM entities e
              JOIN entities_fts fts ON e.id = fts.entity_id
              WHERE entities_fts MATCH :query
              [AND e.type = :record_type]
              [AND json_extract(e.data, '$.status') = :status]
              ORDER BY bm25(...) [+ recency/type adjustments], e.updated_date DESC
              LIMIT :limit
```

Each query term is prefix-expanded (`poin` → `poin*`); terms containing FTS5 special characters are double-quoted as phrases (`sqlite_driver.py:_fts_term`).

---

## 3. FTS5 Table

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    entity_id, type, name, title, description, content,
    tokenize='porter unicode61'
);
```

- **Stored in**: SQLite alongside the `entities` table
- **Populated by**: `fts_upsert()` from the `sync_to_db()` / indexer path only — no database triggers
- **Only indexed**: `FtsEntry`s where at least one of `name`/`title`/`description`/`content` is non-None (`FtsEntry.has_content`)
- **`porter unicode61`**: Porter stemmer for English (run/runs/running match) + Unicode-aware tokenization
- **Six columns** feed BM25 ranking with default weights `bm25(entities_fts, 0, 0, 10, 8, 3, 1)` — i.e. `entity_id`/`type` contribute nothing, `name` is weighted highest, then `title`, `description`, `content`. The schema was migrated from a 4-column (`entity_id, type, name, indexed_content`) layout; on open the driver drops and recreates the table if the stored DDL lacks `title` (`sqlite_driver.py:375`).

---

## 4. What gets indexed

### `search_*` readers (per-record)

`sync_to_db()` builds the `FtsEntry` from three default properties on `FSRecord` plus the `name` instance attr (`fs_record.py:460`):

```python
@property
def search_title(self) -> str:
    return self.__dict__.get("title") or self.__dict__.get("name") or ""

@property
def search_content(self) -> str:
    return self.__dict__.get("content") or self.__dict__.get("body") or ""

@property
def search_description(self) -> str:
    return self.__dict__.get("description") or ""
```

These read directly from instance attrs (`__dict__`) — there is no longer a `content` property on `Record` and no per-record parse at index time. Type-specific extractors (the `parser_fn`) are responsible for populating `title`/`description`/`content`/`body` on the instance during scan. A record with none of these set produces an `FtsEntry` with no content, and the FTS upsert is skipped (the Entity row is still written).

### Declare `index_fields` in `TypeInfo`

```python
# flow_sdk/schema/type_info/skill_type_info.py
SKILL_TYPE_INFO = TypeInfo(
    type_name="skill",
    browseable=True,
    index_fields=["description"],
    ...
)
```

`index_fields` is now a field on the per-type `TypeInfo` (`flow_sdk/schema/type_info/*_info.py`), **not** a `ClassVar` on a `Record` subclass. It is stored on the `SchemaRegistry` entry (`schema_registry.py:205`) and consumed by the indexer / agent-records route. Current declarations include: `subagent`/`skill`/`whiteboard` → `["description"]`, `workflow` → `["name","description"]`, `task` → `["description","objective"]`, `markdown` → `["title","tags","links"]`, `spec` → `["name","spec_type"]`, `claude_rules`/`claude_memory`/`plan` → `["name"]`.

---

## 5. Operations

### `await record.sync_to_db(fts_batch=None, notify=True)`

Creates or updates the Entity row, mirrors entity state back to `metadata.json`, upserts the FTS5 entry, re-extracts wiki edges, and runs the type's `post_sync_fn`. Async — must be awaited. The FTS upsert is skipped when the `FtsEntry` has no content (all of `name`/`title`/`description`/`content` empty); the Entity row is still created/updated. Pass `fts_batch` (a list) to defer FTS writes — the entry is appended instead of upserted immediately, so a bulk caller can flush one batched `fts_upsert(list)`.

### `Entity.search(query, limit=10, record_type=None, status=None, calibration=None)`

```python
entities = await Entity.search("authentication flow", limit=20, record_type="skill")
```

Returns a list of hydrated Entity objects, ranked by BM25 (plus optional recency/type calibration), each annotated with `_fts_snippet`/`_bm25_score`. `record_type` and `status` are optional filters applied inside the SQL. Empty `query` returns `[]` immediately.

### `driver.fts_delete(entity_id)`

Remove a record from the FTS index. Called explicitly when a record is deleted. Available on the SQLite driver via `get_db_driver().fts_delete(entity_id)`.

---

## 6. HTTP API

### Search

```
GET /api/v1/search?q=<query>&limit=<n>&offset=<n>&record_type=<type>&status=<status>&tags=<t1,t2>
```

Defined in `flow_sdk/server/routes/search.py`.

**Parameters (subset):**
- `q` — FTS5 query string. When empty or omitted, returns all entities of the given type (browse mode). Operator-y punctuation (`-`, `/`, `_`, `:`) is replaced with spaces before matching, so hyphenated names like `auth-flow` work.
- `limit` — max results per page (default 10)
- `offset` — pagination offset (default 0)
- `record_type` — filter by entity type (applied inside SQL)
- `status` — filter by status (applied inside SQL via `json_extract(e.data,'$.status')`)
- `tags` — comma-separated tag values; entities must have ALL listed tags (Python-side post-filter)
- `user` / `projects` — `ScopeFilter` (include user-scope records; restrict to project IDs)
- `parent_path` / `vault_root` — folder filters on `asset_ref`
- `include_system` — include SDK-shipped system-project entities (default off)
- Calibration knobs: `col_weights` (6 comma-separated BM25 weights), `recency_boost` (SQL-side additive per-day penalty), `recency_factor` (Python-side multiplicative decay), `overfetch`, `type_scores` (JSON object of type→score)

**Two modes:**
- **Browse mode** (`q` empty): builds a `QueryFilter(type=record_type or "entity")` (with an optional `status` match), calls `Entity.get_all()`, then applies scope/folder/system/tag filters and paginates with offset/limit. `total` is the post-filter count before pagination.
- **FTS mode** (`q` non-empty): runs `Entity.search(query, limit=limit+offset, record_type, status, calibration)`, then applies scope/folder/system/tag post-filters, sets `total` to the post-filter count, and slices `[offset:offset+limit]`. On exception (index not ready) it returns empty results with `"indexer_ready": false`.

> **Pagination caveat (in code comment, `search.py:176`)**: FTS mode fetches only `limit + offset` rows, so if the Python-side scope/folder/tag filters drop more than `offset` rows, page 2+ may be short. `record_type` and `status`, by contrast, are pushed into the SQL and are not affected.

Response:
```json
{
  "status": "SUCCESS",
  "data": {
    "results": [
      {
        "record_id": "abc123",
        "record_type": "skill",
        "name": "auth-flow",
        "snippet": "OAuth2 <mark>authentication</mark> flow …",
        "status": "active",
        "scope": "",
        "project_id": null,
        "asset_ref": "",
        "created_at": "2026-03-01T10:00:00",
        "modified_at": "2026-03-09T14:00:00"
      }
    ],
    "query": "authentication flow",
    "total": 1,
    "indexer_ready": true
  }
}
```

### Asset Types

```
GET /api/v1/assets/types
```

Returns all record types with `browseable=True` in their `TypeInfo`, plus a hardcoded `project` entry at the top (`flow_sdk/server/routes/assets.py:86`). The `markdown` entry additionally carries a `vaults` list. Each entry has `type_name`, `label` (derived as `type_name.replace("_"," ").title()`), `icon`, and `creatable`.

```json
{
  "status": "SUCCESS",
  "data": {
    "types": [
      {"type_name": "project", "label": "Projects", "icon": null, "creatable": false},
      {"type_name": "skill", "label": "Skill", "icon": null, "creatable": true},
      {"type_name": "markdown", "label": "Markdown", "icon": null, "creatable": true, "vaults": []}
    ]
  }
}
```

To surface a Record type in the user-facing browser, set `browseable=True` on its `TypeInfo` (in `flow_sdk/schema/type_info/<type>_info.py`) — there is no `_browseable` ClassVar on the Record class. Currently set on the `TypeInfo` for: `skill`, `subagent`, `workflow`, `markdown`, `spec`, `claude_rules`, `claude_memory`, `plan`, `whiteboard`. Note: this flag is about UI visibility — it does **not** mean the record is an agent-consumable asset (see `main_subdir` in `TypeInfo` for that).

### Reindex (FaaS index endpoint)

```
POST /fs-records/index                       → index all registered types
POST /fs-records/index?type=X                → index one type
POST /fs-records/index?rebuild=true          → clear + re-index
POST /fs-records/index?user=&projects=A,B    → narrow to a ScopeFilter
```

Handled by `_handle_fs_records_index` in `flow_sdk/builtin/faas/fs_records_actions.py:772`, backed by the shared `FSIndexer` (`flow_sdk/fs_store/indexer/`). The indexer scans records from disk, calls `sync_to_db()` (batching `FtsEntry`s), and emits `progress_report` FlowData events per type. The set of indexable types is `INDEXABLE_TYPES` from the indexer package; it is registry-driven, not hardcoded per call. There is no `POST /api/v1/search/reindex` route.

### Index status / clear

```
GET    /fs-records/index-status[?user=&projects=]
DELETE /fs-records/index
```

`index-status` is read-only (reports per-type counts/staleness). `DELETE` clears the index.

---

## 7. When indexing happens

`sync_to_db()` is called explicitly and runs inline (within the async call chain) — there is no `IndexWorker` thread, debounce queue, or background daemon. Index calls happen in:
- The CRUD handlers in `fs_records_actions.py` — `sync_to_db()` is awaited directly on create/update of a record (e.g. `fs_records_actions.py:1284`, `:1322`), *before* the `_broadcast_fs_record_op(...)` notification.
- The bulk `FSIndexer` invoked by `POST /fs-records/index` (and on discover, `fs_records_actions.py:1115`), which batches `FtsEntry`s for one `fts_upsert(list)`.
- FlowMessage body unpack for shared file-backed entities. In normal copy mode,
  the unpacker first writes the copied asset into the mapped project, then indexes
  that path. In git transfer mode, the unpacker resolves or clones the `GitOrigin`
  checkout and indexes the real checkout path directly. A markdown document shared
  this way becomes searchable only after that receive/open/index step has run.
- Explicit application code.

> **Important — webhook entities are NOT FTS-indexed**: Entities created via the listen webhook (`POST /api/v1/webhook/listen` / `_reflect_entity` in `flow_sdk/app/actions/listen.py`) use `entity.save(scope)` directly and do **not** call `sync_to_db()` or `fts_upsert()`. These entities will not appear in FTS search results until a (re)index via `POST /fs-records/index`. Only entities created through the `sync_to_db()` / indexer path get FTS entries automatically.

This keeps the architecture simple and predictable at current scale.

---

## 8. Performance

FTS5 MATCH at 100K records: typically 0.07–0.40ms. SQLite FTS5 is competitive with dedicated search backends for datasets under a few million records.

For comparison: an unindexed filesystem scan of 100K records to find ones matching a string pattern takes seconds.

---

## 9. How a type feeds the index

A type contributes to search in two coordinated places:

1. **Its `parser_fn` populates `title`/`description`/`content`/`body` on the record instance** during scan. The base `search_title` / `search_description` / `search_content` readers (section 4) then surface those attrs into the `FtsEntry`. A type that never sets any of them produces a no-content entry and is effectively unsearchable by text.

2. **Its `TypeInfo` declares `index_fields`** (in `flow_sdk/schema/type_info/<type>_info.py`):

```python
# skill_type_info.py
SKILL_TYPE_INFO = TypeInfo(type_name="skill", browseable=True, index_fields=["description"], ...)

# agent_type_info.py
AGENT_TYPE_INFO = TypeInfo(type_name="agent", browseable=True, index_fields=["description"], ...)

# task_type_info.py
TASK_TYPE_INFO = TypeInfo(type_name="task", index_fields=["description", "objective"], ...)

# markdown_type_info.py
MARKDOWN_TYPE_INFO = TypeInfo(type_name="markdown", browseable=True, index_fields=["title", "tags", "links"], ...)
```

These are registered on the `SchemaRegistry` entry and consumed by the indexer / agent-records route — they are not a `ClassVar` on the `Record` subclass, and there is no `content` property to override.

---

## 10. Testing

FTS5 operations are driver-level methods. `fts_upsert` takes one `FtsEntry` (or a list); test them directly:

```python
from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry

@pytest.mark.asyncio
async def test_fts_upsert_and_search(db_driver):
    await db_driver.fts_upsert(FtsEntry(
        entity_id="abc123",
        entity_type="skill",
        name="auth-flow",
        description="OAuth2 authentication flow with PKCE",
    ))
    results = await db_driver.fts_search("authentication", limit=5)
    assert any(e.id == "abc123" for e in results)
```

See `tests/api/test_fts5_search.py`, `tests/unit/test_fts_columns.py`, and `tests/unit/test_fts_calibration.py` for the full suites.

For end-to-end testing via `FSRecord.sync_to_db()`, build a record whose `parser_fn` sets `title`/`description`/`content`, then call `await record.sync_to_db()` and `await Entity.search(...)`.
