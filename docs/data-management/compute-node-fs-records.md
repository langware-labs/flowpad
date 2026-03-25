# ComputeNode `fs-records` Action

This document describes the `fs-records` action registered on the `ComputeNode` entity. It is a unified CRUD gateway for filesystem-backed typed records, providing both type-based routing (by registered record type name) and path-based routing (by source file path on disk).

---

## fs-records vs the Entity / Graph API

These are two complementary systems, not alternatives:

| | fs-records | Entity / graph API |
|---|---|---|
| **Storage** | JSON files on disk (`Record` layer) | SQLite rows (`Entity` layer) |
| **Content** | Full record payload — all domain fields | Metadata subset only (`_ENTITY_META_FIELDS`) |
| **Query** | O(N) filesystem scan + optional filter | Indexed SQL queries, FTS5 full-text search |
| **Requires DB** | No | Yes |
| **Who creates it** | `record_list.create/update` | `rec.sync_to_db()` → `Entity.from_record()` |
| **Who reads it** | Frontend direct, MCP `flow_entity_crud` | Frontend graph queries, search |

**Rule of thumb:** use fs-records when you need the full record on disk. Use the Entity API when you need fast filtered queries or full-text search.

**Write path — Record is primary, Entity is cache:**

```
POST /fs-records/{type}
  → record_list.create(body)     # write Record to disk
  → rec.sync_to_db()             # update Entity + FTS cache from the real saved record
  → _broadcast_fs_record_op()    # WebSocket notification to frontend
```

`_broadcast_fs_record_op` is notification-only — it sends a `DataOpMessage` to WebSocket clients. Entity/FTS sync always happens via `rec.sync_to_db()` on the real saved record before the broadcast, never inside the broadcast itself.

**Source files:**

- `flow_sdk/builtin/faas/compute_node.py` — action handler, `_parse_record_query`, `_embed_includes`, `_handle_path_based_source_file`, `_broadcast_fs_record_op`
- `flow_sdk/fs_store/record_query.py` — `RecordQuery` dataclass
- `flow_sdk/fs_store/source_file_registry.py` — `register_file_pattern`, `resolve_list_class`, `is_allowed_source_path`
- `flow_sdk/fs_store/record_list.py` — `RecordList` storage-agnostic collection
- `flow_sdk/fs_store/source_file_record_list.py` — `SourceFileRecordList` for embedded JSON files
- `flow_sdk/fs_store/factory/type_registry.py` — backward-compat shim (delegates to `SchemaRegistry`)

---

## Action Registration

The action is registered using the `@action.all` decorator on the `ComputeNode` class method:

```python
@action.all(action_name="fs-records", methods=["get", "post", "put", "delete"])
async def fs_records_action(self) -> ApiResponse:
    ...
```

The decorator registers `fs-records` as a named action callable on any `ComputeNode` entity instance. The `methods` argument restricts it to GET, POST, PUT, and DELETE HTTP verbs. The handler is located at:

```
/api/v1/graph/compute_node/{node_id}/fs-records[/{sub_path}]
```

All URL segments that follow `fs-records` are captured as `request_info.sub_path` and split into `segments` inside the handler.

---

## URL Structure

The complete URL pattern for all operations is:

```
{HTTP_METHOD} /api/v1/graph/compute_node/{node_id}/fs-records[/{type}[/{uid}]]
```

For path-based source file operations, the literal segment `file` replaces `{type}`:

```
{HTTP_METHOD} /api/v1/graph/compute_node/{node_id}/fs-records/file?path=...
```

### Full Routing Table

