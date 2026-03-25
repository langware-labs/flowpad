test 1: File explorer shows Unix-style root path (not Windows C:/) on macOS (FLOWPAD-1594)
- navigate to {APP_URL}/dock/explorer
- wait 3 seconds for the file explorer to load
- validate the file explorer component is visible
- validate the root path displayed does NOT show "C:\" or "C:/"
- validate the root path shows a Unix-style path starting with "/" or the working directory
- check console for errors
