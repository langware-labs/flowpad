---
id: 24f24fb0-9255-56f5-88e6-0f4b77033acc
---

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
  → record_list.create(body)     # write FSRecord to disk
  → rec.sync_to_db()             # update Entity + FTS cache from the real saved record
  → _broadcast_fs_record_op()    # WebSocket notification to frontend
```

`_broadcast_fs_record_op` is notification-only — it sends a `DataOpMessage` to WebSocket clients. Entity/FTS sync always happens via `rec.sync_to_db()` on the real saved record before the broadcast, never inside the broadcast itself.

**Source files:**

- `flow_sdk/builtin/faas/compute_node.py` — the `@action.all` stub `fs_records_action`, which delegates to `_fs_records_action()` in the mixin
- `flow_sdk/builtin/faas/fs_records_actions.py` — `FsRecordsActionsMixin`: the action handler `_fs_records_action`, plus `_parse_record_query`, `_embed_includes`, `_handle_path_based_source_file`, `_broadcast_fs_record_op`, and the scan/index/search handlers
- `flow_sdk/fs_store/record_query.py` — `RecordQuery` dataclass
- `flow_sdk/fs_store/source_file_records.py` — pure-function extractors (`extract_records`, `extract_from_data`, `is_allowed_source_path`, `known_filename`, `load_raw`, `write_raw`) for embedded JSON config files
- `flow_sdk/fs_store/record_list.py` — `RecordList` storage-agnostic collection over `FSRecord`
- `flow_sdk/fs_store/fs_record.py` — `FSRecord`, the single concrete record class (discover / load / save / `sync_to_db`)
- `flow_sdk/fs_store/schema_registry.py` — `SchemaRegistry`, the single type registry (`get`, `get_all_record_types`)

---

## Action Registration

The action is registered using the `@action.all` decorator on a thin `ComputeNode` stub that delegates to the implementation living in `FsRecordsActionsMixin._fs_records_action()`:

```python
@action.all(action_name="fs-records", methods=["get", "post", "put", "delete"])
async def fs_records_action(self): return await self._fs_records_action()
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

Several reserved first segments are dispatched to dedicated handlers ahead of the generic type lookup:

| HTTP Method | URL Pattern | Handler |
|-------------|-------------|---------|
| `GET` | `/fs-records/history_entry?limit=N[&include=claude_session]` | `_handle_fs_records_history` — unified worker history (computed view) |
| `GET` | `/fs-records/search?q=...&limit=&offset=&record_type=&sort_by=&status=&parent_path=&vault_root=&include_system=&tags=` | `_handle_fs_records_search` — FTS5 / filter browse |
| `GET` | `/fs-records/mcp-reconcile[?use_cli=true]` | `_handle_fs_records_mcp_reconcile` — MCP server config vs. CLI reconciliation |
| `GET` | `/fs-records/scan[?type=X&trigger=&limit_types=&limit_per_type=&user=&projects=]` | `_handle_fs_records_scan` |
| `POST` | `/fs-records/index[?type=X&trigger=&rebuild=&force=&path=&limit_types=&limit_per_type=&orphan_action=&user=&projects=]` | `_handle_fs_records_index` (`project_id` is still accepted as a legacy alias for `projects` when neither `user` nor `projects` is given) |
| `POST` | `/fs-records/invalidate` (body `{paths: [...], deleted_paths: [...]}`) | `_handle_fs_records_invalidate` — push re-index of a changed-file set (see `invalidation.md`) |
| `POST` | `/fs-records/index-sessions[?project_id=…]` | `_handle_fs_records_index_sessions` — index worker sessions scoped to a project |
| `GET` | `/fs-records/index-status` | `_handle_fs_records_index_status` |
| `GET` | `/fs-records/asset-stats` | `_handle_fs_records_asset_stats` |
| `GET` | `/fs-records/activity-status` | `_handle_fs_records_activity_status` |
| `DELETE` | `/fs-records/index[?type=X&user=&projects=]` | `_handle_fs_records_index_clear` |
| `POST` | `/fs-records/{type}/discover?path=...` | `_handle_fs_records_discover_by_path` — deprecated alias of `GET /api/v1/assets/resolve?path=`; 404 unless the path resolves to `{type}` |

