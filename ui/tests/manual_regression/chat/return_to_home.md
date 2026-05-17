---
id: f7524173-2bf8-508b-9039-9e37ea12e083
---

test 1: Navigate back to home from an active shell session
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
- validate shell terminal is visible
- navigate to {APP_URL}/dock/home
- validate URL changed to /dock/home
- validate home landing page is visible
- validate the home session input (aria-label="What would you like to work on?") is visible
