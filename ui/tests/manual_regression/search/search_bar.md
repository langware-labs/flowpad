---
id: aa8a30e6-0547-5886-a3e7-45e5c8ce9fcc
---

precondition: bootstrap must complete before any deep-link / keypress assertion. Each test below waits for window.appReady === true after navigation; otherwise the SearchView TabsContent isn't mounted yet and the input testid won't be in the DOM.

test 1: Home is the Vibe hero; the record search bar lives in the search view
(Since 2026-10-11 the home is always the tabless Vibe hero — docs/viewmodes.md — and carries no search bar; the bar that used to sit on the Standard home is not shown anywhere on home any more.)
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load
- [browser] validate <html> has data-view="vibe"
- [browser] validate no element with data-testid="record-search-bar" is visible
- [browser] navigate to {APP_URL}/dock/search
- [browser] validate the element with data-testid="record-search-bar" is visible

test 2: Typing in the search view writes the query to the URL
- [browser] navigate to {APP_URL}/dock/search
- [browser] locate the visible search input with data-testid="search-input" (first match)
- [browser] click the search input
- [browser] fill the search input with "quarterly review"
- [browser] validate the URL is /dock/search with a q= parameter containing "quarterly"
- [browser] validate the element with data-testid="search-view" is visible

test 3: Navigating to /dock/search?q=hello pre-populates the search input
- [browser] navigate to {APP_URL}/dock/search?q=hello
- [browser] wait for page to load
- [browser] wait for window.appReady === true (timeout 15s)
- [browser] locate the search input with data-testid="search-input" (first match)
- [browser] validate the search input is visible
- [browser] validate the search input has value "hello"

test 4: The search view bar is the full bar — filter panel shown, no Tools button
- [browser] navigate to {APP_URL}/dock/search
- [browser] validate the element with data-testid="record-search-bar" is visible
- [browser] validate the element with data-testid="search-filter-panel" inside it is visible (the search view renders the bar with compact=false)
- [browser] validate there is no element with data-testid="search-tools-btn" inside it (showTools defaults to false)

test 5: Search view shows a results area
- [browser] navigate to {APP_URL}/dock/search?q=test
- [browser] wait for page to load
- [browser] wait for window.appReady === true (timeout 15s)
- [browser] validate the element with data-testid="search-results" is visible

test 6: Search view is accessible without a query
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load
- [browser] wait for window.appReady === true (timeout 15s)
- [browser] validate the element with data-testid="search-view" is visible
