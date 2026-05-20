test 1: Skills view is responsive and does not hang indefinitely (FLOWPAD-1667)
- navigate to {APP_URL}/dock/assets/list/skill
- wait 3 seconds for the skills view to load
- validate the skills viewer component is visible
- validate the view is in an interactive state (not a spinner/loading indicator)
- validate at least one button or interactive element is visible and clickable
- check console for errors
