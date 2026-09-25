---
id: 27a144cb-ba9d-4ea8-bb66-b19430de319f
---
# Agent help desk

Give an Agent a hub help desk to answer. A desk is a hub project with
`helpdesk.enabled`; tickets are the conversations guests open against it. The
Agent owns the desk as a message source and answers every ticket — a help desk
exists for people nobody listed, so an empty allowlist is open, not closed.

```python
import flow_sdk
from flow_sdk.builtin.agent import Agent

await flow_sdk.auth.login()

support = Agent(
    name="support",
    model="sm",
    system_prompt="You are first-line support. Answer in two sentences, then ask one question.",
)
await support.save()

# bind_channel is the one door for a channel that already exists: the desk is
# on the hub, and this login is a member of it. The source it adopts (or
# creates) is born owned by the Agent, so its replies are attributed to the
# Agent and the desk appears on the Agent's stream inbox line, not yours.
desk = await support.bind_channel(provider="helpdesk", channel=DESK_PROJECT_ID)
assert desk.provider == "helpdesk" and desk.config["desk_project_id"] == DESK_PROJECT_ID
```

Pinned by `tests/unit/test_agent_helpdesk_snippet.py` (hub legs stubbed) and
live by `tests/hub_tests/test_helpdesk_source_roundtrip.py`.

From here the built-in stream inbox runtime does the rest while Flowpad's server runs:
each poll lists the desk's pool, ingests a ticket's messages onto the hub's own
ids, projects them into the Agent's stream inbox, and runs the Agent on every inbound
message it did not write itself. Its reply goes back through the same source —
the driver picks the ticket up first, since the hub fans a ticket out to
participants only — and the hub masks it to the desk's brand.

`bind_channel(..., allowed_senders=[...])` restricts the desk to those hub user
ids; leaving it empty keeps the desk open. Pausing the source (the switch on the
stream inbox line, or `status="disabled"`) stops both polling and answering.