The `file` segment is matched first, before any other dispatch. If the first path segment equals `"file"`, the request is dispatched to `_handle_path_based_source_file` unconditionally. The reserved segments are then matched in the order listed above (each is gated on its HTTP method, so e.g. `GET /fs-records/index` falls through to the generic type lookup and fails with "Unknown record type 'index'"). After the reserved segments, a bare `GET /fs-records` lists the registered types, then the `{type}/discover` POST is matched, and finally the generic type-based CRUD path.

> `GET /asset-usage?skill=<name>` is a sibling `@action` on `ComputeNode` (not an `fs-records` sub-path), but it shares the `"scan"` activity slot described under [Conflict detection](#conflict-detection-409).

---

## Type-Based CRUD

### On Entry: Type Registry Lookup

Every request that reaches the generic CRUD path first extracts the record type from the URL and validates it against `SchemaRegistry`:

```python
record_type = segments[0]
uid = segments[1] if len(segments) > 1 else None

if SchemaRegistry.get(record_type) is None:
    return ApiFailResponse(
        message=f"Unknown record type '{record_type}'. Available types: {SchemaRegistry.get_all_record_types()}",
        status_code=400,
    )

record_list = RecordList(type_name=record_type)
```

`SchemaRegistry.get(type_name)` returns the registered `TypeInfo` for a type name (e.g. `"claude_session"`, `"agentic_process"`), or `None` for an unknown type. There is **no** per-type `Record` subclass and no `get_record_cls()` — every record type is served by the single concrete `FSRecord` class, with `RecordList(type_name=...)` driving discovery and persistence. Type metadata (record class is always `FSRecord`; per-type behavior lives in `TypeInfo`) is registered with `SchemaRegistry`, which is the single type registry for the whole system. `RecordType`/`SkillitRecordType` in `flow_sdk/fs_store/record_types.py` are backward-compat aliases of the canonical `EntityType` in `flow_sdk/schema/types.py`.

At handler entry the import `import flow_sdk.fs_store.indexer.registrations` triggers auto-registration of all built-in record types.

### GET — List Registered Types

When no sub-path is given and the method is GET, the handler returns all registered type names:

```python
if not segments and method == "get":
    return ApiSuccessResponse(data={"types": SchemaRegistry.get_all_record_types()})
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

If no uid is present in the URL, all records of the type are returned (with optional filtering via query parameters). A `RecordList(type_name=record_type)` is constructed and iterated (off-thread via `asyncio.to_thread`). If query parameters are present, `_parse_record_query` builds a `RecordQuery` and applies it via `RecordList.query(query)`. If no query parameters apply, the full list is returned via iteration. Each record is serialized with `meta_dict()` (the identity/metadata subset), not the full record payload.

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

Delegates to `RecordList.get(uid)` which calls `FSRecord.load_or_none(type_name, uid)`. If not found, returns 404. The found record is serialized with `meta_dict()`.

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

The request body must be a JSON object. It is passed to `RecordList.create(body)` which calls `FSRecord.from_dict(payload)` (with `type` defaulted to the list's `type_name`), checks for a duplicate id via `get()`, and calls `record.save()`.

If a record with the same id already exists, a `ValueError` (`"Record with id <id> already exists"`) is raised and wrapped in a 409 response.

After a successful create, `rec.sync_to_db()` is called on the real saved record (not a reconstruction) to update the Entity + FTS cache. The handler then calls `_materialize_main_body(rec, record_type)`, which writes the just-created asset's main body to disk through the type's `DiskSerializer` (e.g. a `SKILL.md`) so a disk-walking scan can rediscover it — `sync_to_db` writes the DB row and the metadata shadow, not the main body. Both steps are best-effort: a failure is logged at debug level and never fails the create. There is **no** post-create scope patch in the handler: `scope` is stamped from the resolved asset path inside `Entity._prepare_for_storage` (the single save chokepoint), so HTTP-created records are born with a scope just like indexer-discovered ones. Finally a `DataOp("create", ...)` notification is broadcast via `_broadcast_fs_record_op` with `rec.meta_dict()`.

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
  "message": "Record with id 'new-id-001' already exists",
  "data": null
}
```

### PUT — Update Record

```
PUT /api/v1/graph/compute_node/{node_id}/fs-records/{type}/{uid}
Content-Type: application/json
```

The uid must be present in the URL. The request body is a partial or full JSON object containing the fields to update. `RecordList.update(uid, body)` fetches the existing record via `get()`, builds a patch that excludes the `type` and `id` keys, and applies it via `record.save_metadata(patch)`. If the record does not exist a `KeyError` (`"No record with id <id>"`) is raised and wrapped in a 404.

After a successful update, `rec.sync_to_db()` is called on the real saved record to update the Entity + FTS cache. Then a `DataOp("update", ...)` broadcast is sent with `rec.meta_dict()`.

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
  "message": "No record with id 'abc123'",
  "data": null
}
```

### DELETE — Delete Record

```
DELETE /api/v1/graph/compute_node/{node_id}/fs-records/{type}/{uid}
```

The uid must be present. Before touching disk, the handler fetches the Entity via `Entity.get_one(QueryFilter.parse({"id": uid}, record_type))`; if present, it removes the FTS entry (`driver.fts_delete(entity.id)`) and deletes the Entity row (`entity.delete()`). It then re-fetches the record from disk via `RecordList.get(uid)` (returning 404 if it no longer exists), removes the record's live `asset_ref` source (the file/folder under `~/.claude/...`, via `rmtree`/`unlink`) so re-discovery doesn't resurface it, and finally calls `RecordList.delete(uid)` which `rmtree`s the record's `shadow_dir`.

After a successful delete, a `DataOp("delete", ...)` broadcast is sent (with no data payload).

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

## Read-Only Records

The per-record `_read_only` class-variable check was removed. A `RecordList` over `FSRecord` is always mutable, so the generic CRUD path no longer pre-checks read-only-ness before a write. Write protection is now enforced at the `FSRef` level inside `sync_to_db`/persistence (`_is_read_only()` checking the `asset_ref`/`self_ref` `read_only` flag), not by the action handler.

The handler still imports `ReadOnlyRecordError` and catches it, returning a 403 if it is ever raised during a write:

```python
except ReadOnlyRecordError as e:
    return ApiFailResponse(message=f"Record is read-only: {e}", status_code=403)
