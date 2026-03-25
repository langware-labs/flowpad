test 1: Typing and submitting from app home page navigates to a shell session (FLOWPAD-1656)
- navigate to {APP_URL}/dock/home
- validate the home landing page is visible
- validate the session input field (aria-label="Start new Claude Code session...") is visible
- fill the session input with "hi"
- press Enter
- wait 5 seconds
- validate URL contains /dock/shell/ (a new session was started, not staying on home page)
- validate the terminal view is now visible
