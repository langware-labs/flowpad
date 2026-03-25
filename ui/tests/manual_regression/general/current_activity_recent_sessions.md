test 1: Home page has a current activity panel
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] validate the element with data-testid="project-activity-strip" is visible

test 2: Current activity panel renders without errors even when no sniffer events have arrived
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] open browser console capture before navigating
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] wait 2 seconds for the activity panel to settle
- [browser] validate no console errors related to "activity" or "sessions" or "eventDriven"

test 3: Sessions modified within the last 3 hours appear in current activity on page reload
- prerequisite: at least one Claude session was modified within the last 3 hours in the selected project
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] validate the element with data-testid="project-activity-strip" is visible
- [browser] wait up to 10 seconds for at least one session item to appear inside the activity panel
- [browser] validate the activity strip contains at least 1 session item (data-testid="activity-item" or similar)
- note: sessions active within the last 3 hours must show even without live sniffer events

test 4: Sessions older than 3 hours without sniffer events do not appear in current activity
- prerequisite: no sessions were modified in the last 3 hours (or all older sessions are known)
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] wait 5 seconds for the activity panel to settle (no live events expected)
- [browser] validate that any session items visible have modifiedAt within the last 3 hours OR have a "running" status badge
- note: this test validates the filter boundary; sessions modified > 3h ago should not appear unless they received a live event

test 5: Current activity shows running sessions regardless of modification time
- [browser] navigate to {APP_URL}/
- [browser] wait for page to load (networkidle)
- [browser] validate the element with data-testid="project-activity-strip" is visible
- [browser] if any session item is visible with status "running", validate it appears at the top of the list
- note: running sessions always appear first (sorted by sniffer event time or modifiedAt desc)

IMPLEMENTATION NOTE:
  The filter in use-event-driven-sessions.ts (recomputeItems) now includes three keep-conditions:
  1. Sessions with a sniffer event this page session (eventLatest.has(sessionId))
  2. Sessions with status === 'running'
  3. Sessions with modifiedAt > now - 3 hours
  Previously only conditions 1 and 2 existed, causing sessions to vanish on page reload
  if no live sniffer event had arrived — even sessions that ran minutes ago.
