test 1: Navigate back to home from an active shell session
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- validate shell terminal is visible
- navigate to {APP_URL}/dock/home
- validate URL changed to /dock/home
- validate home landing page is visible
- validate the session input field (aria-label="Start new Claude Code session...") is visible
