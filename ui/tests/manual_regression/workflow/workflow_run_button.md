# Workflow — Run button populates Runs side tab (asset_ref rename)

## Summary
End-to-end smoke for the `WorkflowAssetEditor` Run button after the
`source_vfs_path` -> `asset_ref` rename. Verifies that:

1. Creating a workflow via the UI (`Workflow.createInProject` -> `Entity.save()`
   -> backend `WorkflowRecord.upsert_main_ref`) populates `asset_ref`.
2. Clicking Run on a workflow `.md` spawns an `AgenticProcess` whose
   `target_typeid_str` equals `workflow-<workflow.id>`.
3. The "Runs" side tab in the Milkdown editor populates (count >= 1).

This is the v0.2.8 regression check for the rename + the
`useProcessesForTarget(targetStr)` wiring on `WorkflowAssetEditor.tsx:83`.

## Preconditions
- Backend running at `http://localhost:9008`
- UI dev server at `http://localhost:4098`
- `flow-sdk-mcp` either pre-enabled OR willing to enable from the modal

## Steps

### 1. Create a workflow via the UI
1. Navigate to `http://localhost:4098/dock/workflows`
2. Click "New Workflow", enter `qa_assetref_smoke`, click Create
3. URL should redirect to `/dock/workflows/<uuid>`
4. **Expected** (curl `GET /api/v1/graph/workflow/<uuid>`):
   - `asset_ref` is non-null and points at `<scope>/.claude/workflows/qa_assetref_smoke.md`
   - The file exists on disk with frontmatter `asset_id: <uuid>`

### 2. Click Run on the workflow editor
1. On the workflow page, locate the Run button in the editor toolbar (Play icon)
2. Click it
3. **Expected**: button label flips to "Running…" then enables again on completion
4. **Expected**: side-drawer "Runs" tab badge shows "Runs 1"

### 3. Verify the spawned AgenticProcess
1. `curl -sS http://localhost:9008/api/v1/graph/agentic_process` and find the
   newest process whose `target_typeid_str` contains the workflow id.
2. **Expected fields** on that process:
   - `target_typeid_str === "workflow-<workflow.id>"`
   - `visible === false`
   - `cli_config.print_mode === true`
   - `cli_config.output_format === "stream-json"`
   - `cli_config.permission_mode === "bypassPermissions"`

### 4. Verify the Runs side tab renders
1. Click the "Runs" tab in the side drawer
2. **Expected**: panel shows at least one entry labeled "Run 1" with a status
   marker (Running… / Complete / Idle / Error).

## Pass Criteria
- [ ] New workflow has `asset_ref` populated and a backing `.md` on disk
- [ ] Run button spawns an `AgenticProcess` with the correct `target_typeid_str`
- [ ] Runs side tab shows the spawned run

## Notes
- The TS SDK `Workflow.run()` (`ts_sdk/src/entities/workflow.ts:101`) calls
  `AgenticProcess.spawn(...)` and does NOT set `target_typeid_str`. Programmatic
  `Workflow.run()` from the SDK therefore won't show up under the workflow's
  Runs tab — only the UI Run button (`WorkflowAssetEditor.doRun`) wires it up.
  Tracked separately; not in scope for this scenario.
- Pre-refactor workflow rows have `asset_ref=null` (data migration is
  out-of-scope; create a fresh workflow to exercise this scenario).