| HTTP Method | URL Pattern | Handler Behavior |
|-------------|-------------|-----------------|
| `GET` | `/fs-records` | List all registered type names |
| `GET` | `/fs-records/{type}` | List all records of `{type}` |
| `GET` | `/fs-records/{type}/{uid}` | Get a single record by uid |
| `POST` | `/fs-records/{type}` | Create a new record of `{type}` |
| `PUT` | `/fs-records/{type}/{uid}` | Update an existing record by uid |
| `DELETE` | `/fs-records/{type}/{uid}` | Delete a record by uid |
| `GET` | `/fs-records/file?path=...` | List all records from a source file |
| `GET` | `/fs-records/file?path=...&json_path=...` | Get one record by JSON Pointer position |
| `PUT` | `/fs-records/file?path=...&json_path=...` | Update a record in a source file |
| `DELETE` | `/fs-records/file?path=...&json_path=...` | Delete a record from a source file |

The `file` segment is matched first, before type lookup. If the first path segment equals `"file"`, the request is dispatched to `_handle_path_based_source_file` unconditionally.

---

## Type-Based CRUD

### On Entry: Type Registry Lookup

Every request that is not routed to the file-based handler first extracts the record type from the URL:

```python
record_type = segments[0]
record_cls = fs_type_registry.get(record_type)
if record_cls is None:
    return ApiFailResponse(
        message=f"Unknown record type '{record_type}'. Available types: ...",
        status_code=400,
    )
```

`SchemaRegistry` maps type name strings (e.g. `"claude_session"`, `"agentic_process"`) to their `Record` subclasses via `get_record_cls()`. Types self-register at import time via the `__init_subclass__` hook in `Record` — any subclass that sets a non-empty `_record_type` class variable is automatically registered with `SchemaRegistry`. The legacy `fs_type_registry` (`flow_sdk/fs_store/factory/type_registry.py`) is a thin shim whose `get()` method calls `SchemaRegistry.get_record_cls()` internally.

At handler entry the import `import flow_sdk.fs_records` triggers auto-registration of all built-in record types.

### GET — List Registered Types

When no sub-path is given and the method is GET, the handler returns all registered type names:

```python
if not segments and method == "get":
    return ApiSuccessResponse(data={"types": fs_type_registry.get_all_types()})
```

**Response:**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "types": ["agentic_process", "agent", "skill", "task", "memo", "claude_session", "..."]
  }
}
```

### GET — List Records

```
GET /api/v1/graph/compute_node/{node_id}/fs-records/{type}[?<query params>]
```

If no uid is present in the URL, all records of the type are returned (with optional filtering via query parameters). A `RecordList` is constructed from the resolved `record_cls` and iterated. If query parameters are present, `_parse_record_query` builds a `RecordQuery` and applies it via `RecordList.query(query)`. If no query parameters apply, the full list is returned via iteration.

`include` parameters are applied after fetching (see [Embed Includes](#_embed_includes-include-parameter) below).

**Response:**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": [
    {
      "id": "abc123",
      "type": "agentic_process",
      "name": "my-process",
      "status": "active",
      "created_at": "2026-03-01T10:00:00",
      "modified_at": "2026-03-04T12:30:00"
    }
  ]
}
```

### GET — Get Single Record

```
GET /api/v1/graph/compute_node/{node_id}/fs-records/{type}/{uid}
```

Delegates to `RecordList.get(uid)` which calls `record_cls.discover_one(uid)`. If not found, returns 404.

**Response (found):**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "abc123",
    "type": "agentic_process",
    "name": "my-process",
    "status": "active"
  }
}
```

**Response (not found):**

```json
{
  "status": "FAIL",
  "message": "Record 'abc123' not found",
  "data": null
}
```

### POST — Create Record

```
POST /api/v1/graph/compute_node/{node_id}/fs-records/{type}
Content-Type: application/json
```

The request body must be a JSON object. It is passed to `RecordList.create(body)` which calls `record_cls.from_dict(body)`, checks for a duplicate uid, and calls `record.persist()`.

If a record with the same uid already exists, a `ValueError` is raised and wrapped in a 409 response.

After a successful create, `rec.sync_to_db()` is called on the real saved record (not a reconstruction) to update the Entity + FTS cache. Then a `DataOp("create", ...)` notification is broadcast via `_broadcast_fs_record_op`.

**Request body:**

```json
{
  "id": "new-id-001",
  "name": "My Process",
  "status": "new"
}
```

**Response (success):**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "new-id-001",
    "type": "agentic_process",
    "name": "My Process",
    "status": "new"
  }
}
```

