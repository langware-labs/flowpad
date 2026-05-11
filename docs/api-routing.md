# API Routing Specification

This document describes how HTTP requests are routed through the flow-cli system — from URL to action handler — covering both the Python backend and the TypeScript frontend.

## URL Structure

All graph API requests follow this pattern:

```
/api/v1/graph/{scope_type}/{scope_id}/.../{target_type}/{target_id}/{action}/{sub_path}
└── prefix ──┘ └────────── scope pairs ──────────────┘  └─ target ─┘
```

| Segment | Description |
|---------|-------------|
| **Prefix** | `/api/v1` + `/graph` — fixed, stripped during parsing |
| **Scope** | Zero or more `{type}/{id}` pairs forming a hierarchical context (parent entities) |
| **Target** | The final `{type}/{id}` pair — the entity being acted upon |
| **Direct resource type** | An entity type name without an ID — used for collection operations (list, create) |
| **Action** | The operation to perform (e.g. `fs`, `control`, `terminal-command`) |
| **Sub-path** | Everything after the action — passed to the handler as `sub_path` |

## Parsing Algorithm

`APIRequest.from_api_path()` in `flow_sdk/api/api_request.py:116` parses any graph URL:

1. Strip `/api/v1/graph` prefix.
2. Split remaining path into segments, pair them: `[(seg1, seg2), (seg3, seg4), ...]`.
3. Classify each pair: a pair is a **TypeId pair** if `seg1` is a registered entity type AND `seg2` is a valid identifier.
4. Consecutive TypeId pairs form the **scope**; the last TypeId pair becomes the **target**.
5. The first non-TypeId segment after scope/target is either:
   - A **direct_resource_type** (if it's a registered entity type) — for collection operations
   - An **action** (if it's a registered action name) — for custom operations
6. Remaining segments after the action become the **sub_path** (joined with `/`).

Validation: two consecutive entity types without an ID between them raise an error.

### Implicit Action Mapping

When no explicit action appears in the URL, the HTTP method determines the action (`flow_sdk/actions/action_registry.py:173`):

| HTTP Method | Implicit Action |
|-------------|-----------------|
| `POST` | `create` |
| `GET` | `read` |
| `PUT` | `update` |
| `PATCH` | `update` |
| `DELETE` | `delete` |

## URL Examples

| URL (after `/api/v1/graph`) | Scope | Target | Resource Type | Action | Sub-path |
|------------------------------|-------|--------|---------------|--------|----------|
| `/agent` | — | — | `agent` | `read` (implicit GET) | — |
| `/agent/@local` | — | `agent/@local` | — | `read` (implicit GET) | — |
| `/workspace/@local/agent` | — | `workspace/@local` | `agent` | `read` (implicit GET) | — |
| `/agent/@local/fs/browse/Users/shlom` | — | `agent/@local` | — | `fs` | `browse/Users/shlom` |
| `/compute_node/@local/terminal-command` | — | `compute_node/@local` | — | `terminal-command` | — |
| `/workspace/@local/agent/@local/control` | `workspace/@local` | `agent/@local` | — | `control` | — |
| `/agentic_process/{id}/state` | — | `agentic_process/{id}` | — | `state` | — |

## Request Flow

```
HTTP Request
  │
  ├─ Dedicated route match? ──→ Dedicated handler (auth, hooks, chat, etc.)
  │
  └─ No match ──→ RequestTransactionMiddleware
                    │
                    ├─ Parse URL → APIRequest → RequestInfo
                    │   (scope, target, action, sub_path)
                    │
                    ├─ Auto-auth (desktop: all requests → @local user, owner role)
                    │
                    └─ Graph catch-all route: /api/v1/graph/{path:path}
                         │
                         └─ handle_request()
                              │
                              ├─ Look up action in ActionManager
                              │   1. Try "{entity_type}.{action_name}" (entity-specific)
                              │   2. Fall back to "{action_name}" (global)
                              │
                              ├─ Introspect handler signature, inject parameters
                              │
                              └─ Call handler → ApiResponse
```

## RequestInfo

Built from the parsed `APIRequest` and enriched by middleware. Central object for the entire request lifecycle.

**Core fields** (`flow_sdk/request_context/request_info.py:26`):

| Field | Type | Description |
|-------|------|-------------|
| `target_entity_typeid` | `TypeId \| None` | Target entity [TypeId](./typeid.md) |
| `direct_resource_type` | `str \| None` | Collection entity type (no ID) |
| `scope` | `List[TypeId]` | Hierarchical scope (parent entities) |
| `parent_entity` | `TypeId \| None` | Last scope entity (immediate parent) |
| `action` | `str \| None` | Action name |
| `sub_path` | `str \| None` | Path segments after the action |
| `user` | `Any` | Authenticated user entity |
| `request_parameters` | `Dict[str, Any]` | Query params + form data |
| `expand_fields` | `List[str]` | Expansion flags from `?expand=` |

**Expansion flags** (from `?expand=permissions,blobs`):

| Flag | Description |
|------|-------------|
| `permissions` | Include role-based permissions |
| `auth_scopes` | Include auth scope data |
| `is_private` | Mark private entities |
| `blobs` | Include binary content |

## Action Registry

Global singleton: `action = ActionManager()` in `flow_sdk/actions/action_registry.py:166`.

### Registration Decorators

```python
@action.all(action_name="name", methods="all", types="all")     # Any HTTP method
@action.get(action_name="name")                                   # GET only
@action.post(action_name="name")                                  # POST only
@action.delete(action_name="name")                                # DELETE only
```

Parameters:
- `action_name` — the URL-level action identifier
- `methods` — `"all"` | `"get"` | `"post"` | `"delete"` | `["put", "patch"]`
- `types` — `"all"` | `"entityType"` | `["type1", "type2"]`

### Entity-Specific Actions

When a decorator is used inside an entity class, the action is registered with an entity-type prefix:

```python
class ComputeNode(Entity):
    type = "compute_node"

    @action.post("terminal-command")       # Registered as "compute_node.terminal-command"
    async def terminal_command(self, ...):
        ...
```

### Action Resolution

`get_by_name(name, entity_type)` in `action_registry.py:64`:

1. Try entity-specific key: `"{entity_type}.{name}"` (e.g. `compute_node.terminal-command`)
2. Fall back to global key: `"{name}"` (e.g. `read`, `create`, `fs`)
3. Return `None` if not found

This allows entities to **override** global actions (e.g. `AgenticProcessor` overrides `create`).

### Handler Parameter Injection

`handle_request()` in `flow_sdk/server/routes/graph.py:132` introspects the handler signature and injects parameters:

| Parameter | Source |
|-----------|--------|
| `self` | Target entity instance (fetched from DB via `request_info.get_target_entity()`) |
| `cls` | Entity model class (from type registry via `direct_resource_type`) |
| `request: Request` | FastAPI Request object |
| `response: Response` | FastAPI Response object |
| `background_tasks: BackgroundTasks` | FastAPI BackgroundTasks |
| Pydantic `BaseModel` annotation | Validated from JSON body + query params |
| Named parameter matching query/body key | Matched by parameter name from `request_parameters` or JSON body |

## CRUD Actions

Registered globally in `flow_sdk/app/actions/graph_crud_actions.py`. Apply to all entity types.

### read (GET)

```
GET /api/v1/graph/{type}             → List all of type (collection query)
GET /api/v1/graph/{type}/{id}        → Get single entity by ID
```

- Collection: uses `QueryFilter` from `?filter=` parameter
- Single: fetches entity, syncs linked FS Record if stale, expands requested fields

### create (POST)

```
POST /api/v1/graph/{type}                        → Create under user
POST /api/v1/graph/{parent_type}/{parent_id}/{type}  → Create as child of parent
```

- Validates body fields against entity model's API fields
- Sets ownership via `entity.save(someone_typeid)` or `target_entity.add_child(entity)`

### update (PUT/PATCH)

```
PUT /api/v1/graph/{type}/{id}   → Update entity fields
```

- Accepts partial data (only specified fields are updated)
- Filters out non-API fields with a warning

### delete (DELETE)

```
DELETE /api/v1/graph/{type}/{id}   → Delete entity
```

## Special Actions

### fs (Filesystem)

Registered globally as `@action.all(action_name="fs")` in `flow_sdk/actions/fs/main_fs_action.py:38`.

The `sub_path` is parsed into `{fs_action}/{entity_sub_path}`:

```
GET  /api/v1/graph/compute_node/@local/fs/browse/Users/shlom
                                        ── ────── ──────────
                                        action  fs_action  entity path
```

The `EntityFSReqInfo` class (`flow_sdk/api/fs/fs_api.py:163`) extracts:
- `fs_action` — first segment of sub_path (e.g. `browse`)
- `vpath` — VFSPath constructed from entity TypeId + remaining sub_path

See [VFS Specification](./vfs.md) for path format details.

**FS sub-actions:**

| Sub-action | Method | Description |
|------------|--------|-------------|
| `browse` | GET | List directory → `FSItem[]` |
| `download` | GET | Stream file content |
| `download_zip` | GET | Download directory as ZIP |
| `upload` | POST | Upload files (multipart) |
| `upload_zip` | POST | Upload and extract ZIP |
| `write` | POST | Write content to file |
| `mkdir` | POST | Create directory |
| `delete` | DELETE | Delete file/directory |
| `rename` | POST | Rename file/directory |
| `copy` | POST | Copy file/directory |
| `move` | POST | Move file/directory |
| `open` | GET | Open with system default app |
| `create_symlink` | POST | Create symbolic link |
| `resolve_symlink` | GET | Resolve symlink target |

### AgenticProcessor Actions

Entity-specific actions on `AgenticProcessor` (`flow_sdk/builtin/agentic_processor.py`):

| Action | Method | URL Example | Description |
|--------|--------|-------------|-------------|
| `control` | ALL | `.../agentic_process/{id}/control` | Process control (pause/resume/stop) |
| `state` | ALL | `.../agentic_process/{id}/state` | Get process state |
| `step` | ALL | `.../agentic_process/{id}/step` | Execute one step |
| `exit` | ALL | `.../agentic_process/{id}/exit` | Exit process |
| `get-history` | GET | `.../agentic_process/{id}/get-history` | Get execution history |
| `transcript/plan` | POST | `.../agentic_process/{id}/transcript/plan` | Resolve the latest plan from the worker transcript |
| `transcript/prompts` | POST | `.../agentic_process/{id}/transcript/prompts` | Return canonical user prompts from `AgentTranscript.prompts` |
| `start-pty` | POST | `.../agentic_process/{id}/start-pty` | Start PTY terminal |
| `resume-pty` | POST | `.../agentic_process/{id}/resume-pty` | Resume PTY session |
| `kill-pty` | POST | `.../agentic_process/{id}/kill-pty` | Kill PTY process |
| `execute` | POST | `.../agentic_process/{id}/execute` | Execute command |
| `run` | ALL | `.../agentic_process/{id}/run` | Run process |
| `runFile` | ALL | `.../agentic_process/{id}/runFile` | Run file |
| `create` | POST | `.../agentic_process` | Create process (overrides global create) |
| `createProcess` | ALL | `.../agentic_process/{id}/createProcess` | Create child process |
| `controlStart` | POST | `.../agentic_process/{id}/controlStart` | Start control session |
| `controlAppend` | POST | `.../agentic_process/{id}/controlAppend` | Append to control |
| `controlInput` | POST | `.../agentic_process/{id}/controlInput` | Send input |
| `controlAbort` | POST | `.../agentic_process/{id}/controlAbort` | Abort control |
| `controlStep` | ALL | `.../agentic_process/{id}/controlStep` | Step in control |
| `controlContinue` | ALL | `.../agentic_process/{id}/controlContinue` | Continue control |

### ComputeNode Actions

Entity-specific actions on `ComputeNode` (`flow_sdk/builtin/faas/compute_node.py`):

| Action | Method | Description |
|--------|--------|-------------|
| `terminal-command` | POST | Execute terminal command |
| `ops` | POST | Filesystem operations |
| `get-host` | ALL | Get host info |
| `get-machine-status` | ALL | Get machine status |

## Dedicated Routes (Non-Graph)

These routes bypass the graph/action system entirely. They are registered as FastAPI routers with their own prefixes, **before** the graph catch-all.

| Route file | Prefix | Key Endpoints |
|------------|--------|---------------|
| `server/routes/auth.py` | `/api/auth` | OAuth flows, login, logout |
| `server/routes/hooks.py` | `/api/hooks` | Hook management |
| `server/routes/chat.py` | `/api/chat` | Claude CLI sessions |
| `server/routes/directory.py` | `/api/directory` | Working directory management |
| `server/routes/detection.py` | — | Claude Code detection |
| `server/routes/testing.py` | — | `/ping`, `/prompt` (test/debug) |
| `server/routes/ui.py` | — | Serves the frontend (`/`) |
| `server/routes/websocket.py` | — | `/api/v1/connect/ws/{id}` WebSocket |
| `server/routes/webhook.py` | — | `/api/v1/webhook/{type}/{name}` |
| `flow_sdk/server/routes/bootstrap.py` | — | `/api/v1/graph/bootstrap` |
| `flow_sdk/server/routes/health.py` | `/api/v1/health` | `/status`, `/version` |

**Registration order** in `flow_sdk/server/flow_server.py:88-102`:

1. `CatchAllExceptionMiddleware` (outermost)
2. `RequestTransactionMiddleware`
3. `CORSMiddleware`
4. `bootstrap_router`, `health_router` (core)
5. User routers (auth, hooks, chat, directory, etc.)
6. **`graph_router` last** — catch-all at `/api/v1/graph/{path:path}`

The graph router must be last because it matches any path.

---

## Frontend Routing

The frontend **never constructs API URLs directly**. All API access flows through `ActionInfo` → `ApiUrl` → `DataManager`.

### ActionInfo

`ts_sdk/src/models/ActionInfo.ts` — encapsulates everything needed for an API call:

```typescript
class ActionInfo {
  name: string;              // Action name ('read', 'create', 'fs', custom)
  targetEntity: TypeId;      // Target entity TypeId
  scope: TypeId[];           // Parent scope chain
  method: HttpMethod;        // 'GET' | 'POST' | 'PUT' | 'DELETE'
  subpath: string | null;    // Sub-path after action
  queryParameters: object;   // URL query params
  bodyParameters: object;    // Request body (supports FormData)
  isRawResponse: boolean;    // Skip response extraction
  isStreaming: boolean;      // Use SSE streaming
  castResponse: boolean;     // Cast response JSON to entity instances
}
```

**URL generation**: `actionInfo.actionUrl` delegates to `ApiUrl.toString()`.

### ApiUrl

`ts_sdk/src/models/ApiUrl.ts` — builds the actual URL string:

```typescript
toString(): string {
  // Joins: prefix + scope + target + action + subpath + queryParams
  // "/graph/{scope_type}/{scope_id}/{type}/{id}/{action}/{subpath}?{params}"
}
```

The `/graph` prefix is added by default (`config.API_PREFIXES.graph`). The base URL `/api/v1` is set on the axios client.

### DataManager

`ts_sdk/src/FlowSync/store.ts` — central API execution layer:

| Method | Description |
|--------|-------------|
| `callAction(actionInfo)` | Execute any action — dispatches to POST/PUT/GET/DELETE based on `actionInfo.method` |
| `save(typeId, scope)` | Create (POST) or update (PUT) an entity |
| `delete(typeId)` | Delete an entity |
| `getByTypeId(typeId)` | Fetch entity with caching |

### Entity Methods (the correct way)

`ts_sdk/src/APIEntity.ts` — all entities expose action methods. Components should **always** use these instead of constructing API calls directly:

```typescript
// CRUD — built into every entity
await entity.save([workspace.typeId]);        // Create or update
await entity.delete();                         // Delete

// Custom actions — defined on entity subclasses
const actionInfo = new ActionInfo('control', this.typeId.type, this.typeId.id, 'POST');
actionInfo.bodyParameters = { command: 'pause' };
await dataManager.callAction(actionInfo);

// Label actions — use subpath
const actionInfo = new ActionInfo('label', this.typeId.type, this.typeId.id, 'POST');
actionInfo.subpath = 'my-label';               // → /label/my-label
await dataManager.callAction(actionInfo);
```

### React Hooks

`ts_sdk/src/react/hooks/use-action.ts` — wraps `DataManager.callAction` with React state:

```typescript
const { data, loading, error, refetch } = useAction<T>(actionInfo, { enabled: true });
```

### Frontend Usage Rules

1. **Never construct `/api/v1/graph/...` URLs manually** — always use `ActionInfo` + `DataManager`
2. **Use entity methods** for CRUD — `entity.save()`, `entity.delete()`
3. **Use `ActionInfo`** for custom actions — set `name`, `targetEntity`, `method`, `subpath`
4. **Use `useAction` hook** in React components for automatic loading/error state
5. **Scope array** is for hierarchical access — e.g. `[workspace.typeId]` when creating under a workspace

### Frontend URL Examples

What `ApiUrl.toString()` produces:

| Operation | ActionInfo setup | Generated URL |
|-----------|-----------------|---------------|
| List agents | `name='read', resourceType='agent'` | `/graph/agent` |
| Get agent | `name='read', resourceType='agent', resourceId='@local'` | `/graph/agent/@local` |
| Create task under workspace | `name='create', resourceType='task', scope=[ws.typeId]` | `/graph/workspace/@local/task` |
| Browse files | `name='fs', target=cn.typeId, subpath='browse/Users/shlom'` | `/graph/compute_node/@local/fs/browse/Users/shlom` |
| Terminal command | `name='terminal-command', target=cn.typeId, method='POST'` | `/graph/compute_node/@local/terminal-command` |
| Add label | `name='label', target=entity.typeId, subpath='my-tag', method='POST'` | `/graph/agent/@local/label/my-tag` |

## Implementations

| Component | File |
|-----------|------|
| **Backend URL parser** | `flow_sdk/api/api_request.py` — `APIRequest.from_api_path()` |
| **Backend RequestInfo** | `flow_sdk/request_context/request_info.py` — `RequestInfo` |
| **Backend action registry** | `flow_sdk/actions/action_registry.py` — `ActionManager`, `action` singleton |
| **Backend CRUD actions** | `flow_sdk/app/actions/graph_crud_actions.py` |
| **Backend FS actions** | `flow_sdk/actions/fs/main_fs_action.py`, `flow_sdk/actions/fs/fs_actions.py` |
| **Backend graph route** | `flow_sdk/server/routes/graph.py` — `catch_all()`, `handle_request()` |
| **Backend middleware** | `flow_sdk/server/middleware/request_transaction_middleware.py` |
| **Backend server setup** | `flow_sdk/server/flow_server.py` — router registration order |
| **Frontend ActionInfo** | `ts_sdk/src/models/ActionInfo.ts` |
| **Frontend ApiUrl** | `ts_sdk/src/models/ApiUrl.ts` |
| **Frontend DataManager** | `ts_sdk/src/FlowSync/store.ts` — `callAction()`, `save()`, `delete()` |
| **Frontend APIEntity** | `ts_sdk/src/APIEntity.ts` — entity action methods |
| **Frontend useAction** | `ts_sdk/src/react/hooks/use-action.ts` |
| **API interface spec** | `docs/api-interface-spec.md` — full FlowPad API reference |
