# Regression: spawned AgenticProcess is attached to its Trigger via `target_typeid_str`

## Context

Recent refactor: `AgenticProcess.trigger_id` was renamed to `target_typeid_str`, and
now holds a serialized `TypeId` (e.g. `"trigger-<uuid>"`) rather than a raw UUID.

The schedule-trigger fire path (`flow_sdk/builtin/trigger.py::_fire_schedule_job`)
now sets `target_typeid_str=str(entity.typeid)` on the spawned `AgenticProcess`.

The UI `TriggerInvocationsPanel` builds the target string with
`new TypeId(Trigger.type, trigger.id).toString()` and queries via
`useProcessesForTarget`, which issues a `QueryFilter.match` on
`target_typeid_str`.

This scenario verifies both sides of the rename:
1. The backend persists `target_typeid_str = "trigger-<trigger.id>"` on the process.
2. The filtered list endpoint returns the spawned process for that key.
3. The UI `TriggerInvocationsPanel` renders a row for the spawned process.

Hub: `http://localhost:9008`  (backend)
UI:  `http://localhost:4098`  (Vite dev)

## Steps

1. **Create a schedule trigger with an `instruction`** via `POST /api/v1/graph/trigger`
   so the fire path actually spawns a process.
   - body: `{"name":"qa-target-typeid-str","trigger_type":"schedule","sched_trigger_type":"cron","expr":"0 9 * * *","scope":"user","enabled":true,"instruction":"echo trigger-target-typeid-probe"}`
   - expect HTTP 200, capture `data.id` as `TRIGGER_ID`.

2. **Sanity-check no pre-existing rows** for this trigger:
   `GET /api/v1/graph/agentic_process?filter[match][op]=$EQ&filter[match][operands][0]=target_typeid_str&filter[match][operands][1]=trigger-<TRIGGER_ID>` must return `data: []`.

3. **Fire the trigger** via `POST /api/v1/graph/trigger/<TRIGGER_ID>/test`.
   - expect `status: "fired"` and `counter` > 0.

4. **Verify the spawned process carries the new serialized key.**
   Re-run the filtered query from step 2. The response must now contain at least one
   `agentic_process` whose `target_typeid_str === "trigger-<TRIGGER_ID>"`.

5. **Verify `TriggerInvocationsPanel` shows the invocation row.**
   - Navigate the UI to `/dock/triggers`.
   - Select the trigger `qa-target-typeid-str` in the left list.
   - The right "Invocations" panel must show at least one entry labelled `Scheduled`
     (coming from `TriggerLogRecord`). A link icon to open the spawned process
     should be present when the process entity is found by `useProcessesForTarget`.

6. **Cleanup.** `DELETE /api/v1/graph/trigger/<TRIGGER_ID>`.

## Pass criteria

- Step 4 returns ≥ 1 row whose `target_typeid_str` exactly equals
  `"trigger-<TRIGGER_ID>"`.
- Step 5 shows an Invocations row (UI assertion — soft if browser MCP unavailable,
  in which case step 4 is sufficient for pass).
