Get the Meta Cloud API credentials of a WhatsApp business number.
1. Open https://developers.facebook.com/apps, sign in (ask the person), and open (or create) a Business app with the WhatsApp product.
2. Under WhatsApp → API Setup copy the access token (a System User token for one that does not expire in 24h).
3. Under App settings → Basic copy the App secret.
4. Store them: pipe the lines `FLOW_WHATSAPP_TOKEN=<token>` and `FLOW_WHATSAPP_SECRET=<app secret>` into `flow credentials set whatsapp --stdin`.
5. Confirm with `flow credentials check whatsapp`. Never print or repeat a secret.
