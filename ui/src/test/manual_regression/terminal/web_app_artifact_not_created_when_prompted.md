test 1: web app artifact not created when prompted (FLOWPAD-1616)
- navigate to {APP_URL}/dock/shell
- open new shell terminal
- claude
- prompt: “create a calculator web app”
- wait for claude to create calculator.html
- navigate {APP_URL}/dock/web-app
- validate calculator web app is visible
