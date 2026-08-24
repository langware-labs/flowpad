---
id: 28abc670-8cbb-52ac-8e4f-c249bebdbeb2
---

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
    ConnectionManager.onDataOpMessage() -> emit('on_data_op', "type-id", op, data)
         |
    DataManager.onDataOp()  +  FsRecordDataOpHandler.handleDataOp()
         |
    WatchedQuery re-run / alias-subscriber callbacks
```

> The first arg of the `on_data_op` event is the `"type-id"` **string** form, not a `TypeId` object. Both `DataManager` (`FlowSync/store.ts`) and `FsRecordDataOpHandler` subscribe to it.

## Route Registration

The webhook endpoint is registered in `flow_sdk/server/routes/webhook.py` as a plain FastAPI route:

```python
webhook_router = APIRouter(prefix="/api/v1/webhook")

@webhook_router.post("/listen")
async def listen_endpoint(request: Request):
    from flow_sdk.app.actions.listen import listen_action
    return await listen_action(request)
```

`listen_action` is deliberately **not** decorated with `@action.all`. The graph catch-all route calls `request.json()` during dispatch; a second call to `request.json()` inside the action would hang because the ASGI receive channel is one-shot. The webhook router calls `listen_action` directly, bypassing the graph route entirely.

## listen_action Entry Point

**File:** `flow_sdk/app/actions/listen.py`

```python
async def listen_action(request):
    json_data = await request.json()
    envelope = WebhookPayload(**json_data)  # validates webhook_type + webhook_payload
    webhook_type = envelope.webhook_type
    raw_payload = envelope.webhook_payload

    if webhook_type == WebhookType.HOOK_OP:
        sync_payload = HookOpPayload(**raw_payload)
        flow_value = {"webhook_type": "hook_op", **raw_payload}
        await _route_to_source_process(flow_value, execution_scope=sync_payload.execution_scope)
        return await handle_hook_op(sync_payload)
        # NOTE: the sniffer broadcast for hook_op happens INSIDE handle_hook_op,
        # not here. listen_action does NOT call _broadcast_to_sniffer for hook_op.

    if webhook_type == WebhookType.AGENT_HOOK:
        data = AgentHookData(**raw_payload)
        payload_data = {"webhook_type": "agent_hook", **raw_payload}
        skip_hook_id = raw_payload.get("agent_hook_id")
        await _broadcast_to_sniffer(payload_data, "agent_hook", skip_hook_id=skip_hook_id)
        # NOTE: global hooks are NOT routed to a source process — see
        # "agent_hook Side Effects" below.
        return await handle_agent_hook(data)