```

```json
{
  "status": "FAIL",
  "message": "Record is read-only: <detail>",
  "data": null
}
```

---

## `_parse_record_query` — Query Parameters

The static method `_parse_record_query(qp)` parses URL query parameters into a `RecordQuery` instance. It is only called for GET list requests (no uid in the path).

If none of the filter-triggering parameters are present (`ids`, `modified_after`, `parent_id`, `status`, `limit`, `offset`, `sort_by`), the method returns `None` and the handler iterates all records without filtering. Note: `offset` **is** in the trigger list — passing `?offset=N` alone constructs a `RecordQuery` and applies the offset slice (defaulting to descending sort with no `sort_by`).

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

> **Note:** The `RecordQuery` dataclass has additional fields (`types`, `created_after`, `created_before`, `modified_before`, `child_filter`, `predicate`, `field_predicates`, `scope`) that work programmatically via `RecordQuery.apply()` but are **not** exposed through the HTTP URL parameters. They can only be used by Python callers constructing `RecordQuery` objects directly.

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

The static method `_embed_includes(item, rec, include_set, cache=None)` optionally joins related records into the serialized response. It is called on each record dict after `meta_dict()` when the request contains an `include` query parameter. The `cache` parameter is optional: it is passed for list responses (shared across records to avoid duplicate lookups) and omitted for single-record GET responses.

### `?include=claude_session`

The only currently supported include value is `claude_session`. When `include=claude_session` is present and the record has a `session_ref` attribute with a non-empty `.id`:

1. `get_claude_session(session_ref.id, project=rec.data.get("project", ""))` (from `flow_sdk.fs_store.indexer.functions.claude_sessions`) is called.
2. If found, `claude_session_meta_dict(session)` is embedded under the key `"_session"` in the response item.

For list responses, a `cache: dict` is shared across all records to avoid redundant session lookups for records that share the same session ref id. (Note: the `history_entry` handler also honors `?include=claude_session`, embedding a `_session` shape built directly from the worker-history aggregation.)

**Example (GET list with include):**

```
GET /fs-records/agentic_process?include=claude_session
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

