---
id: 3d304ee8-b076-5aef-9cd4-9d7d5e10bcd2
---

test 1: Claude CLI terminal has no duplicated lines or escape artifacts
- navigate to /dock/shell/new_terminal, then open the tab-opener "+" (data-testid="opener-plus-button") and pick the "Claude Code" row (data-testid="opener-menu-row-claude")
- wait up to 45s for the Claude CLI banner to appear in the terminal (text containing "claude" or "Claude Code")
- read the full terminal text content
- validate there are NO raw escape sequence artifacts (^[, ^[[I, ^[[O)
- validate there are NO duplicated consecutive non-empty lines
- validate "claude --session-id" appears at most once (not duplicated)

KNOWN BUG: The Claude CLI startup currently shows:
  1. duplicated "claude --session-id ..." lines
  2. "^[[I" escape sequence artifact visible as text
  3. truncated session ID fragment on its own line