**Response (duplicate uid):**

```json
{
  "status": "FAIL",
  "message": "Record with uid 'new-id-001' already exists",
  "data": null
}
```

### PUT — Update Record

```
PUT /api/v1/graph/compute_node/{node_id}/fs-records/{type}/{uid}
Content-Type: application/json
```

The uid must be present in the URL. The request body is a partial or full JSON object containing the fields to update. `RecordList.update(uid, body)` fetches the existing record, sets each provided key via `setattr`, and calls `record.persist()`. If the record does not exist a `KeyError` is raised and wrapped in a 404.

After a successful update, `rec.sync_to_db()` is called on the real saved record to update the Entity + FTS cache. Then a `DataOp("update", ...)` broadcast is sent.

**Request body:**

```json
{
  "status": "active",
  "name": "Updated Name"
}
```

**Response (success):**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "abc123",
    "type": "agentic_process",
    "name": "Updated Name",
    "status": "active"
  }
}
```

**Response (not found):**

```json
{
  "status": "FAIL",
  "message": "No record with uid 'abc123'",
  "data": null
}
```

### DELETE — Delete Record

```
DELETE /api/v1/graph/compute_node/{node_id}/fs-records/{type}/{uid}
```

The uid must be present. Before touching disk, `Entity.delete_by_record_ref(record_type/uid)` removes the Entity row and FTS entry from SQLite. Then `RecordList.delete(uid)` removes the record directory or file from disk. Returns 404 if the record did not exist.

After a successful delete, a `DataOp("delete", ...)` broadcast is sent.

**Response (success):**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "deleted": "abc123"
  }
}
```

**Response (not found):**

```json
{
  "status": "FAIL",
  "message": "Record 'abc123' not found",
  "data": null
}
```

---

## Read-Only Record Check

Before any write operation (POST, PUT, DELETE) the handler checks the `_read_only` class variable on the resolved record class:

```python
if getattr(record_cls, "_read_only", False):
    raise ReadOnlyRecordError(f"{record_cls.__name__} is read-only")
```

Any `ReadOnlyRecordError` is caught and returned as a 403:

```json
{
  "status": "FAIL",
  "message": "Record is read-only: ClaudeSessionFsRecord is read-only",
  "data": null
}
```

This check applies to both the type-based and path-based handlers.

---

## `_parse_record_query` — Query Parameters

The static method `_parse_record_query(qp)` parses URL query parameters into a `RecordQuery` instance. It is only called for GET list requests (no uid in the path).

If none of the filter-triggering parameters are present (`ids`, `modified_after`, `parent_id`, `status`, `limit`, `sort_by`), the method returns `None` and the handler iterates all records without filtering. Note: `offset` alone does **not** trigger query construction — passing only `?offset=N` without any other filter or sort parameter has no effect and returns all records from index 0.

### Supported Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `ids` | comma-separated strings | Filter to records whose uid is in this list. Example: `ids=abc,def,ghi` |
| `modified_after` | ISO 8601 datetime string | Only return records modified after this timestamp. Example: `modified_after=2026-01-01T00:00:00` |
| `parent_id` | string | Only return records whose `parent_ref.id` equals this value |
| `status` | string | Only return records whose `status` equals this value |
| `limit` | integer | Maximum number of records to return (applied after filtering and sorting) |
| `offset` | integer | Number of records to skip before returning results (default: `0`) |
| `sort_by` | string | Attribute name to sort by. Supported values: `"created_at"`, `"modified_at"`, `"name"`. Records with a `None` value for the sort key are placed at the end. |
| `sort_desc` | `"true"` / `"false"` | Sort direction. Defaults to descending (`true`). Set to `"false"`, `"0"`, or `"no"` to sort ascending. |

