---
id: 306a8a4d-8c99-55ec-8e8f-c70a20e56af9
---

test 1: Claude CLI terminal has no duplicated lines or escape artifacts
- navigate to /dock/shell/new_terminal then click the Start Claude button (data-testid="start-claude-button")
- wait for the Claude CLI to start and display its banner
- read the full terminal text content
- validate there are NO raw escape sequence artifacts (^[, ^[[I, ^[[O)
- validate there are NO duplicated consecutive non-empty lines
- validate "claude --session-id" appears at most once (not duplicated)

KNOWN BUG: The Claude CLI startup currently shows:
  1. duplicated "claude --session-id ..." lines
  2. "^[[I" escape sequence artifact visible as text
  3. truncated session ID fragment on its own line
