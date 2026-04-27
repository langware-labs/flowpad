test 1: Annotation gutter is visible in a Claude process terminal
- navigate to {APP_URL}/dock/shell/new_terminal then click the Start Claude button (data-testid="start-claude-button")
- wait for the Claude CLI banner to appear in the terminal (up to 45 seconds)
- validate the terminal is visible (aria-label="Terminal Input" is present)
- wait 3 seconds for the annotation gutter to initialize
- validate the annotation gutter overlay element is present in the DOM (data-testid="annotation-gutter")
- skip: live-claude (requires active Claude session — LLM must be configured)

test 2: Annotation gutter is not visible in a plain shell terminal
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (element with data-terminal-id is visible)
- validate the terminal input is visible (aria-label="Terminal Input")
- validate no annotation gutter element is visible (data-testid="annotation-gutter" should not appear in a plain shell)

test 3: Annotation gutter is visible when navigating to an existing agentic process with a worker session ID
- navigate directly to {APP_URL}/dock/shell/agentic_process-0938e838-d3b8-4c6c-8883-3be42d6b3522
- wait for the terminal panels container to be visible
- validate the annotation gutter is present in the DOM (data-testid="annotation-gutter")

test 4: Creating a bookmark from the annotation gutter saves without error
- navigate directly to {APP_URL}/dock/shell/agentic_process-0938e838-d3b8-4c6c-8883-3be42d6b3522
- wait for the annotation gutter to be visible
- click the first "+" button visible in the annotation gutter
- a popover or picker should appear
- click the "Bookmark" option in the picker
- wait for the bookmark creation form to appear (a textarea or input for bookmark content)
- type the text "e2e test bookmark" into the form
- click the Save button
- validate no navigation away occurred (URL still contains agentic_process-0938e838)
- validate no console errors related to bookmark creation

test 5: "Open Session" from home navigates to the correct existing process (not a new one)
- NOTE: this test depends on test 4 having run first (a bookmark must exist for process 0938e838)
- navigate to {APP_URL} (home page)
- find a bookmark card on the home page that corresponds to the bookmark created in test 4
- note the current URL and process ID in it
- click the "Open Session" button on the bookmark card
- validate the navigation URL contains agentic_process-0938e838-d3b8-4c6c-8883-3be42d6b3522 (same process, NOT a new one)
- validate the URL contains a ?t= timestamp parameter
