# Agent email

This uses the Gmail message source from
[`gmail-message-source.md`](gmail-message-source.md) to email an Agent and wait
for its reply.

```python
import flow_sdk
import flow_sdk.ingest.drivers  # noqa: F401 — register shipped drivers
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import EmailMessageSpec

gmail = await DataSource.get_one({"name": "gmail"})
assert gmail is not None

await flow_sdk.auth.login()

pirate = Agent(
    name="pirate",
    worker_type="claude",
    model="sm",
    system_prompt="Answer like a pirate. Include 'arr' in every reply.",
    email_allowed_senders=[gmail.account_key],
)
await pirate.save()
assert pirate.inbox is None
inbox = await pirate.enableEmail()
assert pirate.inbox is inbox

sent = await gmail.send(
    EmailMessageSpec(
        to=[inbox.address],
        subject="Treasure",
        body="Where is the treasure?",
    )
)
reply = await gmail.expect_reply(sent)

assert reply.author_external_id == inbox.address
assert "arr" in reply.body.lower()
```

`enableEmail()` is login-gated and idempotent: it enables the Agent's email
policy, the Hub owns one formal inbox per Agent, and the SDK ensures one
`cloud_email` source polls it.