> **Note:** The `RecordQuery` dataclass has additional fields (`types`, `created_after`, `created_before`, `modified_before`, `child_filter`, `predicate`) that work programmatically via `RecordQuery.apply()` but are **not** exposed through the HTTP URL parameters. They can only be used by Python callers constructing `RecordQuery` objects directly.

### RecordQuery Filter Logic

All filters are AND-ed. A record must pass every specified filter to be included. Pagination (`offset`, `limit`) is applied after filtering and sorting.

The `RecordQuery.apply(records)` method:
1. Iterates all records calling `matches(record)` for each.
2. Sorts the filtered list by `sort_by` attribute if specified.
3. Applies `offset` (slice from index) then `limit` (truncate to length).

### Example

```
GET /api/v1/graph/compute_node/local/fs-records/agentic_process
    ?status=active
    &modified_after=2026-02-01T00:00:00
    &sort_by=modified_at
    &sort_desc=false
    &limit=10
    &offset=0
```

---

## `_embed_includes` — `?include=` Parameter

The static method `_embed_includes(item, rec, include_set, cache=None)` optionally joins related records into the serialized response. It is called on each record dict after `to_dict()` when the request contains an `include` query parameter. The `cache` parameter is optional: it is passed for list responses (shared across records to avoid duplicate lookups) and omitted for single-record GET responses.

### `?include=session`

The only currently supported include value is `session`. When `include=session` is present and the record has a `session_ref` attribute with a non-empty `.id`:

1. `ClaudeSessionFsRecord.discover_one(session_ref.id, project=rec.data.get("project", ""))` is called.
2. If found, the session record's `to_dict()` is embedded under the key `"_session"` in the response item.

For list responses, a `cache: dict` is shared across all records to avoid redundant `discover_one` calls for records that share the same session ref id.

**Example (GET list with include):**

```
GET /fs-records/agentic_process?include=session
```

**Response item:**

```json
{
  "id": "proc-001",
  "type": "agentic_process",
  "status": "active",
  "_session": {
    "id": "sess-xyz",
    "type": "claude_session",
    "name": "My Session"
  }
}
```

If the record has no `session_ref`, or the session cannot be found, the `"_session"` key is simply absent.

---

## Path-Based Source File API

The `file` sub-path variant operates on source files on disk — JSON configuration files that contain multiple embedded records at different JSON Pointer paths. This is used for files like `~/.claude/settings.json` or `.mcp.json` that are owned externally by the Claude CLI.

### URL Pattern

```
GET  /api/v1/graph/compute_node/{node_id}/fs-records/file?path={source_path}[&json_path={json_ptr}]
PUT  /api/v1/graph/compute_node/{node_id}/fs-records/file?path={source_path}&json_path={json_ptr}
DELETE /api/v1/graph/compute_node/{node_id}/fs-records/file?path={source_path}&json_path={json_ptr}
```

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Always | Absolute or `~`-prefixed path to the source JSON file on disk. The path is expanded with `Path.expanduser()`. |
| `json_path` | GET: optional; PUT/DELETE: required | RFC 6901 JSON Pointer identifying the record's position within the file (e.g. `"/mcpServers/my-server"`). An empty string or `"/"` refers to the root record. |

### Security Check: `is_allowed_source_path`

Before any file operation the path is validated against a whitelist defined in `flow_sdk/fs_store/source_file_registry.py`. Two conditions must both pass:

1. The filename (basename) must be in `_ALLOWED_FILENAMES`:

   ```python
   _ALLOWED_FILENAMES = frozenset({
       "settings.json",
       "settings.local.json",
       "mcp.json",
       ".mcp.json",
       "managed-settings.json",
       ".claude.json",
   })
   ```

