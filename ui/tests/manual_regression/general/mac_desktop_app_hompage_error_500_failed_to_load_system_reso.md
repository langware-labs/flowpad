---
id: e6190987-95a4-56d5-bd11-e4bd263790ea
---

test 1: App home page does not produce 500 error on macOS (FLOWPAD-1685)
- navigate to {APP_URL}/dock/home
- wait 3 seconds for the home page to load
- validate the home landing page is visible
- check console for 500 errors or "failed to load system resource" errors
- validate no 500 errors appeared in console
