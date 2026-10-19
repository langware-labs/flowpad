---
id: 8ec09b52-3a45-5030-adad-3b8643cf7d64
---

test 1: FsRecordsScannerViewer is reachable via /dock/lens/fs-records/scan/
- [browser] navigate to {APP_URL}/dock/lens/fs-records/scan/
- [browser] wait for the page to load (networkidle)
- [browser] validate the "Records Scanner" heading is visible
- [browser] validate the primary "Fast" indexing button is visible
- [browser] validate the "Scan Stats" button is visible

test 2: Backend aggregate scan API returns the expected response shape
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?limit_types=5
- [api] validate the HTTP response status is 200
- [api] validate the response body has status equal to "SUCCESS"
- [api] validate data.types is an array
- [api] validate data.grand_total is a number
- [api] validate data.scan_ms is a number

test 3: Backend registered-types endpoint returns a non-empty list including "skill"
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records
- [api] validate the HTTP response status is 200
- [api] validate the response body has status equal to "SUCCESS"
- [api] validate data.types is an array with length > 0
- [api] validate data.types contains the string "skill"
