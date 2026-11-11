# First agent on email — the 60-second wizard ends with an agent that answers me

Setup: a desktop instance in dev mode signed in to a hub that offers agent mail
(`/dock/hub/home`, e.g. instance stg-1 on :4098 against staging).

1. Open `/dock/hub/home`. The first-agent card shows four channel tiles, **Email first**
   (`first-agent-channel-email`), then Slack, WhatsApp, Telegram. No × on this step.
2. Click **Email**. The rest of the home page (projects row, Agents/Skills/… tabs) is gone;
   the card shows "Step 2 of 3" and an × top right.
3. Type the instructions, **Next**. "How should it connect to Email?": **Agent email address**
   and **Your Gmail** — the latter disabled, reading "Contact support@langware.ai to enable".
4. Pick **Agent email address**, press **Get its address**. "Connect Email" shows the address
   (`first-agent-address`) and the allowed senders with the signed-in person's email.
5. Add a second address with **+ Add sender**; it is listed.
6. When the machine is ready **Done** enables; press it. "Your agent is live": "Email it at
   <address> — it answers there."
7. Send a mail to the address from the added sender. Within two minutes the live box shows it
   and the agent's reply.
8. × closes the wizard: the channel tiles and the rest of the home page are back.
9. Start again and press × on "Connect Email", before **Done**: the agent's machine is removed once it is up
   (the project's Deployments list is empty again); leaving the page for another does the same. × after
   "Your agent is live" keeps the machine.
