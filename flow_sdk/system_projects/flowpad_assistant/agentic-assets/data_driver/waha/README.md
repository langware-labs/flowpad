---
id: 1834d588-c9cb-4a94-b634-446f9d68d71c
---
# WhatsApp (WAHA)

A WhatsApp number linked to [WAHA](https://waha.devlike.pro), the self-hosted WhatsApp HTTP API.
People message the number; the agent that owns this source answers.

WAHA is an **unofficial** client: it logs into WhatsApp as a linked device of a real phone.
WhatsApp can ban a number used this way. Use a spare number (an eSIM), never your own.

## What you need

1. **A number with WhatsApp Business.** Put the eSIM in a phone, install WhatsApp Business,
   register the eSIM number, set a two-step PIN, and use it normally for a day or two.
2. **The WAHA container** on the machine running Flowpad. The browserless engine is enough:

   ```bash
   docker run -d --name waha -p 3010:3000 \
     -e WAHA_API_KEY=<key> -e WHATSAPP_DEFAULT_ENGINE=NOWEB \
     -v waha-sessions:/app/.sessions devlikeapro/waha:noweb-arm
   ```

3. **The `waha` credential** declared in the owning agent's project, with the values in its
   `.env.local` — nothing secret goes into the source's form:

   | Variable | What |
   |---|---|
   | `WAHA_API_KEY` | the container's `WAHA_API_KEY` |
   | `WAHA_WEBHOOK_HMAC` | any long random string; WAHA signs every delivery with it |

## Connect

Add the channel on the agent (Channels → Add channel → WhatsApp (WAHA)):

- **WAHA URL** — `http://localhost:3010`
- **Session** — `default` (WAHA Core allows only that one)
- **Webhook URL** — how the container reaches this instance, e.g.
  `http://host.docker.internal:6001/api/v1/data_source/webhook/waha`
- **Allowed senders** — the phone numbers that may drive the agent

Press **Verify**. It creates the WAHA session with the signed webhook (or re-points an existing
one), then asks you to pair: in WhatsApp Business open **Linked devices** and scan the QR at
`<WAHA URL>/api/default/auth/qr`. Verify again — it reads `Sending as +<number>`.

## Keep it alive

- Open WhatsApp Business on the phone every week or two: WhatsApp logs linked devices out when
  the phone stays offline for about 14 days.
- The session survives container restarts through the `waha-sessions` volume.

## How it behaves

- Only `message` is subscribed, and `fromMe` is dropped, so the agent never answers itself.
- Group chats (`@g.us`) and messages without text are ignored.
- A reply goes to the raw chat id — `…@c.us` or `…@lid` — and quotes the message it answers.
- A delivery whose `X-Webhook-Hmac` does not verify is refused with 401.