```

> **No skill-usage-count enrichment.** Earlier revisions of this doc described a
> step that read the skill's usage count from `~/.claude.json` and injected
> `hook_data_dict["skill_usage_count"]` before building `AgentHookData`. That
> enrichment does **not** exist in the current code — there is only a stale
> leftover comment in `listen_action`'s `AGENT_HOOK` branch. No `skill_usage_count`
> field is ever written and `get_legacy_settings()` is not called.

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

`hook_op` is the unified envelope for all entity CRUD, events, invocations, and log entries. It is the primary mechanism for syncing state from external agents (Claude CLI, background workers) into the flowpad database and broadcasting changes to the frontend.

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

Defined in `RecordType` in `flow_sdk/core/flow/models/hook_op.py`:

`task`, `skill`, `log`, `rule`, `agentic_process`, `bookmark`, `session_analysis`, `conversation`, `flow_message`, `invitation`

> This `RecordType` enum is the webhook-payload allowlist and is **separate** from the
> filesystem `RecordType` in `flow_sdk/fs_store/record_types.py`.

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
| `process_entry` | `dict` or `None` | Typed conversational payload synthesized from `hook_data` (Phase 9) |

### agent_hook Side Effects

`handle_agent_hook` resolves the hook fields (`hook_event_name`, `session_id`, `cwd`) up-front — before loading the `AgentHook` entity — so a `CwdChanged` is still logged when the hook entity no longer exists. Beyond that it does two things: run the connected triggers (`AgentHook.handle_webhook`) and emit the converted `FlowData` to the hook entity's own watchers.

**No process resolution.** A global hook is harness-wide: `handle_agent_hook` never looks up the `AgenticProcess` that fired it, and never writes per-process state. That bridge — prompt annotations, ExitPlanMode auto-approve, ExitWorktree tab close, per-process FlowData fan-out — was removed; process-scoped delivery belongs to `handle_process_agent_hook` and the per-process hook plugin (`--process-id`). `tests/api/test_global_hook_has_no_process_bridge.py` pins this.

Consequently no hook event carries `--wait-for-response` any more: nothing on this tier produces a `hookSpecificOutput` decision, so every global hook is fire-and-forget.

## handle_hook_op: CRUD Dispatch

**Function:** `handle_hook_op(sync_payload: HookOpPayload)`

```
operation == EVENT   -> _handle_hook_op_event()   + _broadcast_to_sniffer()
operation == INVOKE  -> _handle_hook_op_invoke()   + _broadcast_to_sniffer()
operation == LOG     -> acknowledge and return     (no sniffer broadcast)
is_relationship      -> _handle_relationship_sync()
operation in (CREATE, UPDATE, DELETE) -> _reflect_entity()
                                          + _broadcast_to_sniffer()
