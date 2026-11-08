---
id: d0a0c5b8-0ace-5a47-bd01-b04af48498e6
---

(Since 2026-10-11 the home is always the tabless Vibe hero — docs/viewmodes.md — and carries no record search bar. Searching starts in the search view, /dock/search.)

test 1: Home is the Vibe hero and the record search bar is in the search view
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] validate <html> has data-view="vibe"
- [browser] validate no element with data-testid="record-search-bar" is visible on the home page
- [browser] navigate to {APP_URL}/dock/search
- [browser] validate the element with data-testid="record-search-bar" is visible

test 2: Typing a query in the search view puts it in the URL
- [browser] navigate to {APP_URL}/dock/search
- [browser] locate the visible search input with data-testid="search-input" (first match)
- [browser] click the search input
- [browser] type "quarterly review" into the search input
- [browser] validate the URL contains "/dock/search"
- [browser] validate the URL query string contains "q=quarterly%20review" (or URL-encoded equivalent)
- [browser] validate the element with data-testid="search-view" is visible

test 3: Home exposes no search Tools toggle or filter panel
- [browser] navigate to {APP_URL}/
- [browser] wait for the page to load (networkidle)
- [browser] validate <html> has data-view="vibe"
- [browser] validate no element with data-testid="search-tools-btn" is visible on the home page
- [browser] validate no element with data-testid="search-filter-panel" is visible on the home page
