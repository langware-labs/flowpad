# Record Search (FTS5/SQLite)

## 1. Overview

Search is SQLite FTS5. No external dependency, no background worker, no vector embeddings. Records are indexed via `Record.sync_to_db()` (explicit, async). Queries run via `Entity.search()` or `GET /api/v1/search`.

---

## 2. Architecture

```
Record.sync_to_db()
    └─ entity.indexed_content = self.content
    └─ driver.fts_upsert(entity_id, type, name, indexed_content)
           └─ DELETE FROM entities_fts WHERE entity_id = :id
           └─ INSERT INTO entities_fts (entity_id, type, name, indexed_content)

Entity.search(query, limit, record_type)
    └─ driver.fts_search(query)
           └─ SELECT e.* FROM entities e
              JOIN entities_fts fts ON e.id = fts.entity_id
              WHERE entities_fts MATCH :query
              [AND fts.type = :record_type]
              LIMIT :limit
```

---

## 3. FTS5 Table

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    entity_id,
    type,
    name,
    indexed_content,
    tokenize='porter unicode61'
);
```

- **Stored in**: SQLite alongside the `entities` table
- **Populated by**: `Record.sync_to_db()` calls only — no database triggers
- **Only indexed**: Records whose `content` property returns a non-None string
- **`porter unicode61`**: Porter stemmer for English (run/runs/running match) + Unicode-aware tokenization

---

## 4. Opt-in API

### Override `content`

```python
class MemoRecord(Record):
    @property
    def content(self) -> str | None:
        parts = []
        if self.name:
            parts.append(self.name)
        body = (self._data or {}).get("body")
        if body:
            parts.append(body)
        return "\n".join(parts) if parts else None
```

Return `None` (the base `Record` default) to skip indexing entirely.

### Declare `index_fields`

```python
class MemoRecord(Record):
    index_fields: ClassVar[list[str]] = ["tags", "summary"]
