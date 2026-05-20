---
id: c6e72dc0-aacf-5a30-b269-8ae6ec88baff
---

test 1: Search view is accessible at /dock/search without a query
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for the page to load (networkidle)
- [browser] validate the element with data-testid="search-view" is visible

test 2: URL param ?q=hello pre-populates the search input value
- [browser] navigate to {APP_URL}/dock/search?q=hello
- [browser] wait for the page to load (networkidle)
- [browser] locate the search input with data-testid="search-input" (first match)
- [browser] validate the search input is visible
- [browser] validate the search input has the value "hello"

test 3: Results area is always visible in the search view
- [browser] navigate to {APP_URL}/dock/search?q=test
- [browser] wait for the page to load (networkidle)
- [browser] validate the element with data-testid="search-results" is visible

test 4: Backend search API returns a valid JSON response
- [api] GET {API_URL}/api/v1/search?q=test&limit=5
- [api] validate the HTTP response status is 200
- [api] validate the response body has status equal to "SUCCESS"
- [api] validate the response body has a "data" object
- [api] validate data.results is an array (may be empty)
- [api] validate data.indexer_ready is a boolean value