```

The dispatch order matters: EVENT, INVOKE, and LOG are checked **before** the `is_relationship` branch, so a relationship payload only reaches `_handle_relationship_sync` for non-event/invoke/log operations (i.e. CREATE/UPDATE/DELETE edges).

For CRUD operations, the id from the payload is merged into the data dict before calling `_reflect_entity`:

```python
payload = {**sync_payload.data, "id": sync_payload.id}
result, warning = await _reflect_entity(record_type, operation, payload)
```

After `_reflect_entity` returns, `_broadcast_to_sniffer` is called with the CRUD metadata and any warning or error message.

## _reflect_entity

**Function:** `_reflect_entity(record_type, operation, payload) -> (response, warning)`

This function creates, updates, or deletes any registered entity type from a `hook_op` payload. The FsRecord `id` field is used as the entity `uname` for idempotent lookup — the same record always maps to the same entity regardless of how many times the event is received.

The entity class is resolved via `SchemaRegistry.get_entity_cls(record_type)` (not a `type_registry`). If the type is unregistered, `_reflect_entity` returns a success response carrying a `warning` and performs no DB op.

### CREATE

1. `entity_cls.get_one({"id": external_id})` — **id-collision noop guard.** If a row with this exact `id` already exists locally, return `{action: "noop"}` immediately (this is how echoed-back webhooks for locally-originated entities are short-circuited).
2. `entity_cls.get_by_uname(external_id)`.
   - If found: set `warning = "CREATE with existing uname… treating as UPDATE"`, apply non-system fields, `save()`, return `{action: "updated"}`.
   - If not found: construct `entity_cls(uname=external_id, **init_fields)` (init_fields are payload keys that are valid model fields and not system fields).
3. Resolve the `@local` project via `get_desktop_project()`.
4. Call `entity.save(scope)` where `scope` is the project (or, if no project, the current request's user). This is important: project-scoped saves ensure that project-scoped frontend queries can find the new entity, and that `DataOp` notifications reach the correct `WatchedQuery` listeners.
5. If a project was resolved, call `project.attach_child(entity.typeid)` to register the entity as a child of the `@local` project. If no project, the entity is still saved but a warning is logged.
6. Return `ApiSuccessResponse(data={"{type}_id": entity.id, "action": "created"})`.

### UPDATE

1. Look up the existing entity by `get_one({"id": external_id})`, falling back to `get_by_uname(external_id)`.
   - If not found: return `(None, warning)`. The caller acknowledges without error.
2. Call `_apply_entity_fields(existing, payload)` to copy non-system fields.
3. Call `existing.save()`.
4. Call `existing.notify_updated()` inside a `try/except` (not all entity types implement it; any error is swallowed).
5. Return `ApiSuccessResponse(data={"{type}_id": existing.id, "action": "updated"})`.

> The previously-documented "skill_creation analysis file copy" step does **not** exist in `_reflect_entity`. The UPDATE branch has only a `task`-specific logging line, no file copy.

### DELETE

1. Call `entity_cls.get_by_uname(external_id)`.
   - If not found: return `(None, warning)`.
2. Call `entity_cls.delete_by_id(existing.id)`.
3. Return `ApiSuccessResponse(data={"{type}_id": existing.id, "action": "deleted"})`.

### FTS Index Gap

`_reflect_entity` calls `entity.save()` but does **not** call `Record.sync_to_db()` or `driver.fts_upsert()`. This means entities created or updated via the listen webhook are persisted to the SQLite `entities` table and broadcast to the frontend via `DataOpMessage`, but they are **not** added to the FTS5 full-text search index. To make webhook-created entities searchable, a manual reindex is required (the compute-node action `POST /fs-records/index` — the old `POST /api/v1/search/reindex` route no longer exists).

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
3. Convert the webhook payload to canonical `FlowData` using `convert_webhook_event()` (`flow_sdk/app/actions/_webhook_to_flowdata.py`); take `fds[0]`. The optional `element_type` / `data_type` / `warning` args are written onto `fd.attributes` as `element-type` / `data-type` / `warning`.
4. Call `sniffer_hook.emit_flow_data({"flow_value": fd.flow_value, "attributes": fd.attributes})`.

> **Per-webhook sniffer emission.** For `agent_hook`, `_broadcast_to_sniffer` is called once in `listen_action` (with `skip_hook_id`). For `hook_op`, `listen_action` does **not** call it; instead `handle_hook_op` calls `_broadcast_to_sniffer` once per dispatched op (EVENT / INVOKE / CRUD) with a minimal `{webhook_type, type, operation, id, …}` summary dict, attaching any `warning` or error message for CRUD. There is no double-broadcast of the full raw payload for `hook_op`.

Failures in this function are non-critical and logged at DEBUG level.

## _route_to_source_process

**Function:** `_route_to_source_process(payload_data, execution_scope)`

Routes a copy of a **`hook_op`** webhook event to the `AgenticProcess` that generated it, so it appears in the process's `flowDataStream` and can be rendered by the terminal TraceGutter.

Identity comes from `execution_scope` only — the worker's own `FLOWPAD_EXECUTION_SCOPE`, carried in the payload by the `flow` verb that sent it. `agent_hook` events are never routed here: they are harness-wide and carry no process identity.

The payload is **not** wrapped in a hand-built `{element_type: "webhook", ...}` dict. Instead it is translated through the shared `convert_webhook_event(payload_data)` dispatcher, and `flow_msg = fds[0].model_dump(mode="python")` is the canonical `FlowData` shape. If `convert_webhook_event` returns nothing, the function returns early.

Routing: for each `{type, id}` entry in `execution_scope`, call `_send_flow_data_message(type, id, flow_msg)`.

The former `session_id` and `pty_pid` lookups were the `agent_hook` → process bridge and are gone.

## DataOpMessage

### Python Definition

**File:** `flow_sdk/core/network/resource_tracker.py`

```python
class DataOpMessage:
    _counter: int = 0

    def __init__(self, op: str, to_entity, data: Optional[dict] = None, message_id: Optional[str] = None):
        DataOpMessage._counter += 1
        self.instance_id = DataOpMessage._counter
        self.message_type = "data_op_msg"
        self.message_id = message_id or str(uuid4())
        self.op = op
        # to_entity: TypeId or string. A string is kept as-is; a TypeId is
        # rendered as "type-id".
        if isinstance(to_entity, str):
            self.to_entity = to_entity
        else:
            self.to_entity = f"{to_entity.type}-{to_entity.id}"
        self.data = data
