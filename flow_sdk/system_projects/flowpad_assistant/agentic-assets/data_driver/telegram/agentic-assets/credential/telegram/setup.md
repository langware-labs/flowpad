Create a Telegram bot and store its token.
1. In Telegram, open a chat with @BotFather (https://t.me/BotFather) and send `/newbot`.
2. Give it a display name, then a username ending in `bot`. BotFather answers with the token (`123456:ABC-...`).
3. Store it: pipe the line `TELEGRAM_BOT_TOKEN=<token>` into `flow credentials set telegram --stdin`.
4. Confirm with `flow credentials check telegram`. Never print or repeat the token.
