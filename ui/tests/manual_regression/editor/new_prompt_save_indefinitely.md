---
id: 2a777753-846b-5b7d-b8de-adeef6b1ba27
---

test 1: Execute flow view is accessible and does not hang (FLOWPAD-1657)
- navigate to {APP_URL}/dock/execute-flow
- wait 3 seconds for the execute flow view to load
- validate the execute flow view is visible
- look for any "New" or "Save" controls in the execute flow interface
- validate the controls are responsive (not spinning/loading indefinitely)
- check console for errors