The `file` sub-path variant operates on source files on disk — JSON configuration files that contain multiple embedded records at different JSON Pointer paths. This is used for files like `~/.claude/settings.json` or `.mcp.json` that are owned externally by the Claude CLI. The implementation lives in `flow_sdk/fs_store/source_file_records.py` as a set of pure functions (`extract_records`, `extract_from_data`, `is_allowed_source_path`, `known_filename`, `load_raw`, `write_raw`, plus the RFC-6901 helpers `_set_pointer`/`_delete_pointer`) — there is no `SourceFileRecordList` Record-subclass hierarchy on the Python side anymore (that lives only in the TS SDK).

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

Before any file operation the path is validated against a whitelist defined in `flow_sdk/fs_store/source_file_records.py`. Two conditions must both pass:

1. The filename (basename) must be in `_ALLOWED_FILENAMES`, which is **derived from the `_EXTRACTORS` registry** so the allow-list can't drift from what can actually be extracted:

   ```python
   _EXTRACTORS = {
       "settings.json":         _extract_settings_json,
       "settings.local.json":   _extract_settings_json,
       "managed-settings.json": _extract_managed_settings,
       "mcp.json":              _extract_mcp_json,
       ".mcp.json":             _extract_mcp_json,
   }
   _ALLOWED_FILENAMES = frozenset(_EXTRACTORS.keys())
   ```

   (Note: `.claude.json` is **not** in this set — there is no extractor for it.)

2. The expanded path must contain one of the substring fragments in `_ALLOWED_PATH_FRAGMENTS` (a plain `in` substring check, **not** a regex):

   ```python
   _ALLOWED_PATH_FRAGMENTS = (".claude/", "/.mcp.json")

   def is_allowed_source_path(path: str) -> bool:
       expanded = str(Path(path).expanduser())
       if Path(expanded).name not in _ALLOWED_FILENAMES:
           return False
       return any(frag in expanded for frag in _ALLOWED_PATH_FRAGMENTS)
   ```

If the check fails, a 403 is returned immediately.

> **Implementation note:** `"mcp.json"` (without a leading dot) is in `_ALLOWED_FILENAMES`, but the path fragments only match a `.claude/` directory component or a `/.mcp.json` (dotted) suffix. A file named `mcp.json` outside a `.claude/` directory passes the filename check and fails the fragment check, returning 403. In practice, undotted `mcp.json` is only usable when located inside a `.claude/` directory.

```json
{
  "status": "FAIL",
  "message": "Access denied for path: /etc/passwd",
  "data": null
}
```

### Extractor Lookup

After the security check, the handler expands the path and verifies a known extractor exists for the filename via `known_filename(expanded_path)`, which checks `Path(path).name in _EXTRACTORS`. If no extractor is registered for the filename, a 400 (`"Unknown source file type: ..."`) is returned.

