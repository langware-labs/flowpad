---
id: 0c35b90d-e469-51ac-ab87-9e99233a590d
---

test 1: Bootstrap API response includes scan_info with expected shape
- [api] GET {API_URL}/api/v1/graph/bootstrap
- [api] validate HTTP response status is 200
- [api] validate response body has status equal to "SUCCESS"
- [api] validate data.scan_info is an object (not null)
- [api] validate data.scan_info.total_indexed is a number (>= 0)
- [api] validate data.scan_info.never_indexed is a boolean
- [api] validate data.scan_info.stale is a boolean

test 2: SearchView header shows "N indexed" badge after bootstrap
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load (networkidle)
- [browser] validate the element with data-testid="search-view" is visible
- [browser] wait up to 5 seconds for any element containing the text "indexed" to appear
- [browser] validate at least one element in the header area contains the word "indexed"

test 3: SearchView "indexed" count is a non-negative integer
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load (networkidle)
- [browser] wait up to 5 seconds for any element containing "indexed" text to appear
- [browser] read the text of the element containing "indexed"
- [browser] validate the leading number in that text is >= 0 (e.g. "0 indexed" or "142 indexed")

test 4: Home inline search stats line shows "indexed" after a search
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] locate the search input with data-testid="search-input" (first match)
- [browser] click the search input
- [browser] fill the search input with "test"
- [browser] wait up to 6 seconds for inline results panel to appear (element with text "result" or "Searching")
- [browser] wait up to 6 seconds for loading to complete (text "Searching" disappears)
- [browser] validate the inline stats line contains the word "indexed"

test 5: index-status API endpoint returns expected shape
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/index-status
- [api] validate HTTP response status is 200
- [api] validate response body has status equal to "SUCCESS"
- [api] validate data.never_indexed is a boolean
- [api] validate data.stale is a boolean
- [api] validate data.per_type is an array

test 6: SearchView rebuild-index button archives, clears, scans, indexes and refreshes "N indexed" badge
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load (networkidle)
- [browser] validate the element with data-testid="search-view" is visible
- [browser] if the WelcomeModal ("Make your records searchable") is visible, dismiss it via the "Not Now" button (or "Skip for now" on older builds)
- [browser] wait up to 8 seconds for the "N indexed" badge to appear
- [browser] read the leading integer N from the "N indexed" badge and remember it as INDEXED_BEFORE
- [browser] locate the rebuild-index Button via data-testid="rebuild-index" (ghost-icon button with the PackageSearch icon; tooltip "Refresh search data")
- [browser] validate that button is enabled (not disabled)
- [browser] start listening for POST {API_URL}/api/v1/graph/compute_node/@local/desktop-db/archive
- [browser] start listening for POST {API_URL}/api/v1/graph/compute_node/@local/desktop-db/clear-index
- [browser] start listening for GET  {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?trigger=manual
- [browser] start listening for POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index
- [browser] click the rebuild-index button
- [browser] wait up to 60 seconds for all 4 backend calls above to return HTTP 200
- [browser] wait for the button to become enabled again (busy state cleared)
- [browser] wait up to 8 seconds for the "N indexed" badge to be visible again
- [browser] read the leading integer N from the "N indexed" badge and remember it as INDEXED_AFTER
- [browser] validate INDEXED_AFTER is a non-negative integer (indexing pipeline produced a fresh count)
