# Workflow — Entity Create Smoke (WorkflowRecord default file_path regression)

## Summary
Verifies that creating a minimal `Workflow` entity via the graph CRUD endpoint
succeeds end-to-end, exercising `Entity.save()`'s WorkflowRecord fallback path.

This is a regression check for the `WorkflowRecord.__init__` fix: previously
`file_path` was a required positional parameter, so when `Entity.save()` tried
to construct a `WorkflowRecord` for a newly-created `Workflow` entity with no
backing markdown file, instantiation raised `TypeError: __init__() missing 1
required positional argument: 'file_path'` and the POST returned 500. The fix
defaults `file_path=None` and only attaches an `_asset_ref` when a path is
provided, letting record-less workflow entities persist cleanly.

## Preconditions
- Backend running at `http://localhost:$LOCAL_SERVER_PORT` (default 9008)
- `uv run -m flow_sdk.server.run` is up and responding on `/api/v1/graph/bootstrap`
- Local dev auth (no cookie / API key required when hitting localhost)

## Route notes
- The Workflow entity type is registered under `BuiltinEntityType.WORKFLOW = "workflow"`
  (see `flow_sdk/db/drivers/db_base_record.py`).
- Creation is handled by the generic `action.all(action_name="create", methods="post", types="all")`
  handler in `flow_sdk/app/actions/graph_crud_actions.py`, so the create URL is
  `POST /api/v1/graph/workflow/` (note the trailing slash; the router strips it).
- Retrieval is `GET /api/v1/graph/workflow/<id>`.
- The VFS path field on a `Workflow` entity is `asset_ref` (a VFS-style path to
  the backing markdown file). With a minimal JSON body, `asset_ref` is expected
  to be `null` — it is only set when the workflow is backed by a markdown file
  (e.g. created via the asset-scanner flow). The legacy `source_vfs_path` /
  `preparedPath` / `pipeline` fields were removed; only `asset_ref` remains.
- The UI entry points are the `WorkflowAssetEditor` toolbar (single **Run**
  button — no separate Prepare / Pipeline step) and the mirrored sidebar route
  at `/dock/workflows/<id>`. Clicking Run spawns a hidden
  `AgenticProcess` with `visible=false`, `print_mode=true`,
  `output_format="stream-json"`, and `target_typeid_str` set to the workflow's
  `typeId`, then calls `process.prompt(instruction)`.

## Steps

### 1. Server reachability
1. Run `curl -sS --max-time 10 -o /dev/null -w "%{http_code}\n" http://localhost:9008/api/v1/graph/bootstrap`
2. **Expected**: HTTP `200`

### 2. Create a minimal Workflow entity
1. Run:
   ```bash
   curl -sS --max-time 15 -X POST http://localhost:9008/api/v1/graph/workflow/ \
     -H "Content-Type: application/json" \
     -d '{"name":"qa_regression_workflow_entity_create","description":"QA smoke"}' \
     -o /tmp/workflow_create.json -w "%{http_code}\n"
   ```
2. **Expected**: HTTP `200`
3. **Expected**: Response JSON `status == "SUCCESS"` and `data.id` is a UUID
4. **Expected**: `data.type == "workflow"` and `data.name` matches the posted name
5. **Regression check**: NO `500` with `TypeError: ... missing 1 required positional argument: 'file_path'`
   in the response or server log (this is the bug the WorkflowRecord fix addresses)

### 3. GET the created Workflow
1. Extract `id` from the previous response (e.g. `WID=$(python3 -c "import json; print(json.load(open('/tmp/workflow_create.json'))['data']['id'])")`)
2. Run `curl -sS --max-time 10 http://localhost:9008/api/v1/graph/workflow/${WID} -o /tmp/workflow_get.json -w "%{http_code}\n"`
3. **Expected**: HTTP `200`, `status == "SUCCESS"`
4. **Expected**: `data.id` equals the created id; `data.type == "workflow"`; `data.name` matches
5. **Expected**: `data.asset_ref` is present as a field (value may be `null` for a record-less workflow)

## Pass Criteria
- [ ] `POST /api/v1/graph/workflow/` with a minimal body returns HTTP 200 and `status: SUCCESS`
- [ ] No 500 / TypeError around `WorkflowRecord.__init__` in the response or logs
- [ ] `GET /api/v1/graph/workflow/<id>` returns the saved entity with a matching `id`, `type`, and `name`
- [ ] `asset_ref` is exposed on the entity shape (null is acceptable when not file-backed)

## Notes
- The VFS path field is `asset_ref` (the legacy `source_vfs_path` / `preparedPath`
  / `pipeline` fields were removed). The regression being tested is specifically
  the `WorkflowRecord.__init__(file_path=None)` default that lets `Entity.save()`
  create a record without crashing — it does NOT guarantee that `asset_ref`
  becomes populated for a bare-JSON create.