Records are then produced by `extract_records(expanded_path)`, which reads + parses the JSON and dispatches to the per-file extractor (`_extract_settings_json`, `_extract_managed_settings`, or `_extract_mcp_json`). Each extracted record is a plain dict already carrying `type`, `json_path`, and `source_file` — there is no class instantiation step.

### GET — List Records from File

When `json_path` is absent, the handler returns the list of records produced by `extract_records(expanded_path)`. Each dict already carries `source_file` and `json_path`:

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

When `json_path` is provided, the handler scans the extracted records for the first whose `json_path` field string-equals the requested pointer:

```python
match = next(
    (r for r in records if str(r.get("json_path", "")) == json_path),
    None,
)
```

> Note: this is an exact string match — unlike the root-record handling in `_set_pointer`/PUT, the GET lookup does **not** treat `""` and `"/"` as equivalent. The root record is emitted with `json_path == ""`, so it is fetched with `&json_path=` (empty), not `&json_path=/`. If not found, a 404 is returned. The matched dict already carries `source_file` and `json_path`:

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
1. Reads the raw JSON via `load_raw(expanded_path)`.
2. Strips framework-only keys (`type`, `json_path`, `source_file`) from the request body to form the payload.
3. Applies the payload: for a root pointer (`""` or `"/"`) it merges the payload keys into the top-level dict; otherwise it writes via `_set_pointer(data, json_path, payload)`.
4. Writes the file back via `write_raw(expanded_path, data)`.
5. Re-derives records from the in-hand dict via `extract_from_data(data, expanded_path)` (avoiding a redundant re-read) and locates the updated record by `json_path`. If it cannot be re-resolved, a 500 is returned.
6. Broadcasts a `DataOp("update", ...)` with `_source_file` embedded in the broadcast data.
7. Returns the updated record dict with `source_file` and `json_path`.

> Note: the source-file PUT/DELETE path does **not** call `sync_to_db()` — source-file records are not synced into the Entity/FTS layer. Only the type-based CRUD path syncs.

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
1. Reads the raw JSON via `load_raw(expanded_path)`.
2. Calls `_delete_pointer(data, json_path)`, which uses RFC 6901 pointer deletion to remove the key. If nothing was removed (pointer missing, or a root/empty pointer), it returns `False` and the handler responds 404.
3. Writes the file back via `write_raw(expanded_path, data)`.
4. Broadcasts a `DataOp("delete", ...)` with empty `type`/`uid` and `_source_file` embedded.
5. Returns `{"deleted": json_path}`.

Root records cannot be deleted: `_delete_pointer` returns `False` for an empty or `"/"` pointer, so a delete with `&json_path=` returns 404 (`"No record at json_path ''"`).

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
  → rec.sync_to_db()             # Entity row + FTS upsert + wiki + post_sync_fn
  → _broadcast_fs_record_op()    # WebSocket DataOp notification only

delete
  → Entity.get_one(...) → driver.fts_delete(id) + entity.delete()  # DB + FTS removal
  → RecordList.get(uid)            # re-fetch (404 if gone)
  → remove live asset_ref source   # rmtree/unlink the ~/.claude/... file/folder
  → RecordList.delete()            # rmtree the record's shadow_dir
  → _broadcast_fs_record_op()      # WebSocket DataOp notification only
