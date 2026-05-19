---
id: ae159d3a-eccd-5951-8d92-44954a0b7cdf
---

test 1: Home page loads usage and cost overview without errors (FLOWPAD-1674)
- navigate to {APP_URL}/dock/home
- wait 3 seconds for the home page to load
- validate the home landing page is visible
- look for any cost or usage metrics section on the page
- check console for "failed to fetch cost overview" errors
- validate no cost fetch errors appeared in console
