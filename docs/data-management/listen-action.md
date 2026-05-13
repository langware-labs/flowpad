# Listen Action and CRUD Event Pipeline

This document describes the full path from an incoming webhook POST to a frontend entity cache update. It covers the `listen_action` entry point, the two webhook types, `_reflect_entity`, `DataOpMessage` broadcast, `resource_tracker` recipient resolution, the WebSocket route, and the TypeScript subscription layer.

## Overview

The listen/CRUD pipeline connects external agents (Claude CLI, background processes) to the frontend through a chain of six stages:

```
POST /api/v1/webhook/listen
         |
    listen_action()
         |
    handle_hook_op() / handle_agent_hook()
         |
    _reflect_entity()   (CREATE / UPDATE / DELETE on DB)
         |
    entity.save() -> handle_entity_op() -> _sync_handle_entity_op()
         |
    DataOpMessage broadcast over WebSocket
         |
    ConnectionManager.onDataOp() -> FlowSyncStore.onDataOp()
         |
    WatchQueryMap / SubscriptionMap cache update + callbacks
```

## Route Registration

The webhook endpoint is registered in `/Users/shlom/Documents/dev/flow-cli/server/routes/webhook.py` as a plain FastAPI route:

```python
webhook_router = APIRouter(prefix="/api/v1/webhook")

@webhook_router.post("/listen")
async def listen_endpoint(request: Request):
    from flow_sdk.app.actions.listen import listen_action
    return await listen_action(request)
```

`listen_action` is deliberately **not** decorated with `@action.all`. The graph catch-all route calls `request.json()` during dispatch; a second call to `request.json()` inside the action would hang because the ASGI receive channel is one-shot. The webhook router calls `listen_action` directly, bypassing the graph route entirely.

## listen_action Entry Point

**File:** `/Users/shlom/Documents/dev/flow-cli/flow_sdk/app/actions/listen.py`

```python
async def listen_action(request):
    json_data = await request.json()
    envelope = WebhookPayload(**json_data)  # validates webhook_type + webhook_payload
    webhook_type = envelope.webhook_type
    raw_payload = envelope.webhook_payload

    if webhook_type == WebhookType.HOOK_OP:
        sync_payload = HookOpPayload(**raw_payload)
        await _broadcast_to_sniffer(flow_value, "hook_op")
        await _route_to_source_process(flow_value, execution_scope=sync_payload.execution_scope)
        return await handle_hook_op(sync_payload)

    if webhook_type == WebhookType.AGENT_HOOK:
        # Skill usage count enrichment step (when tool_name == "Skill"):
        # hook_data_dict["skill_usage_count"] = <usageCount from ~/.claude.json>
        # This mutates raw_payload["hook_data"] in place before the model is built.
        data = AgentHookData(**raw_payload)  # sees enriched hook_data
        await _broadcast_to_sniffer(payload_data, "agent_hook", skip_hook_id=skip_hook_id)
        await _route_to_source_process(payload_data, session_id=agent_session_id)
        return await handle_agent_hook(data)
```

### Outer Envelope

**Model:** `WebhookPayload` (`flow_sdk/core/flow/models/webhook_flow_data.py`)

| Field | Type | Description |
|-------|------|-------------|
| `webhook_type` | `WebhookType` | Either `"hook_op"` or `"agent_hook"` |
| `webhook_payload` | `dict` | Inner payload, type-specific |

### WebhookType Enum

```python
class WebhookType(StrEnum):
    AGENT_HOOK = "agent_hook"
    HOOK_OP = "hook_op"
```

## Two Webhook Types

### hook_op

`hook_op` is the unified envelope for all entity CRUD, events, invocations, and log entries. It is the primary mechanism for syncing state from external agents (Claude CLI, background workers) into the flow-cli database and broadcasting changes to the frontend.