```

### `rec.sync_to_db()` — Entity/FTS cache update

Called on the **real saved record** (returned by `record_list.create()` / `record_list.update()`). It runs the whole pipeline inside a single shared DB session:
1. `Entity.from_record(self)` — upserts the Entity row.
2. `self.sync_from_entity(entity)` — mirrors canonical DB state (id, scope, project_id, asset_ref, updated_date) back into `metadata.json`, and writes the `.hash` index sentinel.
3. FTS upsert — builds an `FtsEntry` (from `self.search_title` / `search_description` / `search_content`) and either appends it to a supplied `fts_batch` or calls `driver.fts_upsert(...)` immediately.
4. `wiki.index(self.type, self.id, self.wiki_body())` — re-extracts wiki edges (failures logged, not raised).
5. The type-specific `TypeInfo.post_sync_fn`, when registered (failures logged, not raised).

On failure the pipeline records a `RecordError` and re-raises; the action handler catches and logs it at debug level so a sync failure does not fail the HTTP write.

**Important:** `sync_to_db()` is never called on a dict-reconstructed throwaway record — only on the real object returned by `record_list.create()` / `record_list.update()`. The source-file (path-based) PUT/DELETE path does not call `sync_to_db()` at all.

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

The `/fs-records/scan` and `/fs-records/index` endpoints broadcast
`progress_report` FlowData events during execution so connected clients can
show real-time progress without polling.

Each event is a complete `IndexProgressTable` snapshot:

```json
{
  "element_type": "progress_report",
  "attributes": {
    "job_name": "index",
    "rows": [
      { "type_name": "skill", "done": 25, "total": 100, "errors": 0, "skipped": 10 }
    ],
    "current": "skill",
    "done": 25,
    "total": 100,
    "text": null,
    "ts": "2026-05-07T12:00:00+00:00"
  }
}
```

Progress is emitted only as table snapshots, with aggregate totals and per-type
rows in the same payload.

For `index`, totals are known up front because the indexer first performs an
internal scan. The first table contains the discovered type rows with `done=0`
and populated `total`.

For `scan`, totals are unknown while discovery is running. Table-level `total`
is `0`, and type rows are added as they are discovered. The UI shows count-only
scan progress.

The terminal event has `text: "complete"` and `current: null`. For `index`
events `skipped` reflects records that were already fresh; `errors` reflects
record sync failures.

Per-type scan (`?type=X`) and per-type index (`?type=X`) emit the same table
shape, normally with a single relevant row for `X`.

### Conflict detection (409)

Starting a scan/index/clear while one of the **same job name** is already running (not timed out, not complete) returns **409 Conflict**. The backend uses `InProcessActivity` objects stored in `_COMPUTE_ACTIVITIES` (module-level dict in `compute_node.py`, keyed by `"{typeid}:{job_name}"` where `job_name` is `"scan"`, `"index"`, or `"clear"`). Because the key does **not** include the type filter, a per-type `scan?type=X` and an aggregate scan share the same `"scan"` activity and therefore conflict with each other. The `"scan"` slot is also taken by the sibling `/asset-usage` action while it walks sessions.

Each activity auto-expires after `timeout_seconds` (the default in `_start_activity` is 600s):

| Caller | job_name | timeout_seconds |
|--------|----------|-----------------|
| `_handle_fs_records_scan`, `_handle_asset_usage` | `scan` | 600 |
| `_handle_fs_records_index` (via the `_index_activity` context helper), `_auto_index_project`, `_index_system_assets` | `index` | 600 |
| `_handle_fs_records_index_sessions` | `index` | 300 |
| `_handle_fs_records_index_clear` | `clear` | 120 |

`is_complete` is true only when the latest table carries `text == PROGRESS_TEXT_COMPLETE` — it is deliberately **not** inferred from `done >= total`, because that already holds during the post-loop orphan sweep and would open the duplicate-start gate to a second concurrent index run.

`GET /fs-records/activity-status` reads `_COMPUTE_ACTIVITIES` to re-seed in-flight progress after a page refresh, returning the latest `IndexProgressTable` plus `started_at`, or `null` when nothing is running.

**Source:** `flow_sdk/builtin/faas/in_process_activity.py` (the `InProcessActivity` dataclass) and `flow_sdk/builtin/faas/compute_node.py` (`_COMPUTE_ACTIVITIES`, `_start_activity`, `_complete_activity`).

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
