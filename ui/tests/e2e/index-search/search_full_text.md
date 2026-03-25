test 1: Search with no params returns empty results array
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search
- [api] validate HTTP response status is 200
- [api] validate response body has status equal to "SUCCESS"
- [api] validate data.results is an empty array
- [api] validate data.total is 0 or a number >= 0

test 2: Search response always has indexer_ready field
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?q=anything
- [api] validate HTTP response status is 200
- [api] validate data.indexer_ready is a boolean

test 3: Full-text search after index returns matching records
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?q=skill&record_type=skill
- [api] validate HTTP response status is 200
- [api] if data.indexed > 0: validate data.results is non-empty
- [api] if data.results is non-empty: validate each result has record_id, record_type, name, text, source_path

test 4: Search with record_type filter returns only that type
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?record_type=skill
- [api] validate every result in data.results has record_type="skill"

test 5: Browse mode (record_type only, no query) returns indexed records of that type
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?record_type=skill
- [api] validate HTTP response status is 200
- [api] if data.results is non-empty: validate all results have record_type="skill" and have "name" field

test 6: Search result shape matches useRecordSearch hook expectations
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?record_type=skill
- [api] validate data.results is an array
- [api] validate data.total is a number
- [api] validate data.indexer_ready is a boolean
- [api] if any result exists: validate it has fields: record_id, record_type, name, text, status, scope, created_at, modified_at, source_path

test 7: Search with limit=1 returns at most 1 result
- [bash] GET {API_URL}/api/v1/search?q=test&limit=1 returns 200 with data.results.length <= 1

test 8: Search with limit=0 or negative does not return 500
- [bash] GET {API_URL}/api/v1/search?q=test&limit=0 returns status != 500
- [bash] GET {API_URL}/api/v1/search?q=test&limit=-1 returns status != 500

test 9: Search view shows "No records found" for a query that matches nothing
- [browser] navigate to {APP_URL}/dock/search?q=xyzzy_no_match_9z8w7v
- [browser] wait for page to load (networkidle)
- [browser] wait up to 10 seconds for loading spinner to disappear
- [browser] validate a "No records found" or "No results" message is visible

test 10: Search view shows results area at /dock/search
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load (networkidle)
- [browser] validate the element with data-testid="search-view" is visible
- [browser] validate the element with data-testid="search-results" is visible

test 11: URL query param ?q= pre-populates the search input
- [browser] navigate to {APP_URL}/dock/search?q=hello
- [browser] wait for page to load
- [browser] validate the search input has value "hello"

test 12: Search after scan+index — scan→index→search full cycle
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/scan?type=skill (discover count)
- [api] POST {API_URL}/api/v1/graph/compute_node/@local/fs-records/index?type=skill (index them)
- [api] GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/search?record_type=skill (find results)
- [api] if indexed > 0: validate search results are non-empty and all have record_type="skill"
