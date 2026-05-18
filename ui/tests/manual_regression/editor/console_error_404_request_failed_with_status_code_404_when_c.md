---
id: 43e7f5dc-8443-58ba-bfd9-7f4516024d7c
---

test 1: Navigating to code editor does not produce 404 console errors (FLOWPAD-1686)
- navigate to {APP_URL}/dock/editor
- wait 3 seconds for the editor to load
- validate the code editor component is visible
- check console for 404 errors
- validate no 404 errors appeared in console