```

Serialized wire format (`to_dict()`):

```json
{
  "message_type": "data_op_msg",
  "message_id": "<uuid>",
  "instance_id": 42,
  "op": "create" | "update" | "delete",
  "to_entity": "<type>-<id>",
  "data": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message_type` | `"data_op_msg"` | Fixed discriminator, matches `WSMessageType.DATA_OP_MSG` |
| `message_id` | `str` | UUID for the message |
| `instance_id` | `int` | Monotonic per-process counter (debug ordering aid) |
| `op` | `str` | `"create"`, `"update"`, or `"delete"` |
| `to_entity` | `str` | `"{entity_type}-{entity_id}"` in hyphen-separated TypeId format |
| `data` | `dict` or `None` | Entity data dict (omitted when `None`, e.g. for delete) |

There is also a Pydantic version defined in `flow_sdk/api/messages.py` (`DataOpMessage` extends `EntityMessage` which extends `BaseMessage`; `EntityMessage.to_entity` is a `TypeId`) used in contexts where Pydantic model validation is needed. The `resource_tracker.py` version is a plain class used inside the notification path to avoid circular imports. `_to_message_dict` accepts a plain dict, any object with `model_dump()` (the Pydantic form), or any object with `to_dict()` (this plain form).

### WSMessageType Enum

**File:** `flow_sdk/api/messages.py`

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
| `HUB_CLIENT_ERROR_MSG` | `"hub_client_error_msg"` | Hub client error |
| `AUTH_EXPIRED_MSG` | `"auth_expired_msg"` | Auth/session expiry notification |
| `CLOUD_LOGIN_STATUS_MSG` | `"cloud_login_status_msg"` | Cloud login status |
| `CLOUD_CONNECTION_STATUS_MSG` | `"cloud_connection_status_msg"` | Cloud connection status |

> `WSMessageType` is a plain `Enum` (members carry string values), not a `StrEnum`. Consumers reference `WSMessageType.X.value`.

## resource_tracker: _sync_handle_entity_op

**File:** `flow_sdk/core/network/resource_tracker.py`

`_sync_handle_entity_op` is the synchronous function called from the database layer after every `entity.save()` or `entity.delete_by_id()`. It is synchronous because the database layer may not be running inside an async context, but it uses `asyncio.get_running_loop().create_task()` to schedule the actual WebSocket sends on the existing event loop. (If there is no running loop, it logs and returns without sending.)

```python
def _sync_handle_entity_op(op_message: DataOpMessage):
    active_connections = get_all_connections()   # from connections.py registry
    if not active_connections:
        return
    message = _to_message_dict(op_message)       # serialize to plain dict (excludes None)
    op = str(message.get("op", "")).lower()
    entity_type, entity_id, type_id = _extract_entity_parts(message.get("to_entity"))
    if type_id:
        message["to_entity"] = type_id           # normalize to "type-id" format

    # Explicit watchers always win, even for non-API-visible types.
    explicit_watchers = set()
    if entity_type and entity_id and op in ("update", "delete"):
        explicit_watchers = {c for c in get_watched_by(f"{entity_type}:{entity_id}")
                             if c in active_connections}

    # API-visibility gate: skip entirely for types that are not api-visible,
    # UNLESS an explicit watcher asked for this entity.
    if entity_type and not explicit_watchers:
        if not Entity.api_visible_by_type(entity_type):
            return

    recipients = _resolve_recipients(op, entity_type, entity_id, active_connections)
    if not recipients:
        return

    loop = asyncio.get_running_loop()  # returns early if none

    # DELETE: prepend a flow_data_msg notification before the data_op_msg
    payloads = []
    if op == "delete" and type_id and entity_id:
        payloads.append(_build_delete_flow_data_msg(type_id, entity_id))
    payloads.append(message)

    for conn_id in recipients:
        ws = active_connections.get(conn_id)
        loop.create_task(_send_payloads(ws, payloads))
```

> **API-visibility gate (not previously documented).** Before resolving recipients, `_sync_handle_entity_op` checks `Entity.api_visible_by_type(entity_type)`. For non-API-visible types (e.g. `agentic_process`, which is runtime-only and absent from the bootstrap schema set), the notification is **dropped entirely** — *unless* a UI connection has an explicit watch on this exact entity (an update/delete-only carve-out computed before the gate). Without this carve-out, a persistent-field change on a watched-but-non-api-visible entity (e.g. a `private_context_entities` cross-link on an `AgenticProcess`) would never reach the watching client and its cached copy would go stale.

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

**File:** `flow_sdk/core/network/connections.py`

`ConnectionRegistry` is a module-level singleton (`_registry`) holding a `dict[str, WebSocket]`. The websocket route calls `add_connection(connection_id, websocket)` on accept and `remove_connection(connection_id)` on disconnect. `_sync_handle_entity_op` calls `get_all_connections()` to read a snapshot of all active sockets.

### Watch Registry

**File:** `flow_sdk/app/actions/watch_registry.py`

`_watched_entities: Dict[str, Set[str]]` maps each `connection_id` to the set of `"{type}:{id}"` keys it is watching. The TypeScript frontend registers watches by calling `create_watch` via the REST API. `get_watched_by("{type}:{id}")` iterates all connections and returns those whose watch set contains the given key.

## WebSocket Route

**File:** `flow_sdk/server/routes/websocket.py`

```
URL: /api/v1/connect/ws/{connection_id}
```

Connection lifecycle:
1. `websocket.accept()` — upgrades the HTTP connection.
2. `_active_connections[connection_id] = ConnectionInfo(ws=websocket)` — registers locally. (`_active_connections` holds `ConnectionInfo` wrappers, not bare sockets; `get_active_connections()` unwraps them to `{cid: info.ws}`.)
3. `add_registry_connection(connection_id, websocket)` — registers in the SDK's `ConnectionRegistry`.
4. Sends a `response_msg` confirmation to the client.
5. Receive loop: routes messages by `message_type`.
6. On disconnect: removes from `_active_connections`, `ConnectionRegistry`, and calls `cleanup_connection` on `watch_registry`.

The module also registers an `_minihub_connection_lookup` function with `set_external_connection_lookup`, which allows the SDK's `connection_manager` module to resolve connection IDs to `ConnectionHandler`-compatible wrappers without importing the server module.

### Inbound Message Types Handled

| `message_type` | Behavior |
|----------------|----------|
| `echo` | Returns the same message with a new `message_id` |
| `ping` | Returns a `pong` |
| `broadcast` | Sends to all connected clients |
| `hangup` | Closes the connection |
| `rest_api_msg` | Delegates to `handle_rest_message` (WebSocket-tunneled REST API) |
| `oauth_msg` | Replies with a `response_msg`; no multi-user coordination needed in desktop mode |
| `entity_msg` | Forwarded to all watchers of the target entity |
| `browser_context` | Stored on the connection's `ConnectionInfo` |
| `presence` | Stored on the connection's `ConnectionInfo` |
| (unknown) | Replies with a `response_msg` carrying an `error` |

`data_op_msg` and `flow_data_msg` are server-to-client only. The server never receives them from clients.

## TypeScript Side

### ConnectionManager

**File:** `ts_sdk/src/websocket.ts`

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
    if (!typeId) return;
    // NOTE: emits the STRING form (typeId.toString()), not the TypeId object.
    this.emit('on_data_op', typeId.toString(), data.op, data.data);
}
```

`parseTypeId` handles both the `"type-id"` hyphen format (current) and the legacy `"type:id"` colon format, returning a structured `TypeId` (or `null`). The `on_data_op` event then carries the **string** form (`typeId.toString()`), so every listener receives a `"type-id"` string as the first argument.

Reconnection: on unexpected close, `ConnectionManager` reconnects with exponential backoff (base 500ms, capped at 10s) **indefinitely — there is no hard attempt cap** (`reconnect()` comment: "Retries indefinitely — no hard cap").

`CloudManager` consumes this connection differently by runtime mode. On the
desktop it seeds from `bootstrap.desktop_info`, listens for
`cloud_login_status_msg` / `cloud_connection_status_msg`, and resynchronizes
through `/cloud/status`. In Hub-only mode, `bootstrap.user` is already the
authoritative cloud identity, so those desktop bridge channels are not used;
`CloudManager` projects the existing `ConnectionManager.connectionSlot` and
its `connection_status_changed` event instead. This is a projection of the
same `/api/v1/connect/ws/{uuid}` connection, not a second Hub-specific socket
or protocol.

### FlowSyncStore.onDataOp

**File:** `ts_sdk/src/FlowSync/store.ts`

`DataManager` (the actual class name; the spec previously called this `FlowSyncStore`) registers `this.onDataOp` on the `on_data_op` event in the constructor via `attach_connection_manager()`:

```typescript
// In attach_connection_manager():
manager.on('on_data_op', this.onDataOp.bind(this));
```

The handler (first argument is a **string**, parsed into a `TypeId` internally):

```typescript
private onDataOp(typeIdStr: string, op: DataOpType, data: IEntity) {
    const typeId = new TypeId(typeIdStr);
    if (op !== 'delete' && (!data || !('id' in data))) return;

    const ctor = EntityFactory.getEntityConstructor(typeId.type);
    if (!ctor) return;

    // Query re-run gating: ALWAYS on create; on other ops only when
    // this.dataOpQueryInvalidation is enabled.
    if (op === 'delete') {
        this.watchedQueries.removeEntityFromResults(typeId.type, typeId);
    } else if (op === 'create' || this.dataOpQueryInvalidation) {
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
            const entity = this.castAndDeepAssign(data);
            this.register_new_entity(typeId, entity);
            this._notifyAllAliases(typeId, entity, entity);
            break;
        }
        case 'update': {
            if (!this.hasRef(typeId)) return;        // not cached → ignore
            const ref = this.getRef(typeId);
            if (!ref.entity) {
                // Fetch in flight → BUFFER the update; fetchByTypeId applies it later.
                ref.pendingUpdate = data;
                return;
            }
            ref.entity = this.castAndDeepAssign(data);
            ref.status = EntityStatus.READY;
            this._notifyAllAliases(typeId, ref.entity, ref.entity);
            break;
        }
        case 'delete': {
            const ref = this.entities.get(typeId);
            const entity = ref?.entity ?? null;
            this._deleteWithAliases(typeId);
            this._notifyAllAliases(typeId, entity, null);
            break;
        }
    }
    this.resolvePendingRequests();
}
```

> **Note (corrected)**: The UPDATE path no longer throws. Earlier revisions described an `Error('Entity not found in cache on data op update')` thrown when a ref existed but its entity was `null`. The current code instead **buffers** the update (`ref.pendingUpdate = data`) and returns, letting the in-flight `fetchByTypeId` apply it on completion. When the `TypeId` is not cached at all, it returns silently.

Two update concerns run per event:

1. **WatchedQuery path** (list queries): on `create` (always) or on `update`/etc. when `dataOpQueryInvalidation` is enabled, all `WatchedQuery` instances for the entity type are checked. If the incoming entity data passes the query's filter, the full query is re-run via HTTP and the cached results are replaced.

2. **Subscriber/alias path** (single entity): CREATE/UPDATE/DELETE notify subscribers through `_notifyAllAliases` (and register/delete the ref via `register_new_entity` / `_deleteWithAliases`) so alias keys stay consistent. Subscribers receive the new entity, or `null` on delete.

### FsRecordDataOpHandler

**File:** `ts_sdk/src/resource_management/fs_records/data-op-handler.ts`

A second, parallel listener handles `data_op_msg` events for FsRecord types (file-system record types registered in `fsRecordTypeRegistry`). It attaches to the `on_data_op` event on `ConnectionManager` (not the store):

```typescript
cm.on('on_data_op', (toEntity: string, op: string, data?: Record<string, unknown>) => {
    handleDataOp(toEntity, op, data);
});
```

> **Note**: The `on_data_op` event passes the **string** form of the TypeId as its first argument (`ConnectionManager.onDataOpMessage` emits `typeId.toString()`). The handler's `string` signature is therefore correct, and `toEntity.indexOf('-')` inside `handleDataOp` operates on a real string directly — no coercion involved.

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

2. **listen_action parses.** `WebhookPayload` and `HookOpPayload` are validated. If validation fails, `ApiFailResponse` is returned immediately (a `HookOpPayload` failure is also logged, then re-raised and surfaced as a fail response by the outer handler).

3. **Source process routing.** `_route_to_source_process(flow_value, execution_scope=…)` converts the payload via `convert_webhook_event` and sends the resulting `flow_data_msg` to `agentic_process-proc-456` via `_send_flow_data_message`. The terminal TraceGutter receives this through that process's `flowDataStream`. (For `hook_op`, there is no separate sniffer broadcast at this point — see step 5.)

4. **handle_hook_op dispatches.** Operation is `create`, resource is entity; calls `_reflect_entity("task", CREATE, {"id": "my-task-123", "title": "My Task", "status": "pending"})`.

5. **Sniffer broadcast.** After `_reflect_entity` returns, `handle_hook_op` calls `_broadcast_to_sniffer` once with a `{webhook_type, type, operation, id}` summary (plus any warning/error), emitting a `flow_data` event to the global `@sniffer` `AgentHook`.

6. **_reflect_entity creates the entity.**
   - `SchemaRegistry.get_entity_cls("task")` returns the `Task` entity class.
   - `Task.get_one({"id": "my-task-123"})` and then `Task.get_by_uname("my-task-123")` return `None` (new entity).
   - Constructs `Task(uname="my-task-123", title="My Task", status="pending")`.
   - Calls `entity.save(scope)` with the `@local` project as scope (or the request user as fallback).
   - If a project was resolved, calls `project.attach_child(entity.typeid)`.

7. **entity.save triggers notification.** The database layer calls `handle_entity_op(DataOpMessage(op="create", to_entity=task.typeid, data=task.to_dict()))`.

8. **_sync_handle_entity_op broadcasts.** The API-visibility gate is applied first: `task` is api-visible, so it passes (a non-api-visible type with no explicit watcher would be dropped here). Operation is `create`; `_resolve_recipients` returns all active connections. A `data_op_msg` is scheduled via `loop.create_task` to every active WebSocket.

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

10. **ConnectionManager.onDataOpMessage.** Parses `to_entity` into `TypeId("task", "<id>")`, then emits `on_data_op("task-<id>", "create", data)` — the first arg is the `toString()` **string**, not the object.

11. **DataManager.onDataOp.**
    - Reconstructs `new TypeId("task-<id>")`.
    - Since `op === "create"`, finds all `WatchedQuery` instances for type `"task"`; for each, if `data` passes the query filter (or filter is absent), re-runs the query via HTTP and updates results, calling all registered callbacks.
    - Registers the new entity ref (`register_new_entity`) and notifies subscribers via `_notifyAllAliases`.

12. **FsRecordDataOpHandler.** If `"task"` is registered in `fsRecordTypeRegistry`, dispatches to type-specific and wildcard subscribers.

13. **React components re-render.** Callbacks registered via `watchedQuery.addCallback` (typically from hooks like `useEntities`) receive the updated list and trigger component re-renders showing the new task.