2. The expanded path must match the pattern `_ALLOWED_PATH_RE`, which requires either a `/.claude/` directory component or the path ends in `.mcp.json` or `.claude.json`:

   ```python
   _ALLOWED_PATH_RE = re.compile(
       r"(?:^|/)"
       r"(?:"
       r"\.claude/"
       r"|\.mcp\.json$"
       r"|\.claude\.json$"
       r")"
   )
   ```

If the check fails, a 403 is returned immediately.

> **Implementation note:** `"mcp.json"` (without a leading dot) is in `_ALLOWED_FILENAMES` but `_ALLOWED_PATH_RE` only matches `\.mcp\.json$` (with dot). A file named `mcp.json` outside a `/.claude/` directory will pass the filename check and fail the regex, returning 403. In practice, `mcp.json` (undotted) is only usable when located inside a `.claude/` directory.

```json
{
  "status": "FAIL",
  "message": "Access denied for path: /etc/passwd",
  "data": null
}
```

### SourceFileRecordList Lookup

After the security check, `resolve_list_class(expanded_path)` looks up which `SourceFileRecordList` subclass to use for this file. Subclasses are registered at import time via `register_file_pattern(filename, list_class)`, keyed by filename (not full path):

```python
def resolve_list_class(source_path: str | Path) -> type[SourceFileRecordList] | None:
    return _FILE_PATTERNS.get(Path(source_path).name)
```

If no list class is registered for the filename, a 400 is returned.

The list class is instantiated with the expanded path: `list_class(source_file=expanded_path)`.

### GET — List Records from File

When `json_path` is absent, the handler iterates all records returned by the `SourceFileRecordList` and adds `source_file` and `json_path` fields to each serialized dict:

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": [
    {
      "id": "abc",
      "type": "claude_settings_json",
      "source_file": "/Users/alice/.claude/settings.json",
      "json_path": ""
    }
  ]
}
```

### GET — Get Single Record by JSON Pointer

When `json_path` is provided, `_find_record_by_json_path` scans the list for a record whose `json_path` attribute equals the requested pointer. Both `""` and `"/"` match the root record:

```python
if json_path in ("", "/") and rec_jp in ("", "/"):
    return rec
```

The response includes `source_file` and `json_path` in the returned dict:

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "abc",
    "type": "claude_settings_json",
    "source_file": "/Users/alice/.claude/settings.json",
    "json_path": ""
  }
}
```

### PUT — Update a Record in a Source File

`json_path` is required. The handler:
1. Finds the record via `_find_record_by_json_path`.
2. Calls `record_list.update(rec.type, rec.uid, body)` which applies the field updates and writes back to the source file (via `SourceFileRecordList._write_record_to_source`).
3. Calls `updated.sync_to_db()` on the real updated record to keep the Entity + FTS cache current.
4. Broadcasts a `DataOp("update", ...)` with `_source_file` embedded in the broadcast data.
5. Returns the updated record dict with `source_file` and `json_path`.

**Request body:**

```json
{
  "allowedTools": ["Read", "Write"],
  "theme": "dark"
}
```

**Response:**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "abc",
    "type": "claude_settings_json",
    "source_file": "/Users/alice/.claude/settings.json",
    "json_path": ""
  }
}
```

### DELETE — Remove a Record from a Source File

`json_path` is required. The handler:
1. Finds the record via `_find_record_by_json_path`.
2. Calls `record_list.delete_record(rec.type, rec.uid)` which uses RFC 6901 pointer deletion to remove the key from the JSON file and writes it back.
3. Broadcasts a `DataOp("delete", ...)`.
4. Returns `{"deleted": json_path}`.

Root records (empty `json_path`) cannot be deleted via `SourceFileRecordList.delete_record` — it raises `ValueError("Cannot delete the root record of a source file")`.

**Response:**

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "deleted": "/mcpServers/my-server"
  }
}
```

---

## Post-Write: Entity Sync and DataOp Broadcast

Every successful write follows this sequence:

