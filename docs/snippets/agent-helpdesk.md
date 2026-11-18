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
from flow_sdk.builtin.data_driver import DataDriver

await flow_sdk.auth.login()

support = Agent(
    name="support",
    model="sm",
    system_prompt="You are first-line support. Answer in two sentences, then ask one question.",
)
await support.save()

# The desk is on the hub, and this login is a member of it. The source is born
# owned by the Agent, so its replies are attributed to the Agent and the desk
# appears on the Agent's stream inbox line, not yours. Saving it again adopts it.
helpdesk = await DataDriver.get("helpdesk")
desk = helpdesk.create_source(
    helpdesk.create_config(desk_project_id=DESK_PROJECT_ID),
    name="Support desk",
    owner=support,
)
await desk.save()
assert desk.provider == "helpdesk" and desk.config["desk_project_id"] == DESK_PROJECT_ID
```

Pinned by `tests/unit/test_agent_helpdesk_snippet.py` (hub legs stubbed) and
live by `tests/hub_tests/test_helpdesk_source_roundtrip.py`.

From here the built-in stream inbox runtime does the rest while Flowpad's server runs:
each poll lists the desk's pool, ingests a ticket's messages onto the hub's own
ids, projects them into the Agent's stream inbox, and runs the Agent on every inbound
message it did not write itself. Where its reply goes is the source's own config:

- `moderated=True` (what the desk page's Customer agent setup turns on): the reply waits in the ticket's team conversation as a
  draft; a person on the staff sends it (as written or edited), which picks the ticket up
  for them, or discards it.
- `moderated=False` (the default, and a person's own desk source): the driver picks the ticket up and answers the requester directly,
  masked to the desk's brand.
- `side="team"`: every word goes to the team conversation as a note; nothing reaches the
  requester.

The agent answers a ticket nobody has picked up (`reply_not_picked_up`) and one where
someone wrote `@agent` (`reply_tagged`); once a person has the ticket it stays quiet
unless tagged. The desk's page sets all of this up from its Customer agent / Team agent
rows.

`create_source(..., allowed_senders=[...])` restricts the desk to those hub user
ids; leaving it empty keeps the desk open. Pausing the source (the switch on the
stream inbox line, or `status="disabled"`) stops both polling and answering.
