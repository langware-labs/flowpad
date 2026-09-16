---
id: 96d65f94-d9b2-4104-92e6-c306db206dee
---

# Agent deployment — snippets

An `Agent` is the definition (`agent.md` and its folder). A `Deployment` is
one placement of it: *this agent runs on that machine*. The two verbs that
start a session (`run`, `use`) go through a placement, and today every caller
resolves the `local` one — the seam for choosing another is `deployment=`.

    Agent.deploy(provider)  -> Deployment        kind "runtime.agent"
    Deployment.launch(...)  -> AgenticProcess

Pinned by `tests/unit/agent/test_agent_deployment_contract.py` (placement) and
`tests/unit/agent/test_agent_run_dispatch.py` (routing). The spawn itself needs
a real CLI and is the `tests/long_tests/test_process_mcp_multi_vendor.py` leg.

## 1. Place the agent

```python
from flow_sdk.builtin.agent import Agent

agent = Agent(
    name="researcher",
    worker_type="claude",
    model="sm",
    permission_mode="bypassPermissions",
    system_prompt="You research; you do not summarize.",
)
await agent.save()

here = await agent.local_deployment()          # get-or-create, provider "local"
again = await agent.local_deployment()
assert again.id == here.id                     # converges by lookup, never a derived id

assert here.kind == "runtime.agent"
assert here.target.provider == "local"
assert here.is_local                           # an id comparison, not a provider test
```

`deploy()` is idempotent **per provider**: `find_existing` matches
`(parent_type_id, target.provider, kind)`, so a second provider is a second
row, and re-deploying the same one converges on the row it already has.

```python
there = await agent.deploy("e2b")
assert there.id != here.id
assert {d.id for d in await agent.deployments()} == {here.id, there.id}

assert there.compute_node_id is None           # a cloud row with no node is unaddressable
assert there.is_local is False                 # ...and never claims to be here
```

## 2. Start a session on a placement

```python
proc = await agent.launch("Find three sources on X.", wait=True)     # local by default
proc = await agent.launch("...", deployment=here, wait=True)         # the same, explicit
```

`launch` is `create_process` + save + first turn, routed through
`dispatch_agent_run`: `agent.run.requested` / `started` / `failed` fire
addressed to the placement's node, and a placement that is not on this machine
is **refused** rather than quietly run here.

```python
try:
    await agent.launch("...", deployment=there)
except NotImplementedError as e:
    ...                                        # "deployed on compute node …, cannot be reached from here yet"
```

`use` opens the interactive shape — visible, `process_type=chat`, stream-json,
no first turn — keyed to the agent through `target_typeid_str`:

```python
session = await agent.use()                    # acts in the agent's own project
session = await agent.use(project_id=other)    # acts in another project's checkout
```

The primitive under both is the placement's own verb — not saved, not started:

```python
draft = await here.create_process("", pty_mode=False)
draft.cli_config                               # the agent's options, md5'd into last_started_hash
draft.context_data["instructions"]             # the system prompt travels here, never in cli_config
```

## 3. Read a placement

```python
from flow_sdk.builtin.deployment import KIND_AGENT, Deployment

d = await Deployment.find_existing(str(agent.typeid), "local", kind=KIND_AGENT)
await d.agent()                                # the placed Agent, or None
d.compute_node_id                              # the machine, for a node-backed provider
d.host_url                                     # where a human reaches it, if anywhere
await d.runs(limit=10)                         # its processes, newest first
```

`runs()` bounds and orders in the query — a long-lived placement would
otherwise hydrate everything it ever produced to hand back ten.

## 4. Stop the machine, keep the row

```python
paused = await here.pause()                    # False when there is no machine to stop
```

Terminate is a pause, not a delete: the row carries the placement's cost and
activity observations. A `remote` row is paused by the hub and comes back down
the bridge; nothing is written locally in that case.

## 5. A machine of its own

```python
import flow_sdk

await flow_sdk.auth.login()
receipt = await agent.deploy_to_cloud(actor)   # actor: the caller's TypeId; publishes through git first
```

Deliberately no node and no principal: "were either passable from here they
would be passable from anywhere." The hub mints the ComputeNode, provisions the
Identity, logs the box in as the agent, and the returned row is adopted **at
the hub's id** (`Deployment.adopt_from_hub`) — never re-minted. Live only; the
unit tier stops at the refusal in §2.

## From TypeScript and HTTP

| verb | TS (`ts_sdk/src/entities/agent.ts`) | HTTP |
| --- | --- | --- |
| run once | `agent.run(prompt)` → `{process_id, deployment_id, compute_node_id}` | `POST /agent/<id>/run {prompt}` |
| open a session | `agent.use(projectId?)` | `POST /agent/<id>/use {project_id}` |
| own machine | `agent.deploy()` | `POST /agent/<id>/deploy` |
| stop the machine | `deployment.pause()` | `POST /deployment/<id>/pause` |

`examples/deployed-agent-chat/index.html` is the whole TS surface in one page —
`Agent.getById` → `agent.use()` → `AgenticProcess.getById` → `prompt` /
`observeTurn` / `loadHistory`. Pinned by `tests/unit/test_deployed_agent_chat_demo.py`.
