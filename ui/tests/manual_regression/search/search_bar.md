test 1: Home page has a search bar
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load
- [browser] validate the element with data-testid="record-search-bar" is visible

test 2: Pressing Enter from home search bar navigates to search view
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load
- [browser] locate the search input with data-testid="search-input" (first match)
- [browser] validate the search input is visible
- [browser] click the search input
- [browser] fill the search input with "quarterly review"
- [browser] press Enter
- [browser] wait for navigation
- [browser] validate the URL contains "/dock/search"
- [browser] validate the element with data-testid="search-view" is visible

test 3: Navigating to /dock/search?q=hello pre-populates the search input
- [browser] navigate to {APP_URL}/dock/search?q=hello
- [browser] wait for page to load
- [browser] locate the search input with data-testid="search-input" (first match)
- [browser] validate the search input is visible
- [browser] validate the search input has value "hello"

test 4: Compact home search bar has no Tools button and no filter panel by default
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load
- [browser] validate the element with data-testid="record-search-bar" is visible
- [browser] validate the element with data-testid="search-tools-btn" is not visible (home bar is compact, showTools=false)
- [browser] validate the element with data-testid="search-filter-panel" is not visible

test 5: Search view shows a results area
- [browser] navigate to {APP_URL}/dock/search?q=test
- [browser] wait for page to load
- [browser] validate the element with data-testid="search-results" is visible

test 6: Search view is accessible without a query
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load
- [browser] validate the element with data-testid="search-view" is visible
