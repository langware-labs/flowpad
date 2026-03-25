test 1: when claude runs in shell and is thinking, not all the output is visible (FLOWPAD-1617)
- navigate to {APP_URL}/dock/shell
- open 2 new shell terminals
- in one enter “claude” to run claude
- prompt: “create architecture docs for gym management web app. think hard” (or any other prompt that requires long thinking time)
- while claude is thinking and showing “clauding” (thinking) click the other shell tab and click the claude shell tab again
- validate that claude output is shown correctlyimportant: if you navigated back AFTER claude finished thinking test is invalid