```
write (create/update)
  → rec.sync_to_db()             # Entity row + FTS upsert from the real saved record
  → _broadcast_fs_record_op()    # WebSocket DataOp notification only

delete
  → Entity.delete_by_record_ref()  # Entity row + FTS entry removed from SQLite
  → RecordList.delete()            # record directory/file removed from disk
  → _broadcast_fs_record_op()      # WebSocket DataOp notification only
```

### `rec.sync_to_db()` — Entity/FTS cache update

Called on the **real saved record** (has `path`, `source_file`, domain data set). Internally:
1. `Entity.from_record(self)` — upserts the Entity row with fields from `meta_dict()`
2. `driver.fts_upsert(...)` — updates the FTS5 entry if `self.content` is not None
3. `self.write_hash_file(...)` — records the content hash for staleness detection

**Important:** `sync_to_db()` is never called on a dict-reconstructed throwaway record — only on the real object returned by `record_list.create()` / `record_list.update()`.

### `_broadcast_fs_record_op()` — WebSocket notification only

```python
async def _broadcast_fs_record_op(
    self, op: str, record_type: str, uid: str, data: dict | None = None,
    *, source_file: str | None = None,
) -> None:
```

Constructs a `DataOpMessage` and calls `handle_entity_op(msg)` to dispatch it to all connected WebSocket clients. Fields:
- `op`: `"create"`, `"update"`, or `"delete"` (mapped to `OperationType` enum)
- `to_entity`: `TypeId(type=record_type, id=uid)`
- `data`: record dict for create/update; `None` for delete. Path-based ops add `_source_file` to the data dict.

This method does **not** touch the Entity DB or FTS. All DB sync happens before this call via `rec.sync_to_db()`.

---

## Scan and Index: `progress_report` WebSocket Events

The `/fs-records/scan` and `/fs-records/index` endpoints broadcast `progress_report` FlowData events during execution so that connected clients can show real-time progress without polling.

### Two-level event interleave

For each record type processed in an aggregate scan/index, two kinds of events are emitted **interleaved**:

| Event kind | `sub_activity_name` | `done` meaning | Emitted when |
|---|---|---|---|
| Sub-activity | `"<type_name>"` | records processed within that type | Every `PROGRESS_EMIT_EVERY` (25) records |
| Job-level | `null` | types completed out of total types | After each type finishes |

```json
// Sub-activity event — per-record progress within a type
{ "element_type": "progress_report", "attributes": {
    "job_name": "scan", "sub_activity_name": "skill",
    "done": 25, "skipped": 0, "errors": 0, "total": 500, "text": null }}

// Job-level event — type completed
{ "element_type": "progress_report", "attributes": {
    "job_name": "scan", "sub_activity_name": null,
    "done": 3, "skipped": 0, "errors": 0, "total": 12, "text": null }}
```

For `index` events `skipped` reflects records that were already fresh (`skip_fresh=True`); `errors` reflects `sync_to_db()` failures.

### Per-type endpoints

Per-type scan (`?type=X`) and per-type index (`?type=X`) also emit progress events:
- One sub-activity event at completion (`done == total`)
- One job-level event (`done=1, total=1`)

### Conflict detection (409)

Starting an aggregate scan/index while one is already running (not timed out, not complete) returns **409 Conflict**. The backend uses `InProcessActivity` objects stored in `_COMPUTE_ACTIVITIES` (module-level, keyed by `"{typeid}:{job_name}"`). Each activity auto-expires after `timeout_seconds` (600s for aggregate, 60s for per-type).

**Source:** `flow_sdk/builtin/faas/in_process_activity.py`

---

## Error Response Format

All errors follow the standard `ApiResponse` format with `status: "FAIL"`:

```json
{
  "status": "FAIL",
  "message": "<description of the error>",
  "data": null
}
```

The HTTP status code is carried in `ApiFailResponse.status_code` and applied as the HTTP response status. The default is `500` for unexpected exceptions; specific error cases use:

