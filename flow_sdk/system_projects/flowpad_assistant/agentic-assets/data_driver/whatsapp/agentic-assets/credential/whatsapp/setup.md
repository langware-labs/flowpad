The values a WhatsApp channel sends and receives with. The **Add channel → WhatsApp** setup asks for each
one in turn and stores it here; this page is the whole picture.

| Variable | What it is | Secret |
|---|---|---|
| `FLOW_WHATSAPP_TOKEN` | Sends as your number: `Authorization: Bearer …` on every Graph call | yes |
| `FLOW_WHATSAPP_SECRET` | Proves each incoming message is really from Meta (the delivery's signature) | yes |
| `FLOW_WHATSAPP_WEBHOOK_URL` | The public URL Meta posts messages to. Made by the setup — Flowpad cloud holds it for this computer | no |

The number itself (Phone number ID), its WhatsApp Business Account ID, the App ID and the webhook verify
token belong to the **channel**, not here: a channel is one number.

## Test first: Meta's free test number

1. Open [developers.facebook.com/apps](https://developers.facebook.com/apps) and sign in with the Facebook
   account that will own the bot (the first time, Meta asks you to register as a developer).
2. **Create app** → use case **Connect with customers through WhatsApp** → pick or create a **business
   portfolio** → **Create app**.
3. On **Quickstart** press **Start using the API**. The **API Setup** page has everything else:
   - the **WhatsApp Business Account ID**;
   - **Generate access token** — a temporary token, 24 hours (the setup extends it when it can);
   - **From**: the free test number and its **Phone number ID**;
   - **To**: add your own number and type the code Meta texts you. Only numbers you add here can talk
     to a test number (up to 5).
4. **App settings → Basic**: the **App ID**, and the **App secret** behind **Show**.

## Production: your own number, a second channel

Your real number is a **new channel** (a channel is one number), answered by your agent's cloud
deployment. Use a **second Meta app** for it — a Meta app has one webhook URL, so the test app on this
computer and the production app in the cloud cannot share one.

- **WhatsApp → API Setup → Add phone number**: a number not active in the WhatsApp app, verified by SMS or
  call; register it for the Cloud API with a 6-digit PIN; submit a **display name** (Meta reviews it).
- A **permanent token**: **Business Settings → Users → System users → Add** (Admin) → **Assign assets**
  (the app and the WhatsApp Business Account, full control) → **Generate new token**, expiry **Never**,
  permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
- Add a **payment method** to the WhatsApp Business Account, and complete **business verification** if
  Meta asks.

## By hand, or as an agent

Store values without printing them: pipe the lines `FLOW_WHATSAPP_TOKEN=<token>` and
`FLOW_WHATSAPP_SECRET=<app secret>` into `flow credentials set whatsapp --stdin`, then
`flow credentials check whatsapp`. Never print or repeat a secret.
