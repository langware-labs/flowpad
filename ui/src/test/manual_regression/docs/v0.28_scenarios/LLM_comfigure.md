---
id: 70eb814c-5619-5019-8a41-4d50cfdeed74
---

STATE BEFORE TEST: clear app databse

- navigate to {APP_URL}
- validate "LLM not configured" warning icon is visible
- click warning, click "LLM not configured" open the LLM configuration modal
- select: "2: Agent", "claude code"
- select "Login with anthropic"-> authorize
- validate "LLM not configured" warning icon is not visible
- click “new coding agent cli” tab
- wait 15 seconds
- validate new tab with working claude code instance visible