| Situation | HTTP Status |
|-----------|-------------|
| Missing required URL segments or query params | 400 |
| Unknown record type | 400 |
| Unknown source file type | 400 |
| Access denied (path security check) | 403 |
| Write attempted on read-only record | 403 |
| Record uid not found | 404 |
| JSON Pointer not found in source file | 404 |
| Duplicate uid on create | 409 |
| Unexpected exception | 500 |

---

## Complete Request/Response Examples

### List All Registered Types

```
GET /api/v1/graph/compute_node/local/fs-records
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "types": [
      "agentic_process",
      "agent",
      "skill",
      "task",
      "memo",
      "claude_session",
      "claude_settings",
      "claude_settings_json"
    ]
  }
}
```

### List Records with Query

```
GET /api/v1/graph/compute_node/local/fs-records/agentic_process
    ?status=active&sort_by=modified_at&sort_desc=true&limit=5
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": [
    {
      "id": "proc-001",
      "type": "agentic_process",
      "name": "Fix login bug",
      "status": "active",
      "modified_at": "2026-03-04T14:22:00"
    }
  ]
}
```

### Get Single Record

```
GET /api/v1/graph/compute_node/local/fs-records/agentic_process/proc-001
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "proc-001",
    "type": "agentic_process",
    "name": "Fix login bug",
    "status": "active",
    "created_at": "2026-03-01T09:00:00",
    "modified_at": "2026-03-04T14:22:00"
  }
}
```

### Create a Record

```
POST /api/v1/graph/compute_node/local/fs-records/task
Content-Type: application/json

{
  "id": "task-xyz",
  "name": "Write unit tests",
  "status": "new",
  "task_type": "development"
}
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "task-xyz",
    "type": "task",
    "name": "Write unit tests",
    "status": "new",
    "task_type": "development"
  }
}
```

### Update a Record

```
PUT /api/v1/graph/compute_node/local/fs-records/task/task-xyz
Content-Type: application/json

{
  "status": "active"
}
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "task-xyz",
    "type": "task",
    "name": "Write unit tests",
    "status": "active",
    "task_type": "development"
  }
}
```

### Delete a Record

```
DELETE /api/v1/graph/compute_node/local/fs-records/task/task-xyz
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "deleted": "task-xyz"
  }
}
```

### Path-Based: List All Records from a Source File

```
GET /api/v1/graph/compute_node/local/fs-records/file
    ?path=~/.claude/settings.json
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": [
    {
      "id": "a1b2c3",
      "type": "claude_settings_json",
      "source_file": "/Users/alice/.claude/settings.json",
      "json_path": ""
    },
    {
      "id": "d4e5f6",
      "type": "claude_settings_json:permissions",
      "source_file": "/Users/alice/.claude/settings.json",
      "json_path": "/permissions"
    }
  ]
}
```

### Path-Based: Get a Record by JSON Pointer

```
GET /api/v1/graph/compute_node/local/fs-records/file
    ?path=~/.claude/settings.json&json_path=/permissions
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "d4e5f6",
    "type": "claude_settings_json:permissions",
    "source_file": "/Users/alice/.claude/settings.json",
    "json_path": "/permissions"
  }
}
```

### Path-Based: Update a Record in a Source File

```
PUT /api/v1/graph/compute_node/local/fs-records/file
    ?path=~/.claude/settings.json&json_path=
Content-Type: application/json

{
  "theme": "dark",
  "autoUpdaterStatus": "enabled"
}
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "id": "a1b2c3",
    "type": "claude_settings_json",
    "source_file": "/Users/alice/.claude/settings.json",
    "json_path": ""
  }
}
```

### Path-Based: Delete a Sub-Record

```
DELETE /api/v1/graph/compute_node/local/fs-records/file
    ?path=~/.claude/.mcp.json&json_path=/mcpServers/old-server
```

```json
{
  "status": "SUCCESS",
  "message": "success",
  "data": {
    "deleted": "/mcpServers/old-server"
  }
}
```