Parsed model: `HookOpPayload` (`flow_sdk/core/flow/models/hook_op.py`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resource_type` | `ResourceType` | `"entity"` | `"entity"` or `"relationship"` |
| `type` | `str` | required | Entity type (e.g. `"task"`, `"agentic_process"`) or relationship type |
| `id` | `str` | required | FsRecord ID; used as the entity `uname` for idempotent lookup |
| `operation` | `SyncOperation` | required | One of `create`, `update`, `delete`, `event`, `invoke`, `log` |
| `ref_type` | `RefType` | `"data"` | `"data"` or `"path"` |
| `data` | `dict` | `{}` | Payload fields; merged with `id` for CRUD operations |
| `execution_scope` | `list[ExecutionScopeEntry]` | `[]` | List of `{type, id}` references to source AgenticProcess entities |

### SyncOperation Values

| Value | Meaning |
|-------|---------|
| `create` | Create a new entity |
| `update` | Update an existing entity |
| `delete` | Delete an existing entity |
| `event` | Named event (requires `event_name` in `data`) |
| `invoke` | Invocation-style operation (task reflection) |
| `log` | Log entry; acknowledged and discarded |

### Valid Entity Types (RecordType)

`task`, `skill`, `log`, `rule`, `agentic_process`, `memo`, `session_analysis`

> **Note**: Entity type validation is **skipped** for `INVOKE` and `LOG` operations — those operations accept any string for `type`.

### Valid Relationship Types (RelationshipType)

`child`, `parent`, `depends_on`, `related_to`

Only `child` relationships are actively handled (CREATE/DELETE via `attach_child`/`remove_child`). All other relationship types return `ApiSuccessResponse` with a `warning` field and no database operation is performed.

### agent_hook

`agent_hook` carries Claude CLI hook events (pre-tool, post-tool, session lifecycle, etc.) targeted at a specific `AgentHook` entity. It does not perform entity CRUD. The target hook entity is looked up by `agent_hook_id`, then its `handle_webhook` method is called, and a `flow_data` message is emitted to the hook entity's watchers.

Parsed model: `AgentHookData`

| Field | Type | Description |
|-------|------|-------------|
| `webhook_type` | `"agent_hook"` | Literal discriminator |
| `agent_hook_id` | `str` or `None` | ID of the target AgentHook entity |
| `hook_data` | `dict` | Raw hook payload from the CLI |
| `hook_entry_id` | `str` or `None` | Optional identifier for the hook entry |
| `hook_metadata` | `dict` or `None` | Optional metadata |
| `hook_file_path` | `str` or `None` | Path of the hook file that fired |

### agent_hook Enrichment and Side Effects

Before `AgentHookData` model construction, `listen_action` applies enrichment and tracks state:

**Skill usage count enrichment**: When `tool_name == "Skill"` in the hook data, the skill's absolute usage count is read from `~/.claude.json` via `get_legacy_settings()` and injected as `hook_data_dict["skill_usage_count"]`. This mutates `raw_payload["hook_data"]` in place so both `_broadcast_to_sniffer` and `handle_agent_hook` see the enriched value. Non-critical — failures are silently ignored.

**Write path tracking**: A module-level `_last_write_path_by_session` dict caches the most recent `PostToolUse:Write` file path per session. When a `PostToolUse` event arrives with `tool_name == "Write"`, the `file_path` from `tool_input` is stored keyed by `session_id`. This cached path is consumed by the plan annotation side effect below.

**Annotation auto-creation**: `handle_agent_hook` creates `Annotation` entities for two event types:

1. **`UserPromptSubmit`**: Creates an annotation with label `"prompt:"`, content truncated to 50 chars, linked to the `AgenticProcess` matching the session's `worker_session_id`.

2. **`PreToolUse:ExitPlanMode`**: Creates an annotation with label `"plan:"`. If the previously cached Write path (from `_last_write_path_by_session`) points to a `.claude/plans/*.md` file, it is included as `data.file_path` in the annotation. The cached path is consumed (popped) on use.

Both annotation creation paths are non-critical — failures are caught and logged at DEBUG level.

## handle_hook_op: CRUD Dispatch

**Function:** `handle_hook_op(sync_payload: HookOpPayload)`

```
operation == EVENT   -> _handle_hook_op_event()
operation == INVOKE  -> _handle_hook_op_invoke()
operation == LOG     -> acknowledge and return
is_relationship      -> _handle_relationship_sync()
operation in (CREATE, UPDATE, DELETE) -> _reflect_entity()
                                          + _broadcast_to_sniffer()
```

For CRUD operations, the id from the payload is merged into the data dict before calling `_reflect_entity`:

```python
payload = {**sync_payload.data, "id": sync_payload.id}
result, warning = await _reflect_entity(record_type, operation, payload)
```

After `_reflect_entity` returns, `_broadcast_to_sniffer` is called with the CRUD metadata and any warning or error message.

## _reflect_entity

**Function:** `_reflect_entity(record_type, operation, payload) -> (response, warning)`

This function creates, updates, or deletes any registered entity type from a `hook_op` payload. The FsRecord `id` field is used as the entity `uname` for idempotent lookup — the same record always maps to the same entity regardless of how many times the event is received.

### CREATE

1. Look up `payload["id"]` in `type_registry` to get the entity class.
2. Call `entity_cls.get_by_uname(external_id)`.
   - If the entity already exists: log a warning, apply non-system fields, `save()`, return `"updated"`.
   - If not found: construct `entity_cls(uname=external_id, **init_fields)`.
3. Fetch `@local` project via `get_desktop_project()`.
4. Call `entity.save(project)` to persist with project scope. This is important: project-scoped saves ensure that project-scoped frontend queries can find the new entity, and that `DataOp` notifications reach the correct `WatchedQuery` listeners.
5. Call `project.attach_child(entity.typeid)` to register the entity as a child of the `@local` project.
6. Return `ApiSuccessResponse(data={"{type}_id": entity.id, "action": "created"})`.

### UPDATE

1. Call `entity_cls.get_by_uname(external_id)`.
   - If not found: return `(None, warning)`. The caller acknowledges without error.
2. Call `_apply_entity_fields(existing, payload)` to copy non-system fields.
3. Call `existing.save()`.
4. Call `existing.notify_updated()` if the method exists (not all entity types implement it).
5. For `task` entities with `task_type == "skill_creation"`, copy analysis files to the skill's `references/` subfolder.
6. Return `ApiSuccessResponse(data={"{type}_id": existing.id, "action": "updated"})`.

### DELETE

1. Call `entity_cls.get_by_uname(external_id)`.
   - If not found: return `(None, warning)`.
2. Call `entity_cls.delete_by_id(existing.id)`.
3. Return `ApiSuccessResponse(data={"{type}_id": existing.id, "action": "deleted"})`.

### FTS Index Gap

`_reflect_entity` calls `entity.save()` but does **not** call `Record.sync_to_db()` or `driver.fts_upsert()`. This means entities created or updated via the listen webhook are persisted to the SQLite `entities` table and broadcast to the frontend via `DataOpMessage`, but they are **not** added to the FTS5 full-text search index. To make webhook-created entities searchable, a manual reindex is required (`POST /api/v1/search/reindex`).

This is one of three parallel entity creation paths in the system:
1. **`Record.sync_to_db()`** (fs_store layer): creates Entity + FTS entry. Used by `_broadcast_fs_record_op()` after filesystem CRUD.
2. **`_reflect_entity()`** (listen webhook): creates Entity only, no FTS entry. Used by external agents via `POST /api/v1/webhook/listen`.
3. **`flow_entity_crud`** (MCP tool): delegates to the separate `plugin_records` subsystem, does not touch the core Entity model or FTS index at all.

### System Fields Protected from External Sync

These fields are never overwritten by `_apply_entity_fields`:

```
id, type, created_by, created_date, updated_by, updated_date,
created_through, updated_through, schema_version, namespace,
key, uname, expand
```

## _broadcast_to_sniffer

**Function:** `_broadcast_to_sniffer(payload_data, webhook_type, skip_hook_id, warning, element_type, data_type)`

Emits a `flow_data` event to the global `@sniffer` `AgentHook` so the global sniffer panel can display incoming webhook events.

Behavior:
1. Load the `AgentHook` entity with `uname == "sniffer"`. If not found, attempt a fallback lookup via `hooks_sniffer._get_sniffer_hook()` (legacy compatibility). If still not found, return silently.
2. If `skip_hook_id` matches the sniffer hook's id, skip emission (avoids double-emitting when the webhook itself targets the sniffer hook).
3. Convert the webhook payload to canonical `FlowData` using `convert_webhook_event()`.
4. Call `sniffer_hook.emit_flow_data({flow_value: fd.flow_value, attributes: fd.attributes})`.

> **Double-broadcast for CRUD operations**: For `hook_op` CRUD events, `_broadcast_to_sniffer` is called **twice**: once in `listen_action` with the full raw webhook payload, and once inside `handle_hook_op` after `_reflect_entity` returns, with a minimal `{webhook_type, type, operation, id}` summary dict that includes any warning or error message. The sniffer therefore receives two `flow_data` entries per CRUD event.

Failures in this function are non-critical and logged at DEBUG level.

## _route_to_source_process

**Function:** `_route_to_source_process(payload_data, execution_scope, session_id)`

Routes a copy of the webhook event to the `AgenticProcess` that generated it, so it appears in the process's `flowDataStream` and can be rendered by the terminal TraceGutter.

A `flow_data_msg` is constructed:

```python
flow_msg = {
    "element_type": "webhook",
    "data_type": "object",
    "flow_value": payload_data,
    "attributes": {"t": now_iso},
}
```

Routing priority:
1. **execution_scope** (hook_op): for each `{type, id}` entry, call `_send_flow_data_message(type, id, flow_msg)`.
2. **session_id** (agent_hook): query `AgenticProcess` by `worker_session_id == session_id`.
3. **Fallback**: if neither matched, extract `pty_pid` from `payload_data` and query `AgenticProcess` by `pty_pid`.

## DataOpMessage

### Python Definition

**File:** `/Users/shlom/Documents/dev/flow-cli/flow_sdk/core/network/resource_tracker.py`

```python
class DataOpMessage:
    def __init__(self, op: str, to_entity, data: Optional[dict] = None, message_id: Optional[str] = None):
        self.message_type = "data_op_msg"
        self.message_id = message_id or str(uuid4())
        self.op = op
        # to_entity: TypeId or string, normalized to "type-id" format
        self.to_entity = f"{to_entity.type}-{to_entity.id}"  # if TypeId
        self.data = data
```

Serialized wire format (`to_dict()`):

```json
{
  "message_type": "data_op_msg",
  "message_id": "<uuid>",
  "op": "create" | "update" | "delete",
  "to_entity": "<type>-<id>",
  "data": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message_type` | `"data_op_msg"` | Fixed discriminator, matches `WSMessageType.DATA_OP_MSG` |
| `message_id` | `str` | UUID for the message |
| `op` | `str` | `"create"`, `"update"`, or `"delete"` |
| `to_entity` | `str` | `"{entity_type}-{entity_id}"` in hyphen-separated TypeId format |
| `data` | `dict` or `None` | Entity data dict (omitted for delete) |

There is also a Pydantic version defined in `flow_sdk/api/messages.py` (`DataOpMessage` extends `EntityMessage` which extends `BaseMessage`) used in contexts where Pydantic model validation is needed. The `resource_tracker.py` version is a plain class used inside the notification path to avoid circular imports.

### WSMessageType Enum

**File:** `/Users/shlom/Documents/dev/flow-cli/flow_sdk/api/messages.py`

| Value | String | Purpose |
|-------|--------|---------|
| `DATA_OP_MSG` | `"data_op_msg"` | Entity CRUD notification |
| `FLOW_DATA_MSG` | `"flow_data_msg"` | Streaming FlowData from entities |
| `ENTITY_MSG` | `"entity_msg"` | Entity-scoped message forwarding |
| `REST_API_MSG` | `"rest_api_msg"` | REST API call over WebSocket |
| `RESPONSE_MSG` | `"response_msg"` | Response to a request message |
| `STREAM_MSG` | `"stream_msg"` | Binary stream (msgpack) |
| `TRANSCRIPT` | `"transcript_msg"` | Text transcript stream |
| `EXE_MSG` | `"exe_msg"` | Command execution |
| `CONTROL_MSG` | `"control_msg"` | Control signals |
| `PTY_OUTPUT_MSG` | `"pty_output_msg"` | PTY terminal output |
| `PTY_SESSION_STATUS_MSG` | `"pty_session_status_msg"` | PTY session state |
| `LLM_CONFIG_MSG` | `"llm_config_msg"` | LLM credential change notification |
| `OAUTH_MSG` | `"oauth_msg"` | OAuth flow message |
| `PING` / `PONG` | `"ping"` / `"pong"` | Keepalive |
| `ECHO` | `"echo"` | Debug echo |
| `HANGUP` | `"hangup"` | Client disconnect request |
| `CMD_STATUS_MSG` | `"cmd_status_msg"` | Command execution status |
| `CLIENT_NODE_READY_MSG` | `"client_node_ready_msg"` | Compute node ready signal |

## resource_tracker: _sync_handle_entity_op

**File:** `/Users/shlom/Documents/dev/flow-cli/flow_sdk/core/network/resource_tracker.py`

`_sync_handle_entity_op` is the synchronous function called from the database layer after every `entity.save()` or `entity.delete_by_id()`. It is synchronous because the database layer may not be running inside an async context, but it uses `asyncio.get_running_loop().create_task()` to schedule the actual WebSocket sends on the existing event loop.

```python
def _sync_handle_entity_op(op_message: DataOpMessage):
    active_connections = get_all_connections()   # from connections.py registry
    message = _to_message_dict(op_message)       # serialize to plain dict
    op = message.get("op").lower()
    entity_type, entity_id, type_id = _extract_entity_parts(message.get("to_entity"))
    message["to_entity"] = type_id               # normalize to "type-id" format

    recipients = _resolve_recipients(op, entity_type, entity_id, active_connections)

    # DELETE: prepend a flow_data_msg notification before the data_op_msg
    payloads = []
    if op == "delete" and type_id:
        payloads.append(_build_delete_flow_data_msg(type_id, entity_id))
    payloads.append(message)

    for conn_id in recipients:
        ws = active_connections[conn_id]
        loop.create_task(_send_payloads(ws, payloads))
```

### Recipient Resolution Algorithm

**Function:** `_resolve_recipients(op, entity_type, entity_id, active_connections)`

| Condition | Recipients |
|-----------|-----------|
| `op == "create"` | All active connections |
| `op == "update"` or `op == "delete"`, explicit watchers exist | Only connections in `watch_registry.get_watched_by("{type}:{id}")` that are active |
| `op == "update"`, no explicit watchers | All active connections (webhook fallback for desktop mode) |
| `op == "delete"`, no explicit watchers | Empty set (no fallback for delete) |

The "no explicit watchers" fallback for UPDATE is specifically to handle webhook-originated entity updates where there is no user session and no watch has been explicitly registered. In desktop mode (single user), broadcasting to all connections is safe. DELETE has no equivalent fallback because spurious delete notifications to unrelated components would cause incorrect cache invalidation.

### Connection Registry

**File:** `/Users/shlom/Documents/dev/flow-cli/flow_sdk/core/network/connections.py`

`ConnectionRegistry` is a module-level singleton (`_registry`) holding a `dict[str, WebSocket]`. The websocket route calls `add_connection(connection_id, websocket)` on accept and `remove_connection(connection_id)` on disconnect. `_sync_handle_entity_op` calls `get_all_connections()` to read a snapshot of all active sockets.

### Watch Registry

**File:** `/Users/shlom/Documents/dev/flow-cli/flow_sdk/app/actions/watch_registry.py`

`_watched_entities: Dict[str, Set[str]]` maps each `connection_id` to the set of `"{type}:{id}"` keys it is watching. The TypeScript frontend registers watches by calling `create_watch` via the REST API. `get_watched_by("{type}:{id}")` iterates all connections and returns those whose watch set contains the given key.

## WebSocket Route

**File:** `/Users/shlom/Documents/dev/flow-cli/server/routes/websocket.py`

```
URL: /api/v1/connect/ws/{connection_id}
```

Connection lifecycle:
1. `websocket.accept()` — upgrades the HTTP connection.
2. `_active_connections[connection_id] = websocket` — registers locally.
3. `add_registry_connection(connection_id, websocket)` — registers in the SDK's `ConnectionRegistry`.
4. Sends a `response_msg` confirmation to the client.
5. Receive loop: routes messages by `message_type`.
6. On disconnect: removes from `_active_connections`, `ConnectionRegistry`, and `watch_registry`.

The module also registers an `_minihub_connection_lookup` function with `set_external_connection_lookup`, which allows the SDK's `connection_manager` module to resolve connection IDs to `ConnectionHandler`-compatible wrappers without importing the server module.

### Inbound Message Types Handled

| `message_type` | Behavior |
|----------------|----------|
| `echo` | Returns the same message with a new `message_id` |
| `ping` | Returns a `pong` |
| `broadcast` | Sends to all connected clients |
| `hangup` | Closes the connection |
| `rest_api_msg` | Delegates to `handle_rest_message` (WebSocket-tunneled REST API) |
| `oauth_msg` | Logged; no multi-user coordination needed in desktop mode |
| `entity_msg` | Forwarded to all watchers of the target entity |

`data_op_msg` and `flow_data_msg` are server-to-client only. The server never receives them from clients.

## TypeScript Side

### ConnectionManager

**File:** `/Users/shlom/Documents/dev/flow-cli/ts_sdk/src/websocket.ts`

`ConnectionManager` is a singleton `EventEmitter`. It connects to `/api/v1/connect/ws/{uuid}` on initialization and dispatches incoming JSON messages by `message_type`.

```typescript
onMessage(data: BaseMessage) {
    if (data.message_type === 'data_op_msg') {
        return this.onDataOpMessage(data as DataOpMessage);
    }
    // ... other types
}

onDataOpMessage(data: DataOpMessage) {
    const typeId = this.parseTypeId(data.to_entity);
    this.emit('on_data_op', typeId, data.op, data.data);
}
```

`parseTypeId` handles both the `"type-id"` hyphen format (current) and the legacy `"type:id"` colon format. The parsed `TypeId` is a structured `{type, id}` object.

Reconnection: on unexpected close, `ConnectionManager` reconnects with exponential backoff (base 500ms, max 10s, up to 10 attempts, with jitter).

### FlowSyncStore.onDataOp

**File:** `/Users/shlom/Documents/dev/flow-cli/ts_sdk/src/FlowSync/store.ts`

`DataManager` (the actual class name; the spec previously called this `FlowSyncStore`) registers `this.onDataOp` on the `on_data_op` event in the constructor via `attach_connection_manager()`:

```typescript
// In attach_connection_manager():
manager.on('on_data_op', this.onDataOp.bind(this));
```

The handler:

```typescript
private onDataOp(typeId: TypeId, op: DataOpType, data: IEntity) {
    if (op !== 'delete' && (!data || !('id' in data))) return;

    const ctor = EntityFactory.getEntityConstructor(typeId.type);
    if (!ctor) return;

    if (op === 'delete') {
        this.watchedQueries.removeEntityFromResults(typeId.type, typeId);
    } else {
        // For create/update: find all WatchedQueries for this type,
        // re-run the query if the new data matches the filter, update results
        const watchedQueries = this.watchedQueries.getWatchCallbacksByType(typeId.type);
        for (const watchedQuery of watchedQueries) {
            if (!watchedQuery.request.query || watchedQuery.request.query.validate(data)) {
                void this._query(watchedQuery.request).then((queryResult) => {
                    watchedQuery.updateResults(queryResult);
                });
            }
        }
    }

    switch (op) {
        case 'create': {
            const ref = this.getRef(typeId);
            ref.entity = this.castAndDeepAssign(data);
            ref.status = EntityStatus.READY;
            this.subscriptions.get(typeId)?.forEach((cb) => void cb(ref.entity));
            break;
        }
        case 'update': {
            // If TypeId is not in cache at all, return silently.
            // If it IS in cache but entity is null, throws an error.
            if (!this.hasRef(typeId)) return;
            const ref = this.getRef(typeId);
            if (!ref.entity) {
                throw new Error('Entity not found in cache on data op update');
            }
            ref.entity = this.castAndDeepAssign(data);
            ref.status = EntityStatus.READY;
            this.subscriptions.get(typeId)?.forEach((cb) => void cb(ref.entity));
            break;
        }
        case 'delete': {
            this.entities.delete(typeId);
            this.subscriptions.get(typeId)?.forEach((cb) => void cb(null));
            break;
        }
    }
}
```

> **Note**: The UPDATE path throws `Error('Entity not found in cache on data op update')` when a ref exists but its entity is null. This can happen for webhook-originated updates where the frontend has a ref but the entity load failed. This is an unhandled error path.

Two parallel update paths run for every event:

1. **WatchQueryMap path** (list queries): All `WatchedQuery` instances for the entity type are checked. If the incoming entity data passes the query's filter, the full query is re-run via HTTP and the cached results are replaced. All callbacks registered on that `WatchedQuery` are then invoked with the new list.

2. **SubscriptionMap path** (single entity): Subscribers registered for this specific `TypeId` are called directly with the new entity or `null` (delete).

### FsRecordDataOpHandler

**File:** `/Users/shlom/Documents/dev/flow-cli/ts_sdk/src/resource_management/fs_records/data-op-handler.ts`

A second, parallel listener handles `data_op_msg` events for FsRecord types (file-system record types registered in `fsRecordTypeRegistry`). It attaches to the `on_data_op` event on `ConnectionManager` (not the store):

```typescript
cm.on('on_data_op', (toEntity: string, op: string, data?: Record<string, unknown>) => {
    handleDataOp(toEntity, op, data);
});
```

> **Note**: The `on_data_op` event actually passes a `TypeId` object as the first argument (see `ConnectionManager.onDataOpMessage`), not a raw string. The handler's TypeScript signature declares `string` but receives a `TypeId`. At runtime, `TypeId.toString()` returns `"type-id"` format, so `indexOf('-')` inside `handleDataOp` works by implicit coercion.

`handleDataOp` parses the `recordType` from the `to_entity` prefix, checks it against the `fsRecordTypeRegistry`, and dispatches to:
- **Type-specific subscribers** (`_subscribers` map keyed by `recordType`)
- **Source-file subscribers** (`_sourceFileSubscribers` map keyed by `_source_file` in the data payload)
- **Wildcard subscribers** (`_wildcardSubscribers` set)

Subscription API:

```typescript
// Subscribe to a specific record type
const unsub = subscribeFsRecord('task', (event: FsDataOpEvent) => { ... });

// Subscribe to all fs-record types
const unsub = subscribeFsRecordAll((event: FsDataOpEvent) => { ... });

// Subscribe to events from a specific source file
const unsub = subscribeFsRecordByFile('/path/to/file', (event: FsDataOpEvent) => { ... });
```

`FsDataOpEvent` fields:

| Field | Type | Description |
|-------|------|-------------|
| `recordType` | `string` | Entity type prefix from `to_entity` |
| `id` | `string` | Entity ID suffix from `to_entity` |
| `op` | `"create" \| "update" \| "delete"` | Operation type |
| `data` | `Partial<FsRecordData>` or `undefined` | Entity data payload |
| `sourceFile` | `string` or `undefined` | Value of `data._source_file` if present |

## End-to-End Flow

The following steps trace a single `hook_op` CREATE event from the CLI to the frontend:

1. **CLI posts webhook.** An external agent sends:
   ```
   POST /api/v1/webhook/listen
   {
     "webhook_type": "hook_op",
     "webhook_payload": {
       "resource_type": "entity",
       "type": "task",
       "id": "my-task-123",
       "operation": "create",
       "data": {"title": "My Task", "status": "pending"},
       "execution_scope": [{"type": "agentic_process", "id": "proc-456"}]
     }
   }
   ```

2. **listen_action parses.** `WebhookPayload` and `HookOpPayload` are validated. If validation fails, `ApiFailResponse` is returned immediately.

3. **Sniffer broadcast.** `_broadcast_to_sniffer` emits a `flow_data` event to the global `@sniffer` `AgentHook`. The global sniffer panel receives this stream.

4. **Source process routing.** `_route_to_source_process` sends a `flow_data_msg` to `agentic_process-proc-456` via `_send_flow_data_message`. The terminal TraceGutter receives this through that process's `flowDataStream`.

5. **handle_hook_op dispatches.** Operation is `create`, resource is entity; calls `_reflect_entity("task", CREATE, {"id": "my-task-123", "title": "My Task", "status": "pending"})`.

6. **_reflect_entity creates the entity.**
   - `type_registry.get("task")` returns the `Task` entity class.
   - `Task.get_by_uname("my-task-123")` returns `None` (new entity).
   - Constructs `Task(uname="my-task-123", title="My Task", status="pending")`.
   - Calls `entity.save(project)` with the `@local` project as scope.
   - Calls `project.attach_child(entity.typeid)`.

7. **entity.save triggers notification.** The database layer calls `handle_entity_op(DataOpMessage(op="create", to_entity=task.typeid, data=task.to_dict()))`.

8. **_sync_handle_entity_op broadcasts.** Operation is `create`; `_resolve_recipients` returns all active connections. A `data_op_msg` is scheduled via `loop.create_task` to every active WebSocket.

9. **Wire message.** Each frontend WebSocket connection receives:
   ```json
   {
     "message_type": "data_op_msg",
     "message_id": "<uuid>",
     "op": "create",
     "to_entity": "task-<new-entity-id>",
     "data": {"id": "<id>", "type": "task", "title": "My Task", ...}
   }
   ```

10. **ConnectionManager.onDataOpMessage.** Parses `to_entity` into `TypeId("task", "<id>")`, emits `on_data_op(typeId, "create", data)`.

11. **FlowSyncStore.onDataOp.**
    - Finds all `WatchedQuery` instances for type `"task"`.
    - For each: if `data` passes the query filter (or filter is absent), re-runs the query via HTTP and updates `watchedQuery.results`, calling all registered callbacks.
    - Creates a ref for the new entity and notifies any direct `TypeId` subscribers.

12. **FsRecordDataOpHandler.** If `"task"` is registered in `fsRecordTypeRegistry`, dispatches to type-specific and wildcard subscribers.

13. **React components re-render.** Callbacks registered via `watchedQuery.addCallback` (typically from hooks like `useEntities`) receive the updated list and trigger component re-renders showing the new task.