```

Values of listed `_data` fields are concatenated into `content` after the main content. They are not stored as separate filterable columns — use them only to improve search quality.

---

## 5. Operations

### `await record.sync_to_db()`

Creates or updates the Entity row and FTS5 entry. Async — must be awaited. No-op when `content is None` (FTS upsert is skipped) or when `_read_only` is True. The Entity row is still created/updated even if content is None.

### `Entity.search(query, limit, record_type)`

```python
entities = await Entity.search("authentication flow", limit=20, record_type="skill")
```

Returns a list of hydrated Entity objects. `record_type` is an optional filter. Empty `query` returns `[]` immediately.

### `driver.fts_delete(entity_id)`

Remove a record from the FTS index. Called explicitly when a record is deleted. Available on the SQLite driver via `get_db_driver().fts_delete(entity_id)`.

---

## 6. HTTP API

### Search

```
GET /api/v1/search?q=<query>&limit=<n>&offset=<n>&record_type=<type>&status=<status>&tags=<tag1,tag2>
```

**Parameters:**
- `q` — FTS5 query string. When empty or omitted, returns all entities of the given type (browse mode).
- `limit` — max results per page (default 10)
- `offset` — pagination offset (default 0)
- `record_type` — filter by entity type (e.g. `skill`, `agent`, `asset`)
- `status` — post-filter by status field
- `tags` — comma-separated tag values; entities must have ALL listed tags (post-filter)

**Two modes:**
- **Browse mode** (`q` empty): calls `Entity.get_all()` with type filter, then paginates with offset/limit. Always returns `total` count. Used by the asset list view when no search term is entered.
- **FTS mode** (`q` ≥ 2 chars): runs FTS5 MATCH query, applies offset slice, returns results. `total` reflects results after offset (not the full match count).

> **Limitation — `status` post-filter**: The `status` parameter is applied as a Python-side post-filter *after* the FTS5 `MATCH` query and `LIMIT` have already been applied. This means the endpoint may return fewer results than `limit` if matching records have a different status. The `record_type` filter, by contrast, is applied inside the SQL query and does not have this issue.

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
        "status": "active",
        "scope": "",
        "source_path": "",
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

Returns all record types with `browseable=True` in their `TypeInfo`, plus a hardcoded `project` entry at the top. Consumed by the `BrowseableTree` component (fed by the `assetTypeRoot` adapter at `ui/src/components/browseable-tree/adapters/assetTypeRoot.tsx`) to render the type list in the Assets surface.

```json
{
  "status": "SUCCESS",
  "data": {
    "types": [
      {"type_name": "project", "label": "Projects", "icon": null},
      {"type_name": "asset", "label": "Asset", "icon": null},
      {"type_name": "skill", "label": "Skill Record", "icon": null}
    ]
  }
}
```

To surface a Record type in the user-facing browser, set `_browseable: ClassVar[bool] = True` on the class. Currently set on: `SkillRecord`, `AgentRecord`, `WorkflowRecord`, `MarkdownRecord`, `SpecRecord`, `TaskRecord`, `AppSecretRecord`, `CommentRecord`, `BookmarkRecord`, `AnnotationRecord`, `ClaudeRulesRecord`, `ClaudeMemoryRecord`, `ClaudeMdFsRecord`, `ClaudePlanRecord`. Note: this flag is about UI visibility — it does **not** mean the record is an agent-consumable asset (see `_main_subdir` for that).

### Reindex (all indexable types)

```
POST /api/v1/search/reindex
```

Discovers all indexable record types dynamically via `SchemaRecord.discover(trigger="reindex")` and calls `record.sync_to_db()` on each. Returns `{"indexed": N}`. The set of indexable types is not hardcoded — any `Record` subclass whose `content` property returns a non-None string will be discovered and indexed.

### Reindex (single type)

```
POST /api/v1/search/reindex/{record_type}
```

Reindexes all records of the given type. Returns 404 if the type is not registered.

---

## 7. Inline Indexing (No Background Worker)

`record.sync_to_db()` is called explicitly and runs inline (synchronously within the async call chain) — there is no `IndexWorker` thread, no debounce queue, and no background daemon. Index calls happen in three places:
- In `_broadcast_fs_record_op()` after a CRUD operation completes
- In the reindex endpoints
- In explicit application code

> **Important — webhook entities are NOT FTS-indexed**: Entities created via the listen webhook (`POST /api/v1/webhook/listen` / `_reflect_entity`) use `entity.save()` directly and do **not** call `Record.sync_to_db()` or `fts_upsert()`. These entities will not appear in FTS search results until a manual reindex via `POST /api/v1/search/reindex`. Only entities created through the `Record.sync_to_db()` path (fs_store layer) get FTS entries automatically.

This keeps the architecture simple and predictable at current scale.

---

## 8. Performance

FTS5 MATCH at 100K records: typically 0.07–0.40ms. SQLite FTS5 is competitive with dedicated search backends for datasets under a few million records.

For comparison: an unindexed filesystem scan of 100K records to find ones matching a string pattern takes seconds.

---

## 9. Subclass Examples

```python
# MemoRecord — name + body
class MemoRecord(Record):
    index_fields = ["tags", "summary"]

    @property
    def content(self) -> str | None:
        parts = [self.name] if self.name else []
        body = (self._data or {}).get("body")
        if body:
            parts.append(body)
        return "\n".join(parts) or None


# AgentRecord — name + description + prompt
class AgentRecord(Record):
    index_fields = ["description"]

    @property
    def content(self) -> str | None:
        parts = [self.name] if self.name else []
        desc = (self._data or {}).get("description")
        if desc:
            parts.append(desc)
        p = self.prompt
        if p:
            parts.append(p)
        return "\n".join(parts) or None


# SkillRecord — name + description
class SkillRecord(Record):
    index_fields = ["description"]

    @property
    def content(self) -> str | None:
        parts = [self.name] if self.name else []
        desc = (self._data or {}).get("description") or self.yaml_fields.get("description")
        if desc:
            parts.append(desc)
        return "\n".join(parts) or None
```

---

## 10. Testing

FTS5 operations are driver-level methods. Test them directly:

```python
@pytest.mark.asyncio
async def test_fts_upsert_and_search(db_driver):
    await db_driver.fts_upsert(
        entity_id="abc123",
        entity_type="skill",
        name="auth-flow",
        indexed_content="OAuth2 authentication flow with PKCE",
    )
    results = await db_driver.fts_search("authentication", limit=5)
    assert any(e.id == "abc123" for e in results)
```

See `tests/unit/test_fts5_search.py` for the full test suite.

For end-to-end testing via `Record.sync_to_db()`, use any Record subclass that overrides `content` and call `await record.sync_to_db()` then `await Entity.search(...)`.
