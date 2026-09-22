---
id: dc1ccad6-a2f8-44ab-a671-73c5c09c7b35
---
# Agent email

Allocate the Agent's mailbox, then process each incoming email through the Agent
and send a threaded reply through that same mailbox.

```python
import flow_sdk
from flow_sdk.builtin.agent import Agent
from flow_sdk.blocks import EmailMessageSpec, StreamInbox, workflow

await flow_sdk.auth.login()

pirate = Agent(
    name="pirate",
    worker_type="claude",
    model="sm",
    system_prompt="Answer like a pirate. Include 'arr' in every reply.",
)
await pirate.save()
assert pirate.mailbox is None
allocated = await pirate.allocate_mailbox(allowed_senders=["captain@gmail.com"])
assert pirate.mailbox is allocated

# StreamInbox is the message-facing view over the cloud_email DataSource
# that allocate_mailbox() wired. owner= says whose stream inbox this is — the
# agent's, so its replies are attributed to the agent, not to you. agent_id is the
# mailbox's stable identity (the address is allocated and can change) and,
# on its own, implies the same owner.
mail = StreamInbox(
    allocated.address,
    provider="cloud_email",
    owner=pirate,
    agent_id=pirate.id,
    senders=allocated.allowed_senders,
)
async with pirate.process_messages():
    async with workflow("pirate-email"):
        async for message in mail.listen():
            output = await pirate.process_message(message)
            await message.reply(EmailMessageSpec.reply_to(message, body=output.text))
```

Pinned by `tests/unit/test_agent_email_snippet.py` (Hub legs stubbed, scripted
mail, mock worker) and live by `tests/hub_tests/test_agent_email_conversation.py`.

`allocate_mailbox()` is the one door, and it is login-gated and idempotent.
**Nothing is allocated until you call it** — the address is billable and
permanent, so a second call adopts the mailbox the Agent already has rather than
buying another. One call allocates at the Hub, wires the `cloud_email` source
that polls it, and turns both on; there is no separate "enable" step, because
enabling a mailbox you do not have and re-enabling one you do are the same
request. `StreamInbox.listen()` is the public listening surface over that
`DataSource`; `DataSource` itself does not expose `listen()`.

Everything after allocation belongs to the mailbox, not to the Agent:

```python
pirate.mailbox.allowed("captain@gmail.com")     # True — pure, no network
pirate.mailbox.filters                          # standing read defaults, Hub-stored
await pirate.mailbox.configure(
    allowed_senders=["captain@gmail.com"],      # who may drive it   (Hub)
    filters={"labels": "received"},             # read defaults      (Hub)
    poll_interval_seconds=60,                   # how often we poll  (local)
)
await pirate.mailbox.disable()                  # reversible; keeps the address
await pirate.mailbox.release()                  # terminal; mail starts bouncing
```

The Hub owns the allowlist and the read defaults, because the mailbox is what
enforces them — an allowlist a client held privately would be a second answer to
"who may drive this agent". `configure()` writes them there and adopts what the
Hub stored, so casing and de-duplication cannot drift between the two.

`allowed()` is the gate the inbound path runs on every message, so it never
reaches the Hub: the addresses are mirrored locally, `Sharing.PRIVATE`, refreshed
on every reconcile, and read only to apply the policy — never to answer what it
is. An empty allowlist admits **nobody** — the address is public and publicly
writable, so the safe default is the closed one — and a disabled mailbox refuses
everyone regardless of the list.

Send a message from `captain@gmail.com` to `allocated.address` after the loop
starts. `process_messages()` owns the process lifecycle, each email thread gets
its own Agent process, `EmailMessageSpec.reply_to(...)` preserves the email
thread when replying, and `message.reply(...)` sends it and acks the message in
one step — a restart resumes after the last reply and never sends one twice.

When Flowpad's server is running, the agent's placement already answers an active
mailbox — its serve loop (`agents-on-channels.md` §2). Use the explicit loop above
when the Python process owns the workflow, and then take the mailbox off the app's
loop — switch the placement off for it (`agent/<id>/set_place_enabled`) — so the same
mailbox never has two answerers.
