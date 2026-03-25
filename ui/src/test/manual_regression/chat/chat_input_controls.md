test 1: Send message via Enter key
- navigate to {APP_URL}/
- fill landing input with "input controls test"
- press Enter
- wait for URL to change to /dock/session/...
- click "New Session" button
- validate instruction input is visible and status is IDLE
- fill instruction input with "Sent with Enter"
- press Enter
- wait for DONE status
- validate message "Sent with Enter" appears in chat
- validate ASSISTANT response appears

test 2: Empty submit blocked
- validate instruction input is empty
- press Enter on empty input
- wait 1 second
- validate status is still IDLE
- validate "no output" still shows
- validate no USER message block appears

test 3: Stop button visible during execution
- fill instruction input with "Count from 1 to 100 slowly"
- press Enter
- validate stop button with title "Stop execution" appears in status bar
- validate stop button contains text "stop"
- wait for DONE status
