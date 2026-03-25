test 1: AI configuration view is accessible and loads without errors (FLOWPAD-1604)
- navigate to {APP_URL}/dock/ai-config
- wait 3 seconds for the AI config view to load
- validate the AI configuration view is visible
- validate at least one model or provider configuration option is shown
- check console for configuration errors
- validate no errors appeared

test 2: Navigating back to home after visiting AI config shows no LLM warning if configured
- navigate to {APP_URL}/dock/home
- wait 2 seconds
- validate the home landing page is visible
- if "LLM not configured" warning icon is visible, it indicates configuration is needed
- validate the app remains functional regardless of LLM configuration state
