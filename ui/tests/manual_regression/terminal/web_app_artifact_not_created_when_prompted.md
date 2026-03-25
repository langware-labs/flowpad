test 1: Web app view is accessible after starting a Claude session (FLOWPAD-1616)
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- click the Start Claude button (data-testid="start-claude-button")
- wait up to 45 seconds for the Claude CLI banner to appear in the terminal
- validate the terminal input is visible (aria-label="Terminal Input")
- navigate to {APP_URL}/dock/web-app
- validate the web-app view loads without crashing (no error page or 404)
- validate the page is accessible (some content is rendered)
