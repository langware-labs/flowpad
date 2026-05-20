---
id: 6c8ba6c4-3019-5b7f-b229-2ece8a9ee25b
---

test 1: Execute flow view loads without theme errors (FLOWPAD-1668)
- navigate to {APP_URL}/dock/execute-flow
- wait 3 seconds for the execute flow view to load
- validate the execute flow view is visible
- check console for "vs-dark" or theme-related errors
- validate no theme errors appeared in console
