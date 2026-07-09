---
id: 1ada41a3-f670-5ec1-aeb9-f04e8b493d52
---

test 1: Annotation gutter is visible in a Claude process terminal
- navigate to {APP_URL}/dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait for the Claude CLI banner to appear in the terminal (up to 45 seconds)
- validate the terminal is visible (aria-label="Terminal Input" is present)
- wait 3 seconds for the annotation gutter to initialize
- validate the annotation gutter overlay element is present in the DOM (data-testid="annotation-gutter")
- skip: live-claude (requires active Claude session — LLM must be configured)

test 2: Annotation gutter is not visible in a plain shell terminal
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for terminal to be ready (active terminal panel `[data-testid="terminal-panel"][data-active="true"]` shows xterm)
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

test 5: the bookmark persists with the correct session linkage and is listed by a live surface
- NOTE: this test depends on test 4 having run first (a bookmark must exist for the process)
- read the agentic process back from the backend and note its worker session id (agentic_process.session_id)
- read the bookmark back from the backend and validate it persisted with bookmark_type "terminal_annotation" and content "e2e test bookmark"
- validate the bookmark's session_id equals the process's worker session id (it is bound to THIS process's session, not a new/other one)
- reload the process page and open the annotation index in the gutter
- validate the bookmark is listed there by its content ("e2e test bookmark")

> PROVENANCE (2026-07-07): the original test 5 clicked an "Open Session" button on a
> home bookmark card and asserted it resumed the existing process with a `?t=`
> timestamp. That surface — the home BookmarkColumn and the resume-from-bookmark
> `?t=` path (useResumeInTerminal with a timestamp) — was removed in commit
> 29e6c667 (2026-06-18, feed refactor). BookmarkColumn is now dead code (zero
> render sites) and no live surface emits `?t=`. This scenario was updated to
> guard what still exists (persistence + session linkage + live listing). The lost
> timestamped-resume-from-bookmark coverage is recorded here for design review of
> whether that removal was intended.
