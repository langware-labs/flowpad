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
message it did not write itself. The driver picks the ticket up and answers the
requester, masked to the desk's brand. Whether a turn's closing text is sent at all is
the Agent's `reply_mode` (`never | auto | always`): `auto`, which a help desk declares as
its default, sends it while nobody on the team has picked the ticket up and goes quiet
once a person has.

A desk can have two agents with a hard boundary between them. The **support agent** is
the one above: it talks to the customer, and it is untrusted, so it writes to the team
side only as *guest messages* (`flow conversation guest <ticket id> "<text>"`) that the hub screens
before anyone there can read them; it cannot read the team's conversation. The **internal agent**
owns a `flow_conversation` source over the desk's team conversations: it runs the RCA, works
with the team and never talks to the customer. It is called by a guest message that passed
screening, or by a person tagging it; it reaches the support agent only with a *steer*, which
answers a status and never the support agent's words. The desk's page sets both up from its
Support agent / Team agent rows and tells the hub which is which (`project/<desk>/helpdesk_agents`).

The support agent runs only in the cloud: the desk's page saves its source, then deploys its
project the way `flow agent deploy` does (`Project.deploy`), and the machine signs in as the
agent's own hub Identity — never on the desk owner's computer under the owner's login. That
machine is the one place answering the desk (the driver's `single_place`), so a person's
pickup, the owner's included, is always a person's. The internal agent runs on the owner's
computer. The snippet above makes the source; deploy the agent's project to put it to work.

`create_source(..., allowed_senders=[...])` restricts the desk to those hub user
ids; leaving it empty keeps the desk open. Pausing the source (the switch on the
stream inbox line, or `status="disabled"`) stops both polling and answering.
