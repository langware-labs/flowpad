# Agent email

Allocate the Agent's formal Hub inbox, then process each incoming email through
the Agent and send a threaded reply through that same inbox.

```python
import flow_sdk
import flow_sdk.ingest.drivers  # noqa: F401 — register shipped drivers
from flow_sdk.builtin.agent import Agent
from flow_sdk.blocks import EmailMessageSpec, Inbox, workflow

await flow_sdk.auth.login()

pirate = Agent(
    name="pirate",
    worker_type="claude",
    model="sm",
    system_prompt="Answer like a pirate. Include 'arr' in every reply.",
    email_allowed_senders=["captain@gmail.com"],
)
await pirate.save()
assert pirate.inbox is None
allocated = await pirate.enableEmail()
assert pirate.inbox is allocated

# Inbox is the message-facing view over the cloud_email DataSource created by
# enableEmail(). agent_id is the stable mailbox identity; the address is not.
mail = Inbox(
    allocated.address,
    provider="cloud_email",
    agent_id=pirate.id,
    senders=pirate.email_allowed_senders,
)
async with pirate.process_messages():
    async with workflow("pirate-email"):
        async for message in mail.listen():
            output = await pirate.process_message(message)
            await message.reply(EmailMessageSpec.reply_to(message, body=output.text))
```

Pinned by `tests/unit/test_agent_email_snippet.py` (Hub legs stubbed, scripted
mail, mock worker) and live by `tests/hub_tests/test_agent_email_conversation.py`.

`enableEmail()` is login-gated and idempotent: it enables the Agent's email
policy, the Hub owns one formal inbox per Agent, and the SDK ensures one
`cloud_email` source polls it. `Inbox.listen()` is the public listening surface
over that `DataSource`; `DataSource` itself does not expose `listen()`.

Send a message from `captain@gmail.com` to `allocated.address` after the loop
starts. `process_messages()` owns the process lifecycle, each email thread gets
its own Agent process, and
`EmailMessageSpec.reply_to(...)` preserves the email thread when replying, and
`message.reply(...)` sends it and acks the message in one step — a restart
resumes after the last reply and never sends one twice.

When Flowpad's server is running, its built-in inbox runtime already performs
this processing for enabled Agents. Use the explicit loop above when the Python
process owns the workflow; do not run both processors for the same inbox.
