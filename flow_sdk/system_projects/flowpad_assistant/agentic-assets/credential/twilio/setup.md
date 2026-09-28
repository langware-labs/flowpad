Get the Twilio account credentials a phone line uses.
1. Open https://console.twilio.com and sign in (ask the person to sign in if needed — never create an account).
2. On the account dashboard copy the Account SID (starts with `AC`) and the Auth Token.
3. Store them: pipe the lines `TWILIO_ACCOUNT_SID=<sid>` and `TWILIO_AUTH_TOKEN=<token>` into `flow credentials set twilio --stdin`.
4. Confirm with `flow credentials check twilio`. Never print or repeat the token.
