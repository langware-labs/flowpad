test 1: Home page has a search bar
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] validate the element with data-testid="record-search-bar" is visible on the page

test 2: Typing a query and pressing Enter navigates to the search view
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] locate the search input with data-testid="search-input" (first match)
- [browser] validate the search input is visible
- [browser] click the search input
- [browser] type "quarterly review" into the search input
- [browser] press Enter
- [browser] wait for navigation to complete
- [browser] validate the URL contains "/dock/search"
- [browser] validate the URL query string contains "q=quarterly%20review" (or URL-encoded equivalent)
- [browser] validate the element with data-testid="search-view" is visible

test 3: Tools button toggles the filter panel
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] locate the button with data-testid="search-tools-btn" (first match)
- [browser] validate the Tools button is visible
- [browser] validate the element with data-testid="search-filter-panel" is NOT visible (hidden by default)
- [browser] click the Tools button
- [browser] validate the element with data-testid="search-filter-panel" is now visible
- [browser] click the Tools button again
- [browser] validate the element with data-testid="search-filter-panel" is no longer visible
