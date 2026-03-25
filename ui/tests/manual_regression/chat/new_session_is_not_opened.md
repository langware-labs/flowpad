test 1: Submitting from home page opens a new shell session (FLOWPAD-1672)
- navigate to {APP_URL}/dock/home
- validate the home landing page is visible
- validate the session input field (aria-label="Start new Claude Code session...") is visible
- fill the session input with "hi"
- press Enter
- wait 5 seconds for navigation
- validate URL now contains /dock/shell/ (new shell session was opened)
