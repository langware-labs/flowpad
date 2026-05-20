---
id: 9f7ed63f-8ff1-5f2e-8b64-e6151e503e69
---

test 1: Ctrl+C interrupts a running command
- navigate to the Shell view via sidebar
- validate terminal is visible and ready
- type "sleep 30" and press Enter to start a long-running command
- wait 1 second to let the command start
- press Ctrl+C to interrupt
- wait for the terminal to show the prompt again (command was interrupted)
- type "echo after interrupt" and press Enter
- validate "after interrupt" appears in the terminal output (terminal is responsive)
