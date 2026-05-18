---
id: 5ad0c9ea-7928-576f-a849-2381689d7e0a
---

# Record-Entity Linkage (`record_data_ref`)

## Overview

Records (fs_store) are the source of truth for user-created data on the local filesystem. Entities (DB) are the graph/index layer that enables queries, relationships, and full-text search. The `record_data_ref` field on Entity links these two systems as a simple `"type/id"` string. `Record.sync_to_db()` is the ONLY way to get a Record into the Entity DB.

## Architecture

```
Record (filesystem, source of truth)
    |
    |  Record.sync_to_db()  -- explicit, async, called after CRUD
    v
Entity (SQLite, queryable index)    entities_fts (FTS5 table)
    |
    |  DataOpMessage -- WebSocket notification to frontend
    v
Frontend (reactive UI)
```

## Fields

### `Entity.record_data_ref` (str | None)

Optional reference to the source Record.

- **Format**: `"type/id"` (e.g. `"task/abc123"`)
- **Default**: `None` (no record linkage — pure DB entity)
- **Stored in DB**: Yes (APIField)
- **API visible**: Yes

### `Entity.indexed_content` (str | None)

Full-text searchable content copied from `Record.content`. Populated by `Record.sync_to_db()`.

- **Default**: `None`
- **Stored in DB**: Yes (Field, NOT APIField)
- **API visible**: No — excluded from API responses by design

### `Entity.record` Property

Lazy-loads the typed Record from disk using `record_data_ref`.

```python
@property
def record(self):
    if not self.record_data_ref:
        return None
    record_type, uid = self.record_data_ref.split("/", 1)
    cls = fs_type_registry.get(record_type) or Record
    return cls.discover_one(uid)
```

Returns `None` if `record_data_ref` is not set. Uses `SchemaRegistry.get_record_cls()` (via the `fs_type_registry` shim) to instantiate the correct subclass.

### `Entity.name` and `Entity.status`

Display name and lifecycle status. Copied from the Record during `index()` if the Record has them. Many subclasses (ComputeNode, Workspace, etc.) override these with required `str` fields.

## `Record.sync_to_db()` Method

```python
async def index(self) -> None:
```

Creates or updates the corresponding Entity in SQLite. **This is the ONLY way to get a Record into the Entity DB.**

**Algorithm:**

1. Skip if `_read_only` is True → return immediately
2. Look up typed Entity subclass via `SchemaRegistry.get_entity_cls()` (falls back to base `Entity`)
3. `await entity_cls.get_one({"id": self.id})` — load existing or create new
4. Set `entity.record_data_ref = f"{record_type}/{self.id}"`
5. Copy `name` and `status` from Record to Entity if present
6. If `self.content is not None`: set `entity.indexed_content = self.content`
7. `await entity.save()`
8. If `self.content is not None`: `await driver.fts_upsert(entity_id, type, name, indexed_content)`

No-op for `_read_only` records (Claude Code config records, transcript entries, etc.).

## `Entity.search()` Classmethod

```python
@classmethod
async def search(cls, query: str, limit: int = 10, record_type: str | None = None) -> list[Entity]:
```

Delegates to `driver.fts_search()`, which runs an FTS5 `MATCH` query against `entities_fts` joined to `entities`. Returns a list of hydrated Entity objects.

## No Auto-Sync

`Entity.get_all()` and `get_one()` do NOT auto-refresh from Records. Sync happens only when `Record.sync_to_db()` is called — typically from:

- `ComputeNode._broadcast_fs_record_op()` after every fs-record POST/PUT/DELETE
- Server startup reindex (`POST /api/v1/search/reindex`)
- Explicit application code calling `await record.sync_to_db()`

## DataOpMessage

When a Record is created, updated, or deleted via the ComputeNode API, `_broadcast_fs_record_op()` constructs a `DataOpMessage` and dispatches it via `handle_entity_op()` for WebSocket delivery to connected frontends.

```python
class DataOpMessage(EntityMessage):
    message_type: str = "data_op_msg"
    op: OperationType   # "create" | "update" | "delete"
    data: Any = None
```

Wire format:

```json
{
  "message_type": "data_op_msg",
  "message_id": "a1b2c3...",
  "instance_id": 42,
  "to_entity": "task-abc123",
  "op": "update",
  "data": {"id": "abc123", "type": "task", "name": "My Task", ...}
}
```

## WebSocket Delivery

`_resolve_recipients()` in `resource_tracker.py` determines which WebSocket connections receive each message:

| Scenario | Recipients |
|----------|-----------|
| `op == "create"` | All active connections (broadcast) |
| `op == "update"` or `"delete"`, explicit watchers found | Only the connections watching that entity |
| `op == "update"`, no explicit watchers | All active connections (webhook fallback) |
| `op == "delete"`, no explicit watchers | Empty set |

For `delete` operations, a `flow_data_msg` (entity deletion notification) is prepended before the `data_op_msg`.

## Key Files

| File | Purpose |
|------|---------|
| `flow_sdk/core/entity/entity_model.py` | `record_data_ref`, `indexed_content` fields; `record` property; `search()` classmethod |
| `flow_sdk/fs_store/record.py` | `async def index()` — the ONLY way to index a Record |
| `flow_sdk/db/drivers/sqlite/sqlite_driver.py` | `fts_upsert()`, `fts_delete()`, `fts_search()` |
| `flow_sdk/builtin/faas/compute_node.py` | `_broadcast_fs_record_op()` — calls `rec.sync_to_db()` after CRUD |
| `flow_sdk/core/network/resource_tracker.py` | `handle_entity_op()`, `_resolve_recipients()` |
| `flow_sdk/api/messages.py` | `DataOpMessage`, `WSMessageType`, `OperationType` |
| `server/routes/search.py` | `GET /api/v1/search`, `POST /api/v1/search/reindex` |
| `tests/unit/test_entity_record_sync.py` | Unit tests for `index()` and `record` property |
| `tests/api/test_entity_record_sync.py` | API integration tests |
