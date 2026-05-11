test 1: Plain text message with USER and ASSISTANT blocks
- navigate to {APP_URL}/
- fill landing input with "message types test"
- press Enter
- wait for URL to change to /dock/shell/...
- click "New Session" button
- validate instruction input is visible and status is IDLE
- fill instruction input with "What is the capital of France?"
- press Enter
- wait for DONE status
- validate USER block with "What is the capital of France?" appears
- validate ASSISTANT block appears with response text
- validate DONE status in status bar

test 2: Thinking/reasoning block appears and is expandable
- validate THINKING block appears between USER and ASSISTANT
- validate THINKING block shows token count number
- click THINKING block chevron to expand
- validate reasoning content text is visible inside expanded block
- click THINKING block chevron to collapse
- validate reasoning content is hidden

test 3: Tool use produces multiple THINKING blocks
- fill instruction input with "Run the shell command: echo hello world"
- press Enter
- wait for DONE status
- validate USER block with "Run the shell command" text appears
- validate at least two THINKING blocks appear (tool reasoning and result processing)
- validate ASSISTANT block appears with response about the command output
