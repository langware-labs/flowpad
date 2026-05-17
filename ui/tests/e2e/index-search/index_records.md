---
id: 0b4890dd-af9f-5dde-829a-9867bccb8f82
---

test 1: POST /fs-records/index (full, all types) returns indexed count and types array
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?limit_per_type=2&limit_types=3
- [api] validate HTTP response status is 200
- [api] validate response body has status equal to "SUCCESS"
- [api] validate data.indexed is a number >= 0
- [api] validate data.types is an array

test 2: POST /fs-records/index?type=skill indexes skill records
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] validate HTTP response status is 200
- [api] validate response body has status equal to "SUCCESS"
- [api] validate data.type equals "skill"
- [api] validate data.indexed is a number >= 0
- [api] validate data.errors is a number >= 0

test 3: Concurrent index requests for same type return 409 conflict
- [bash] start first index job: POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index in background
- [bash] immediately send second index job for same endpoint
- [bash] validate that at least one request returns HTTP 409 (conflict: same job already running)

test 4: Index job completion — indexed + errors covers all discovered records
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=skill (get count N)
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] validate data.indexed + data.errors >= N (all discovered records accounted for)

test 5: Index All button in scanner triggers indexing and shows progress
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan" and wait for scan to complete
- [browser] click the "Index All" button
- [browser] wait for the button text to change to "Indexing…" or a progress bar to appear
- [browser] wait up to 60 seconds for indexing to complete (button returns to "Index All" or progress disappears)

test 6: Per-type index button in scanner indexes single type
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan" and wait for scan to complete
- [browser] hover over the "skill" type row (or a row with count > 0)
- [browser] click the Database/Index icon button that appears on hover
- [browser] wait for the index button to complete (tooltip changes to "Indexed N records")
- [browser] validate the tooltip shows "Indexed N records"

test 7: index-status endpoint returns per-type status
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/index-status
- [api] validate HTTP response status is 200
- [api] validate response body has status equal to "SUCCESS"
- [api] validate data.never_indexed is a boolean
- [api] validate data.stale is a boolean
- [api] validate data.per_type is an array

test 8: Clear Index button resets the index via confirmation dialog
- [browser] navigate to the Records Scanner page
- [browser] click the "Clear Index" button
- [browser] validate a confirmation dialog appears with "Clear search index?" title
- [browser] click "Cancel" in the dialog
- [browser] validate the dialog is dismissed and no index was cleared
