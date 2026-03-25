# Entity Index Sync

## Naming Clarification

There are three distinct "index" concepts in the codebase:

| Name | Location | Purpose |
|------|----------|---------|
| **RecordState** (`state.json`) | `flow_sdk/fs_store/record_state.py` | Per-record property cache (TTL-based PropertyRecord values). See [fs_store.md](../fs_store.md#recordindex-per-record-property-cache). |
| **Entity Index** (SQLite) | `flow_sdk/core/entity/entity_model.py` | Queryable database of record metadata. **This document.** |
| **FTS5 Index** (`entities_fts`) | `flow_sdk/db/drivers/sqlite/sqlite_driver.py` | Full-text search virtual table, populated alongside Entity Index. |

RecordState and Entity Index are completely unrelated systems that share the word "index".

---

## Conceptual Model

DB Entities are SQLite-backed queryable indexes. The filesystem Record is the source of truth for domain data. These two layers are linked but deliberately kept separate: the Entity stores only a small, indexed subset of Record metadata, while the Record holds the full domain content.

```
Record (filesystem, source of truth)
    |
    |  record_data_ref  <-- "type/id" string stored in Entity DB row
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
- You need data that was never mirrored to the Entity (only `name`, `status`, and `content` are indexed)
- You are doing a one-off traversal of a known directory tree
- You need data that has not been indexed yet

The Entity layer answers "which ones" and "how many"; the Record layer answers "what is in this one".

---

## record_data_ref Field

Defined in `flow_sdk/core/entity/entity_model.py` on the `Entity` base class.

```python
# "type/id" string linking Entity to a filesystem Record.
# Example: "task/abc123", "agent/df9e12c4"
record_data_ref: str | None = APIField(default=None, description="Record reference as type/id")

# Full-text searchable content from Record.content.
# NOT an APIField -- excluded from API responses by design.
indexed_content: str | None = Field(default=None)
```

### record_data_ref Format

The value is a simple `"type/id"` string:

```
task/abc123
agent/df9e12c4
skill/a3b7f91c2e1d
```

- **type**: The record type string (same as `_record_type` on the `Record` subclass)
- **id**: The record UUID

`Entity.record` parses this string to load the Record from disk:

```python
@property
def record(self):
    if not self.record_data_ref:
        return None
    record_type, uid = self.record_data_ref.split("/", 1)
    cls = fs_type_registry.get(record_type) or Record
    return cls.discover_one(uid)
```

---

## `Record.sync_to_db()` Implementation

```python
async def index(self) -> None:
```

Defined in `flow_sdk/fs_store/record.py`. **The ONLY way to get a Record into the Entity DB with full FTS indexing.**

### Step-by-Step Algorithm

1. **Delegate to `Entity.from_record(self)`.** This encapsulates entity lookup-or-create, field copying (id, name, status, record_data_ref), and persistence. Returns the saved Entity.

2. **Write hash file.** `self.write_hash_file(self.compute_record_hash())` — stores a content hash so future reads can detect whether the record has changed since last indexing.

3. **FTS5 upsert.** If `self.content is not None`:
   ```python
   await driver.fts_upsert(
       entity_id=entity.id,
       entity_type=entity.type,
       name=self.name or None,
       indexed_content=self.content,
   )
   ```

4. **Error handling.** On any exception, creates a `RecordError` via `RecordError.from_exception(self, exc, trigger="index")` and saves it to disk before re-raising. This allows callers to count/log indexing failures without losing error details.

### `Record.deindex()` Implementation

```python
async def deindex(self) -> None:
```

Removes the corresponding Entity from SQLite by looking up and deleting by `record_data_ref = "type/id"`.

### When index() Is Called

| Trigger | Location | Notes |
|---------|----------|-------|
| Record CRUD via ComputeNode API | `compute_node._broadcast_fs_record_op()` | Called after every POST/PUT/DELETE |
| SchemaRegistry full sync | `SchemaRegistry.discover()` / `.sync()` | Scan + index for given/default types |
| SchemaRegistry type index | `SchemaRegistry.index_type()` | Indexes all records of one type |
| SchemaRegistry rebuild | `SchemaRegistry.rebuild_index()` / `.rebuild()` | Clears then re-indexes |
| SchemaRegistry incremental | `SchemaRegistry.incremental()` / `.sync_incremental()` | Skip recently indexed types |
| Explicit application code | anywhere | `await record.sync_to_db()` |
| `Entity.get_all()` / `get_one()` | (none) | NOT triggered -- performance |

`get_all()` and `get_one()` do not call `index()`. Running index on every list query would cause O(N) filesystem reads per list request.

### Entities NOT indexed via Record.sync_to_db()

Entities created via `_reflect_entity()` (the listen webhook path) do NOT get FTS-indexed. Only the `Record.sync_to_db()` path performs full indexing (Entity row + FTS5 upsert). The listen/reflect path creates Entity rows directly in SQLite without FTS entries.

---

## SchemaRegistry Orchestration

`SchemaRegistry` (`flow_sdk/fs_store/schema_registry.py`) provides high-level scan/index orchestration methods that build on `Record.sync_to_db()`:

### Key Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `discover()` / `sync()` | `async (types, trigger, limit_per_type, actions)` | Full scan+index for given or default types |
| `index_type()` | `async (type_or_cls, limit, clear_first)` | Index all records of one type |
| `incremental()` / `sync_incremental()` | `async (request: IndexRequest)` | Skip types not needing re-index |
| `rebuild_index()` / `rebuild()` | `async (types, trigger)` | Clear index then re-index |
| `clear_index()` / `clear()` | `async (types)` | Delete Entity rows + FTS entries + log files |
| `get_index_status()` / `get_status()` | `(types)` | Check staleness (>24h since last index) |
| `get_errors()` | `(type_name)` | List RecordErrors from failed indexing |

### Default Indexed Types

`SchemaRegistry.get_default_index_types()` returns types with `indexed_by_default=True` in their TypeInfo, falling back to a hardcoded list: skill, memo, agent, task, agentic_process.

### Logging

All scan/index operations are logged to JSONL files:
- Global: `~/.flow/schema/scan_log.jsonl`, `~/.flow/schema/index_log.jsonl`
- Per-type: `~/.flow/schema/types/<type>/scan_log.jsonl`, `~/.flow/schema/types/<type>/index_log.jsonl`

Each log file is trimmed to 100 entries max.

---

## FTS5 Integration

### `entities_fts` Virtual Table Schema

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    entity_id,
    type,
    name,
    indexed_content,
    tokenize='porter unicode61'
);
```

- Populated by `fts_upsert()` -- no database triggers
- `porter` stemmer for English-language search (run -> runs -> running)
- `unicode61` tokenizer for Unicode text

### Driver Methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `fts_upsert` | `(entity_id, entity_type, name, indexed_content)` | Delete + insert (full replace). Called by `Record.sync_to_db()`. |
| `fts_delete` | `(entity_id)` | Remove a row from FTS table. Called on record deletion. |
| `fts_search` | `(query, limit, record_type)` | FTS5 MATCH, joins `entities_fts` to `entities` table. Returns hydrated Entity objects. |

All three are methods on the SQLite driver class (`flow_sdk/db/drivers/sqlite/sqlite_driver.py`).

---

## ComputeNode CRUD

`_broadcast_fs_record_op()` in `flow_sdk/builtin/faas/compute_node.py` is called after every fs-record write:

```
POST   -> _broadcast_fs_record_op("create", record_type, id, body)
PUT    -> _broadcast_fs_record_op("update", record_type, uid, rec.to_dict())
DELETE -> _broadcast_fs_record_op("delete", record_type, uid)
```

The method does two things in sequence:

1. **Broadcast DataOpMessage** -- constructs `DataOpMessage(op=..., to_entity=..., data=...)` and calls `handle_entity_op()` for WebSocket delivery to all watching frontend connections.

2. **Call `rec.sync_to_db()`** -- constructs a lightweight Record instance from the CRUD data and awaits `rec.sync_to_db()`. This updates (or creates) the Entity row and FTS5 entry. No disk read needed because the data is already in memory from the CRUD operation.

For `delete` operations, the record is already gone from disk. The Entity row may be removed by `Record.deindex()` or cleaned up during a rebuild.

---

## DataOpMessage Structure

```python
class DataOpMessage(EntityMessage):
    message_type: str = "data_op_msg"
    op: OperationType   # "create" | "update" | "delete"
    data: Any = None
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

2. ComputeNode action handler:
   - Writes new Record to disk (metadata.json + _data.json)
   - Calls _broadcast_fs_record_op("create", "task", uid, rec.to_dict())

3. _broadcast_fs_record_op():
   a. Constructs DataOpMessage(op=CREATE, to_entity=TypeId("task", uid), data={...})
   b. Calls handle_entity_op(data_op_msg)
      - Resolves recipients; broadcasts to all connections (create = always broadcast)
   c. Constructs rec = TaskResource(id=uid, **data)
   d. Awaits rec.sync_to_db()
      - Delegates to Entity.from_record(rec) (lookup-or-create + save)
      - Writes hash file for change detection
      - Calls fts_upsert() if content is not None

4. Frontend receives data_op_msg and updates its entity cache
```

### Scenario: Getting the Full Content of a Known Task

```python
entity = await Entity.get_one({"id": task_id})
record = entity.record   # lazy-loads TaskResource from disk via discover_one()
print(record.description)
```

No sync needed -- `entity.record` calls `cls.discover_one(uid)` directly.

---

## Query Trade-off Guide

| Question | Use |
|----------|-----|
| Find all tasks with status=open in project X | `Entity.get_all()` with `QueryFilter` -- SQLite indexed scan |
| Get the full content of one known task | `entity.record` property -- loads Record from disk |
| Count entities by status across all projects | `Entity.get_all()` with filter -- SQLite aggregation |
| Search for records containing "authentication" | `Entity.search("authentication")` -- FTS5 MATCH |
| Find entities modified in the last hour | `Entity.get_all()` with `updated_date` filter |
| Scan all records in a directory tree not yet indexed | Filesystem walk -- call `record.sync_to_db()` on each |
| Rebuild the full index after corruption | `SchemaRegistry.rebuild_index()` -- clears + re-indexes |
| Check if index is stale | `SchemaRegistry.get_index_status()` -- checks >24h threshold |

---

## Key Files

| File | Relevant Contents |
|------|-------------------|
| `flow_sdk/core/entity/entity_model.py` | `record_data_ref`, `indexed_content` fields; `record` property; `search()` classmethod; `from_record()` |
| `flow_sdk/fs_store/record.py` | `async def index()`, `async def deindex()` -- algorithms described above |
| `flow_sdk/fs_store/schema_registry.py` | `SchemaRegistry` -- scan/index orchestration, rebuild, clear, status |
| `flow_sdk/db/drivers/sqlite/sqlite_driver.py` | `fts_upsert()`, `fts_delete()`, `fts_search()` |
| `flow_sdk/builtin/faas/compute_node.py` | `_broadcast_fs_record_op()` -- CRUD trigger for index() |
| `flow_sdk/core/network/resource_tracker.py` | `handle_entity_op()`, `_resolve_recipients()` |
| `flow_sdk/api/messages.py` | `DataOpMessage`, `WSMessageType`, `OperationType` |
| `flow_sdk/app/actions/watch_registry.py` | `_watched_entities`, `add_watch()`, `get_watched_by()` |
| `flow_sdk/server/routes/search.py` | `GET /api/v1/search`, `POST /api/v1/search/reindex` |
| `flow_sdk/fs_records/record_error.py` | `RecordError.from_exception()` -- persisted indexing errors |
