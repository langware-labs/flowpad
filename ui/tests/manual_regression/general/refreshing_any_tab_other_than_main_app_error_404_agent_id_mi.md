test 1: Navigating to execute flow tab does not produce 404 (agent ID missing) error (FLOWPAD-1644)
- navigate to {APP_URL}/dock/execute-flow
- wait 3 seconds for the execute flow view to load
- validate the execute flow view is visible
- check console for 404 errors or "agent ID missing" errors
- validate no such errors appeared

test 2: Navigating to skills tab does not produce 404 error
- navigate to {APP_URL}/dock/assets/list/skill
- wait 3 seconds for the skills view to load
- validate the skills view is visible
- check console for 404 errors
- validate no 404 errors appeared
