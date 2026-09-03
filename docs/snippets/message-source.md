# Simple message source

Use the process-local message source when all you need is prompt/reply: one
side sends a string, and one listener produces its answer. This source has no
address, provider, inbox, or persisted rows.

```python
from flow_sdk.blocks import MessageSource
from flow_sdk.builtin.agent import Agent

channel = MessageSource.get("simple")
agent = Agent(
    name="pirate",
    worker_type="claude",
    system_prompt="Answer like a pirate.",
)
await agent.save()

async with agent.respond_to(channel):
    reply = await channel.send("Where is the treasure?")

print(reply)
```

`respond_to()` owns the listener and the Agent's process lifecycle. `send()`
returns the plain reply string; sending outside that scope fails immediately
instead of hiding an unconsumed prompt. A channel accepts one listener, while
concurrent sends remain correlated with their own replies.
