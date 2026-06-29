---
id: 8ec09b52-3a45-5030-adad-3b8643cf7d64
---

test 1: FsRecordsScannerViewer is reachable via /dock/lens/fs-records/scan/
- [browser] navigate to {APP_URL}/dock/lens/fs-records/scan/
- [browser] wait for the page to load (networkidle)
- [browser] validate the "Records Scanner" heading is visible
- [browser] validate the "Index All" button is visible
- [browser] validate the header "Rescan" button is visible

test 2: Per-type rows render with count/size/status columns after running a scan
- [browser] navigate to {APP_URL}/dock/lens/fs-records/scan/
- [browser] wait for the page to load (networkidle)
- [browser] click the "Rescan" button (header or empty-state banner, either works) to run an initial scan
- [browser] wait for the stats table to render
- [browser] validate at least one table row is visible
- [browser] validate the table header contains "Type", "Count", "Size", "Status"

test 3: Clicking "Rescan" triggers a fresh scan and totals remain visible
- [browser] navigate to {APP_URL}/dock/lens/fs-records/scan/
- [browser] wait for the page to load (networkidle)
- [browser] click the "Rescan" button to run the initial scan
- [browser] wait for the totals bar to show "N records"
- [browser] click the header "Rescan" button a second time
- [browser] wait for the scan to settle
- [browser] validate the totals bar is still visible after the rescan completes

test 4: Clicking "Index All" runs per-type indexing via POST /fs-records/index
- [browser] navigate to {APP_URL}/dock/lens/fs-records/scan/
- [browser] wait for the page to load (networkidle)
- [browser] click the "Rescan" button to populate the stats table
- [browser] wait for the stats table to render
- [browser] click the "Index All" button
- [browser] wait up to 180 seconds for the button text to return to "Index All" and become enabled again

test 5: Backend aggregate scan API returns the expected response shape
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?limit_types=5
- [api] validate the HTTP response status is 200
- [api] validate the response body has status equal to "SUCCESS"
- [api] validate data.types is an array
- [api] validate data.grand_total is a number
- [api] validate data.scan_ms is a number

test 6: Backend registered-types endpoint returns a non-empty list including "skill"
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records
- [api] validate the HTTP response status is 200
- [api] validate the response body has status equal to "SUCCESS"
- [api] validate data.types is an array with length > 0
- [api] validate data.types contains the string "skill"
