REGRESSION: Added 2026-03-19 — progress_report WebSocket events for scan and index.
Both sub-activity (per-record) and job-level (per-type) events are broadcast during
scan and index operations. Old event names scan_progress/index_progress were removed.

test 1: Aggregate scan emits sub-activity progress_report events over WebSocket
- [ws] connect to the WebSocket at {WS_URL}/api/v1/connect/ws/local
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan via GET with limit_types=3
- [ws] collect FlowData events of element_type="progress_report" with sub_activity_name != null
- [ws] validate at least one sub-activity event was received
- [ws] validate each sub-activity event has: job_name="scan", sub_activity_name (string), done (number > 0), total (number > 0)

test 2: Aggregate index emits sub-activity progress_report events over WebSocket
- [ws] connect to WebSocket
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?limit_types=3
- [ws] collect progress_report events with sub_activity_name != null
- [ws] validate at least one sub-activity event with job_name="index"

test 3: Job-level events (sub_activity_name=null) are emitted per completed type
- [ws] connect to WebSocket
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?limit_types=2
- [ws] collect progress_report events with sub_activity_name == null
- [ws] validate at least one job-level event was received
- [ws] validate each job-level event has: job_name="scan", sub_activity_name=null, done (number), total (number)
- [ws] validate the done values in job-level events are non-decreasing

test 4: Per-type scan emits one completed sub-activity event for that type
- [ws] connect to WebSocket
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=skill
- [ws] collect sub-activity progress_report events
- [ws] validate the last sub-activity event has sub_activity_name="skill" and done == total

test 5: Per-type index emits sub-activity events for that type only
- [ws] connect to WebSocket
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [ws] collect sub-activity progress_report events
- [ws] validate the last sub-activity event has sub_activity_name="skill" and done == total

test 6: Scanner viewer shows progress bar during scan
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan"
- [browser] while scanning, validate a progress bar or "Scanning all record types…" indicator appears
- [browser] wait for scan to complete
- [browser] validate the progress indicator is no longer visible

test 7: Scanner viewer shows progress bar during index all
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan" and wait for scan to complete
- [browser] click "Index All"
- [browser] validate the "Index All" button shows "Indexing…" state or a progress bar appears
- [browser] wait up to 60 seconds for indexing to complete
