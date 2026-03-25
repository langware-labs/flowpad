test 1: Validate streaming execution and completion
- navigate to {APP_URL}/
- fill landing input with "streaming test"
- press Enter
- wait for URL to change to /dock/session/...
- click "New Session" button
- validate instruction input is visible and status is IDLE
- fill instruction input with "Explain how a computer works"
- press Enter
- validate stop button with title "Stop execution" appears during execution
- wait for DONE status
- validate DONE status in status bar
- validate stop button is no longer visible
- validate ASSISTANT block is visible with response content
- validate instruction input is ready for new messages

test 2: Multiple streaming responses in sequence
- fill instruction input with "What is 1+1?"
- press Enter
- wait for DONE status
- validate first USER and ASSISTANT blocks appear
- fill instruction input with "What is 2+2?"
- press Enter
- wait for DONE status
- validate both messages and responses are visible
- validate messages are in correct chronological order
