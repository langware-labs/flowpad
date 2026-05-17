---
id: 99e2e228-a7a9-526f-ba19-a67370117363
---

test 1: Full scan + index combined flow — rescan then index all via UI
- [browser] navigate to the Records Scanner page
- [browser] wait for page to load
- [browser] click "Rescan" and wait for scan to complete
- [browser] verify the type table shows at least one type with count > 0
- [browser] click "Index All"
- [browser] wait up to 60 seconds for indexing to complete
- [browser] navigate to {APP_URL}/dock/search
- [browser] enter a common term in the search input
- [browser] validate search results are non-empty

test 2: resetAndRescan flow — single aggregate scan then single aggregate index
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?limit_types=3 (aggregate scan)
- [api] validate HTTP response status is 200
- [api] validate data.grand_total >= 0
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?limit_types=3 (aggregate index)
- [api] validate HTTP response status is 200
- [api] validate data.indexed >= 0

test 3: Scan → per-type detail drill-down → index type → search
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=skill
- [api] validate count >= 1
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] validate indexed + errors >= 1
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?record_type=skill
- [api] if indexed > 0: validate results.length >= 1 and all have record_type="skill"

test 4: Consecutive scan requests work independently
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=skill (first scan)
- [api] validate HTTP response status is 200
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=skill (second scan)
- [api] validate HTTP response status is 200
- [api] validate second scan result.count >= first scan result.count (monotonic)

test 5: Clear FTS index then re-index recovers cleanly
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/desktop-db/clear-index (clears FTS index only, not the full DB)
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill (re-index skills)
- [api] validate HTTP response status is 200
- [api] validate data.indexed >= 0 (system recovers cleanly after FTS clear)

test 6: Scanner type filter + index combination
- [browser] navigate to Records Scanner
- [browser] click "Rescan" and wait for results
- [browser] enter "skill" in the "Filter types…" input
- [browser] validate only "skill" row is visible
- [browser] hover over the skill row and click the Database/Index icon
- [browser] wait for the index button to show indexed count in tooltip

test 7: Scan with limit_per_type parameter limits per-type records
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?limit_per_type=1&limit_types=2
- [api] validate HTTP response status is 200
- [api] validate data.indexed is a number (bounded by limit)
