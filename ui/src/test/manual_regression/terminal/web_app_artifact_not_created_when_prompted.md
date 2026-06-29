---
id: 243877fe-3eef-55c9-8c04-57416963f9f3
---

test 1: web app artifact not created when prompted (FLOWPAD-1616)
- navigate to {APP_URL}/dock/shell
- open new shell terminal
- claude
- prompt: “create a calculator web app”
- wait for claude to create calculator.html
- navigate {APP_URL}/dock/web-app
- validate calculator web app is visible
