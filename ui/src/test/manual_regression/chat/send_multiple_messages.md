test 1: Send multiple messages in sequence
- navigate to {APP_URL}/
- click "New Flow" or start chat input
- fill chat input with "What is 2 + 2?"
- press Enter
- wait 5 seconds
- validate user message "What is 2 + 2?" appears in chat
- validate AI response appears below user message
- fill chat input with "Now multiply that by 3"
- press Enter
- wait 5 seconds
- validate second user message appears below first exchange
- validate second AI response appears
- fill chat input with "Summarize our conversation"
- press Enter
- wait 5 seconds
- validate third user message appears below second exchange
- validate third AI response appears

test 2: Scroll behavior with many messages
- validate chat container auto-scrolls to show latest message
- scroll up in chat container
- validate older messages are visible
- fill chat input with "One more message"
- press Enter
- wait 5 seconds
- validate chat auto-scrolls to newest message at bottom
