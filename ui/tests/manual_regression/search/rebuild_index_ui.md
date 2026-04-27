test 1: Rebuild-index button is visible in the search-view header
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load (networkidle)
- [browser] validate the element with data-testid="search-view" is visible
- [browser] validate the element with data-testid="rebuild-index" is visible
- [browser] validate that data-testid="rebuild-index" wraps an svg with class "lucide-package-search"
- [browser] hover the data-testid="rebuild-index" element
- [browser] validate a tooltip with text "Refresh search data" appears

test 2: Clicking the rebuild button does NOT open the activity progress modal
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load
- [browser] dismiss the WelcomeModal if visible (click "Not Now")
- [browser] validate no element with role="dialog" is visible
- [browser] click data-testid="rebuild-index"
- [browser] wait 1 second
- [browser] validate no element with role="dialog" is visible (modal must NOT auto-open)
- [browser] wait for the data-testid="rebuild-index" button to become enabled again

test 3: Footer indexing indicator appears during a rebuild
- [browser] navigate to {APP_URL}/dock/search
- [browser] wait for page to load
- [browser] dismiss WelcomeModal if visible
- [browser] validate the element with data-testid="footer-indexing-indicator" is NOT visible (idle baseline)
- [browser] click data-testid="rebuild-index"
- [browser] wait up to 5 seconds for data-testid="footer-indexing-indicator" to appear
- [browser] validate data-testid="footer-indexing-indicator" is visible
- [browser] validate the indicator text starts with one of: "Archiving", "Clearing", "Scanning", "Indexing"

test 4: Footer indicator is positioned right of the project path, with a separator
- [browser] navigate to {APP_URL}/dock/search
- [browser] click data-testid="rebuild-index"
- [browser] wait for data-testid="footer-indexing-indicator" to appear
- [browser] locate the project-path button (footer button containing "/" — e.g. "/Users/shlom/...")
- [browser] validate the project-path button appears in the DOM BEFORE data-testid="footer-indexing-indicator"
- [browser] validate a 1-pixel vertical separator span (class containing "bg-border") sits between the project-path and the indicator

test 5: Clicking the footer indicator opens the activity progress modal
- [browser] navigate to {APP_URL}/dock/search
- [browser] click data-testid="rebuild-index"
- [browser] wait for data-testid="footer-indexing-indicator" to appear
- [browser] click data-testid="footer-indexing-indicator"
- [browser] wait up to 1 second for an element with role="dialog" to appear
- [browser] validate the dialog title contains a slash-formatted progress like "N/M" (e.g. "Indexing — 4/14")
- [browser] press Escape to close the dialog
- [browser] validate the modal closes but data-testid="footer-indexing-indicator" remains visible

test 6: Sub-activity transitions advance smoothly (no flicker)
- [browser] navigate to {APP_URL}/dock/search
- [browser] start a JS sampler that records the data-testid="footer-indexing-indicator" innerText every 100 ms
- [browser] click data-testid="rebuild-index"
- [browser] wait until the indicator disappears (job complete) OR up to 180 seconds
- [browser] count the number of "activity → null → activity" transitions (flicker cycles) in the sample stream
- [browser] validate the flicker count is 0
- [browser] validate the activity transitions follow the expected order (subset of): Archiving → Clearing → Scanning → Indexing → null

test 7: Footer clears within ~1 second of backend completion (index_end event settle)
- [browser] navigate to {APP_URL}/dock/search
- [browser] click data-testid="rebuild-index"
- [browser] start polling GET {API_URL}/api/v1/graph/compute_node/@local/fs-records/activity-status every 500 ms
- [browser] capture the timestamp T_backend_idle when the activity-status response data becomes null
- [browser] capture the timestamp T_footer_clear when data-testid="footer-indexing-indicator" disappears
- [browser] validate T_footer_clear - T_backend_idle <= 1500 ms (the index_end completion event settled the UI within 1.5 s)

test 8: Refreshing the page mid-rebuild restores the indicator without opening the modal
- [browser] navigate to {APP_URL}/dock/search
- [browser] click data-testid="rebuild-index"
- [browser] wait for data-testid="footer-indexing-indicator" to appear
- [browser] reload the page (Cmd+R / window.location.reload())
- [browser] wait for the page to load (networkidle)
- [browser] within 2 seconds of load, validate data-testid="footer-indexing-indicator" is visible (state restored from /activity-status)
- [browser] validate no element with role="dialog" is visible (modal must NOT auto-open after refresh)
- [browser] click data-testid="footer-indexing-indicator"
- [browser] validate an element with role="dialog" appears (manual open still works)

test 9: Refreshing the page after rebuild completes shows no indicator and no modal
- [browser] navigate to {APP_URL}/dock/search
- [browser] click data-testid="rebuild-index"
- [browser] wait until data-testid="footer-indexing-indicator" disappears (job complete)
- [browser] reload the page
- [browser] wait for page to load
- [browser] validate data-testid="footer-indexing-indicator" is NOT visible
- [browser] validate no element with role="dialog" is visible

test 10: Idle watchdog clears stuck UI when WS misses the completion event
- [api] disconnect or block the WebSocket subscriber simulated by closing the connection (e.g. backend-side: cycle the WS server). Skip if not feasible.
- [browser] navigate to {APP_URL}/dock/search
- [browser] click data-testid="rebuild-index"
- [browser] wait for data-testid="footer-indexing-indicator" to appear
- [browser] simulate dropped WS by intercepting `progress_report` messages in the browser (chrome devtools or a test override) — skip the very last batch
- [browser] wait up to 10 seconds after backend reports activity-status=null
- [browser] validate data-testid="footer-indexing-indicator" eventually disappears (idle watchdog polled /activity-status and settled)
- (this scenario is a stretch goal — manual cycle of the backend WS is acceptable to simulate)

test 11: Whole rebuild completes within budget on a typical corpus
- [api] note the wall-clock T0 when the click is issued
- [browser] navigate to {APP_URL}/dock/search
- [browser] click data-testid="rebuild-index"
- [browser] wait for data-testid="footer-indexing-indicator" to disappear
- [browser] note T1 when the indicator is gone
- [browser] validate T1 - T0 < 120 seconds (the post-fix budget for ~500 claude_sessions corpus)
- [browser] validate the inline scan-info badge in the SearchView header (text containing "indexed") shows a non-zero indexed count
