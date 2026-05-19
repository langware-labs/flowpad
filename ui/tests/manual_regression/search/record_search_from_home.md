---
id: d0a0c5b8-0ace-5a47-bd01-b04af48498e6
---

test 1: Home page has a search bar
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] wait for window.appReady === true (timeout 15s)
- [browser] validate the element with data-testid="record-search-bar" is visible on the page

test 2: Typing a query and pressing Enter navigates to the search view
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] wait for window.appReady === true (timeout 15s)
- [browser] locate the search input with data-testid="search-input" (first match)
- [browser] validate the search input is visible
- [browser] click the search input
- [browser] type "quarterly review" into the search input
- [browser] press Enter
- [browser] wait for navigation to complete
- [browser] validate the URL contains "/dock/search"
- [browser] validate the URL query string contains "q=quarterly%20review" (or URL-encoded equivalent)
- [browser] validate the element with data-testid="search-view" is visible

test 3: Home search bar does not expose the Tools toggle
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] wait for window.appReady === true (timeout 15s)
- [browser] validate the element with data-testid="search-tools-btn" is NOT present on the home page
- [browser] validate the element with data-testid="search-filter-panel" is NOT present on the home page
  # Rationale: HomeLanding renders <RecordSearchBar> without the showTools prop, so the
  # Tools button is intentionally hidden. Use the full search view (/dock/search) for filters.
