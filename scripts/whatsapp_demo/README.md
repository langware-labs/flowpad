# WhatsApp transport demo

A standalone Twilio webhook with scripted replies to `hello`, `help`, and
`echo <text>`. It does not run an AI agent or access Flowpad data.
Incoming requests must carry a valid Twilio signature and the configured account SID.
Credentials are read from an existing env file and are never copied into this folder.

From the repository root:

1. Run `ngrok http 6081` and copy its public HTTPS origin.
2. Start the demo (replace placeholders):

   ```sh
   .venv/bin/python scripts/whatsapp_demo/app.py \
     --env-file /path/to/hub/.env.local \
     --webhook-url https://YOUR-TUNNEL.ngrok-free.app/whatsapp
   ```

   The env file must contain `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
3. In Twilio's WhatsApp Sandbox settings, set **When a message comes in** to
   that exact `/whatsapp` URL using POST. Record any existing URL before changing it.
4. Send the sandbox's own `join <code>` phrase from your phone to the number
   shown in the Twilio Console, then send `hello` or `echo it works`.

The reply is returned as TwiML on the incoming webhook. Twilio delivers it on
WhatsApp. The incoming message opens the 24-hour service window, so these
immediate replies need no template. Twilio messaging fees apply.

Stop the server and tunnel with Ctrl-C and restore the previous Sandbox webhook
when finished. If the tunnel URL changes, update both the command and Twilio.

Docs: https://www.twilio.com/docs/whatsapp/sandbox
