---
id: 3eb36a84-3997-5904-beb8-de3a24592aff
---

test 1: Creating content in skills view and navigating to home does not crash app (FLOWPAD-1623)
- navigate to {APP_URL}/dock/assets/list/skill
- validate the skills view is visible
- look for a "New" or "Add" button in the skills view
- click it to create a new skill if button exists
- wait 2 seconds
- navigate to {APP_URL}/dock/home
- validate the home page loads without error
- validate no crash occurred (app is still responsive)
- check console for any crash-related errors
