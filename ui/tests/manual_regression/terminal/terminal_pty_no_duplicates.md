test 1: Claude CLI terminal has no duplicated lines or escape artifacts
- navigate to /dock/shell/new_terminal?startClaude=true
- wait up to 45s for the Claude CLI banner to appear in the terminal (text containing "claude" or "Claude Code")
- read the full terminal text content
- validate there are NO raw escape sequence artifacts (^[, ^[[I, ^[[O)
- validate there are NO duplicated consecutive non-empty lines
- validate "claude --session-id" appears at most once (not duplicated)

KNOWN BUG: The Claude CLI startup currently shows:
  1. duplicated "claude --session-id ..." lines
  2. "^[[I" escape sequence artifact visible as text
  3. truncated session ID fragment on its own line
