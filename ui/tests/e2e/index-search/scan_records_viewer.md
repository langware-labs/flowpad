test 1: Records Scanner viewer loads and shows Rescan button
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] click the nav item that opens the Records Scanner (look for a lens/viewer icon or navigate directly to a page that contains the FsRecordsScannerViewer)
- [browser] navigate to {APP_URL}/dock/scanner (or whichever route renders FsRecordsScannerViewer)
- [browser] validate a "Rescan" button is visible
- [browser] validate an "Index All" button is visible
- [browser] validate a "Clear Index" button is visible

test 2: Clicking Rescan populates the type table
- [browser] navigate to the Records Scanner page
- [browser] wait for page to load
- [browser] click the "Rescan" button
- [browser] wait up to 30 seconds for the scan to complete (spinner disappears)
- [browser] validate a table of record types appears
- [browser] validate at least one row shows a type name and a count column

test 3: Grand total summary line appears after scan
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan"
- [browser] wait for scan to complete
- [browser] validate a summary line containing "records" is visible (e.g. "142 records · 1.2 MB · 5 types")

test 4: Type filter input narrows the type list
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan" and wait for scan to complete
- [browser] locate the "Filter types…" input
- [browser] type "skill" into the filter input
- [browser] validate only rows with "skill" in the type name are visible

test 5: "Non-empty" toggle hides zero-count types
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan" and wait for scan to complete
- [browser] click the "Non-empty" toggle button
- [browser] validate no rows with count 0 are visible

test 6: Expanding a type row shows individual record entries
- [browser] navigate to the Records Scanner page
- [browser] click "Rescan" and wait for scan to complete
- [browser] locate a row with count > 0
- [browser] click the chevron expand control for that row
- [browser] validate a nested table of record entries appears (uid, name, size columns)

test 7: Scan error state shows error message
- [api] simulate backend unavailable: GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=no_such_type_xyz
- [api] validate response status is 400 or 422

test 8: API returns list of registered types
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records
- [api] validate HTTP response status is 200
- [api] validate response body has status equal to "SUCCESS"
- [api] validate data.types is a non-empty array
- [api] validate data.types includes "skill"
