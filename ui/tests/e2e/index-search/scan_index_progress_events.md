---
id: 52860b1c-0171-5104-acb7-c4abe0676583
---

REGRESSION: Added 2026-03-19, updated for IndexProgressTable snapshots.

`progress_report` WebSocket events are emitted during scan and index operations.
Each event is a full table snapshot:
- `job_name`: `"scan"` or `"index"`
- `rows`: per-record-type counters (`type_name`, `done`, `total`, `errors`, `skipped`)
- `current`: type currently being scanned/indexed, or null
- `done`/`total`: aggregate record progress (`scan.total === 0` means unknown)
- `text`: `"complete"` on the terminal event

No per-entity progress events are expected. The old split between
`sub_activity_name != null` sub-activity events and `sub_activity_name == null`
job-level events is no longer valid.

test 1: Aggregate scan emits progress table snapshots over WebSocket
- [ws] connect through the frontend WebSocket
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?limit_types=3&trigger=manual
- [ws] collect FlowData events of element_type="progress_report"
- [ws] validate every captured event has `job_name="scan"`, `rows[]`, numeric `done`, numeric `total`
- [ws] validate scan table-level `total` is 0 because scan totals are unknown while discovery is running

test 2: Per-type scan returns completed response
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=skill&trigger=manual
- [api] validate SUCCESS response with `data.type="skill"` and numeric `count`

test 3: Per-type index returns completed response
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] validate SUCCESS response with `data.type="skill"` and numeric `indexed`

test 4: Aggregate scan response is coherent
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?limit_types=3
- [api] validate numeric `grand_total` and `scan_ms`

test 5: Scanner viewer shows progress table UI during scan/index
- [browser] navigate to the records/search UI
- [browser] trigger scan or index
- [browser] validate the compact progress indicator shows aggregate record count
- [browser] open the progress modal and validate rows are per type, not per entity
