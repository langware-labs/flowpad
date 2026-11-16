---
id: 96d65f94-d9b2-4104-92e6-c306db206dee
---

# Agent deployment — snippets

An `Agent` is the definition (`agent.json` and its folder). A `Deployment` places its whole
PROJECT on a machine, with one optional **main agent** (`main_agent_id`) answering every call
there. The two verbs that start a session (`run`, `use`) go through a deployment, and by default
the project's one local deployment — the seam for choosing another is `deployment=`.

    Project.deploy(actor, provider=..., main_agent=...)   the deployment API (cloud: DEPLOYMENT_STEPS)
    Agent.deploy("local")  -> Deployment        shortcut: its project's local one, the agent as main
    Deployment.launch(...) -> PromptResult      executor: the AgenticProcess

The project recommends its main agent in git (`flow.json` `"mainAgent": "<name>"`); a new deployment
copies it and may name another — stored on the row, never in git, with the agent's launch overrides
(`main_agent_overrides`). What a deployment places is its PARENT (a project), and what it serves is its
endpoints' `subkind` (`system`, `admin`, `app`, `agent`, `service` — `service-endpoints.md`). The machine it runs on
is a `ComputeNode` (a box): this computer hosts many deployments, a cloud box one. `identity` says who
the box logs in as for it: `agent` (the main agent's own identity, shared by its boxes), `deployment` (an
identity of this placement alone), `user` (its owner) or `none`. A box signed in as an identity has a
principal but no user: `get_principal()` / `currentPrincipal` name it, `get_user()` / `currentUser` are empty.

A deployment is also where the agent ANSWERS. A running local deployment **is a process on this
machine running the agent loop** (`python -m flow_sdk.builtin.agent_loop`, §7): plain SDK code in the
same instance, pulling from the channels it answers and replying on them — its `chat` endpoint
(`service-endpoints.md` §6) is one more channel. A source's `answer_place` names the deployment that
answers it; with none set, each running deployment holding the source may answer. Incoming webhook routing is separate: see
[channel webhook routing](channel-webhook-routing.md). Every turn goes through one
turn engine (`flow_sdk/builtin/agent_serve.py`): one process per conversation, one turn at a time, a
redelivered message answered from its record. The app only keeps those processes running.

§1, §3, §4, §6 and §7 are run as written by `tests/unit/test_agent_deployment_snippets.py`;
the contract is pinned by `tests/unit/agent/test_agent_deployment_contract.py` (placement) and
`tests/unit/agent/test_agent_run_dispatch.py` (routing). The spawn itself needs
a real CLI and is the `tests/long_tests/test_process_mcp_multi_vendor.py` leg.

## 1. Place the agent

```python
from flow_sdk.builtin.agent import Agent

agent = Agent(
    name="researcher",
    model="sm",
    system_prompt="You research; you do not summarize.",
    project_id=PROJECT,                        # a deployment places a project
)
await agent.save()

here = await agent.deploy("local")             # the project's ONE local deployment, the agent as main
again = await agent.deploy("local")
assert again.id == here.id                     # converges by lookup, never a derived id

assert here.element_type == "project"          # what it places is its parent: the project
assert here.main_agent_id == str(agent.typeid)
assert here.identity == "agent"                # a box with a main agent logs in as it
assert here.target.provider == "local"
assert here.is_local                           # an id comparison, not a provider test
```

A cloud deployment is the project's (`Project.deploy`, §5); the hub's row is adopted here at
its id. A project may be deployed any number of times; `agent.deployments()` lists those whose
main agent it is.

```python
from flow_sdk.builtin.deployment import Deployment

there = Deployment(                            # what the hub's plan adopts here (§5)
    name="researcher (e2b)",
    parent_type_id=f"project-{PROJECT}",
    main_agent_id=str(agent.typeid),
    target={"provider": "e2b", "scope": "machine"},
)
await there.save()
assert there.id != here.id
assert {d.id for d in await agent.deployments()} == {here.id, there.id}

assert there.compute_node_id is None           # a cloud row with no node is unaddressable
assert there.is_local is False                 # ...and never claims to be here
```

## 2. Start a session on a placement

```python
from flow_sdk.builtin.agentic_process import AgenticProcess

answer = await agent.launch("Find three sources on X.", wait=True)   # local by default
answer = await agent.launch("...", deployment=here, wait=True)       # the same, explicit
proc = await AgenticProcess.get_by_typeid(answer.executor)           # the process, when you need it
```

`launch` is `create_process` + save + first turn, routed through
`dispatch_agent_run`: `agent.run.requested` / `started` / `failed` fire
addressed to the placement's node. It answers a `PromptResult` like every other
call (call-returns): without `wait`, OK means the turn was accepted; with it,
the run's own verdict. A placement that is not on this machine is **not run
here** — an answer, not an exception:

```python
answer = await agent.launch("...", deployment=there)
answer.exit_code                               # ExitCode.NOT_APPLICABLE — "deployed on compute node …"
answer.ran                                     # False — nothing ran here
```

A disabled agent answers `REFUSED`, a turn already in flight `NOT_YET` with
`busy`.

`use` opens the interactive shape — visible, `process_type=chat`, stream-json,
no first turn — keyed to the agent through `target_typeid_str`:

```python
session = await agent.use()                    # acts in the agent's own project
session = await agent.use(project_id=OTHER_PROJECT)   # acts in another project's checkout;
                                               # its own folder rides along as context
```

An agent shows in `OTHER_PROJECT` when its project is one of `OTHER_PROJECT`'s dependencies
(`flow.json`); opened there, it runs in `OTHER_PROJECT`'s folder, its own folder is mounted
and named in its instructions — see [project dependencies](project-dependencies.md) §5.

The primitive under both is the placement's own verb — not saved, not started:

```python
draft = await here.create_process("", pty_mode=False)
draft.cli_config                               # the agent's options, md5'd into last_started_hash
draft.context_data["instructions"]             # the system prompt travels here, never in cli_config
```

## 3. Read a placement

```python
from flow_sdk.builtin.deployment import Deployment

d = await Deployment.find_existing(f"project-{PROJECT}", "local")
await d.main_agent()                           # its main Agent, or None
d.compute_node_id                              # the machine, for a node-backed provider
await d.endpoints()                            # where it is reached: one ServiceEndpoint per service (service-endpoints.md)
await d.health()                               # as healthy as its least healthy service (their last checks)
await d.runs(limit=10)                         # its processes, newest first
```

`runs()` bounds and orders in the query — a long-lived placement would
otherwise hydrate everything it ever produced to hand back ten.

## 4. Stop it, keep the row

```python
paused = await here.pause()                    # on this computer: its process stops, the row stays
assert paused and not here.serving
await here.resume()                            # the app starts its process again
```

Terminate is a pause, not a delete: the row carries the placement's cost and
activity observations. On this computer a pause stops the deployment's process (§7),
never the machine; a cloud row pauses its machine, and a `remote` one is paused by the
hub and comes back down the bridge — nothing is written locally in that case.

## 5. A machine of its own

Live it needs a hub login and publishes through git; `tests/unit/test_agent_deployment_snippets.py` runs
this fence as written with the hub's three legs (publish, plan the placement, deploy) answered by a double.

```python
import flow_sdk
from flow_sdk.activity import Activity
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User

await flow_sdk.auth.login()
agent = await Agent.by_name("researcher")
project = await Project.get_by_id(agent.project_id)
actor = (await User.get_local()).typeid        # the caller
receipt = await project.deploy(actor, provider="e2b", main_agent=agent)   # publishes through git first
deploy = Activity.get(receipt["activity"]["path"], receipt["activity"]["subject_entity"])
await deploy.wait_released()                   # the machine starts after the answer: a script waits for it
```

Deliberately no node and no principal: "were either passable from here they
would be passable from anywhere." The answer comes once the placement is planned
and ready: where the project's `deploy` activity reports, and the placement's id.
The hub then mints the ComputeNode, provisions the Identity and logs the box in
as the agent, and the row is adopted **at the hub's id**
(`Deployment.adopt_from_hub`) — never re-minted; the activity says when the
machine is up. The machine step runs in this process after the answer, so a script
that exits right after `project.deploy` cuts it off: wait for the activity to
end (`wait_released`), then read its state (`deploy.spec().state`). A missing secret does not refuse the deploy — the readiness
step warns (`Secret <name> missing`); `use_mine(deployment_id)` copies this
computer's values and the hub places them on the machine when it starts or when
they are re-placed. Live only.

## 6. Serve it your way — you pick the channels and the routing

A running local deployment (§7) answers every channel the agent owns, each message in its own
conversation. When you want to choose — only some channels, a second agent for some messages, one
session per customer rather than per chat — run the loop yourself over the same pieces:

```python
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.blocks.merge import listen
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import TurnEngine, answer

support = await Agent.by_name("support-bot")
billing = await Agent.by_name("billing-bot")

# 1. The channels: the agent's own, by kind
whatsapp = await support.channel("whatsapp")
telegram = await support.channel("telegram")

# 2. The routing: which agent, and which session (= process), answers
desk    = TurnEngine(support, await support.deploy("local"))
finance = TurnEngine(billing, await billing.deploy("local"))

def route(m):
    if "invoice" in m.body.lower():
        return finance, f"customer/{m.author_external_id}"   # one billing session per customer
    return desk, None                                         # None: the chat's own conversation

# 3. The loop
async with workflow("acme-support"):                          # names the durable cursor
    async for m in listen(StreamInbox.of(whatsapp), StreamInbox.of(telegram)):
        engine, session = route(m)
        await answer(engine, m, session=session)              # gates → turn → reply on m's channel
```

- **`support.channel(kind)`** is the agent's one channel of that kind. It raises when there is
  none, or more than one; then pick from `await support.channels()` yourself.
- **A session is a process.** `TurnEngine` keeps one process per session string on its
  placement and finds it again after a restart, so no routing table lives in your script.
  `answer(engine, m, process=p)` runs the turn on a live process you already hold instead.
- **The routing is yours; the gates are not.** `answer` still drops the agent's own echoes,
  senders the source does not admit, empty and quiet messages, and leaves a
  `replies_explicitly` channel to reply by itself, and a channel that `answers_once` (a help desk) after the
  agent has written in the conversation. A message it does not answer is acked; a turn
  the process refused is not.
- **`workflow(name)` is the cursor.** A restart resumes after the last acked message; without it
  the position lives only as long as the loop.
- **One loop per channel.** A running local deployment of the agent also answers these channels —
  point each source's `answer_place` at the deployment this loop runs as, or don't also run the agent
  here, or two replies go out.

## 7. Run it on this computer — a process per deployment

"This computer" under New deployment is `run_locally()`: the project's ONE local deployment with the agent as main, as its own
process. It answers every channel that names no place (and those that name it). Running it again —
after a pause — starts the same deployment, never a second. It gets its `chat` endpoint — an HTTP
message channel (`subkind` `agent`) — at launch.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

agent = await Agent.by_name("researcher")
here = await agent.run_locally()                # a process on this computer running the agent loop
again = await agent.run_locally()               # the same deployment — one per project here
assert again.id == here.id and here.serving

chat = await ServiceEndpoint.find_existing(str(here.typeid), "chat")
assert chat.backend.type == "channel"           # POST v1/chat/completions → a message → its loop answers
assert chat.subkind == "agent"                  # what it is for: talking to the agent
```

Each deployment runs its own Python file — `~/.flow/instances/<instance>/deployments/<id>.py`, typed as
`python <file> <id>` into the deployment's terminal (a PTY the page shows live, under its thread). The
file is a code snippet: the agent loop itself, shown and editable, its imports and the line that runs
it folded away. A new deployment's file is the stock loop, `flow_sdk/builtin/deployment_loop.py`:

```python
async def answer_every_message(engine, channels, bound, every=None):
    async with workflow(consumer_of(engine.deployment)):  # this deployment's durable position
        async for page in pages(*(StreamInbox.of(c) for c in channels), poll_every=every, poll=False):
            if stopping():
                continue  # paused mid-page: left unacked, handed over again next time
            for message in page:
                if is_history(message, bound[page.source_id]):   # there before the agent took the channel
                    console.info("· %s  written before the channel was bound: history, not answered", page.source_id)
                    await skip_message(message)
                    continue
                await answer(engine, message)                    # gates → turn → reply on its channel
            await page.ack()
```

and the file ends with `main("<id>", loop=answer_every_message)` (`agent_loop.main`): the deployment's
lock (a second copy leaves at once), its console lines on the terminal, and the loop started again
whenever the channels it answers change. Edit the loop and press Restart; the app types the command
again in the same terminal. The app adopts a running loop after its own restart (the lock says who
runs), starts it again if it dies (a Ctrl-C counts), and stops it when the deployment stops serving or
the agent is switched off. `run_locally(snippet=path)` runs that file instead. Proven by
`tests/long_tests/test_local_deployment_process.py` (two agents' deployments, two terminals, each
answering its own chat) and live in a browser by `tests/e2e/deployment_process_validate.cjs`.

## From TypeScript and HTTP

| verb | TS (`ts_sdk/src/entities/agent.ts`) | HTTP |
| --- | --- | --- |
| run once | `agent.run(prompt)` → `{process_id, deployment_id, compute_node_id}` | `POST /agent/<id>/run {prompt}` |
| open a session | `agent.use(projectId?)` | `POST /agent/<id>/use {project_id}` |
| own machine | `project.deploy({mainAgentId})` | `POST /project/<id>/deploy {provider, main_agent_id}` |
| stop the machine | `deployment.pause()` | `POST /deployment/<id>/pause` |

`examples/deployed-agent-chat/index.html` is the whole TS surface in one page —
`Agent.getById` → `agent.use()` → `AgenticProcess.getById` → `prompt` /
`observeTurn` / `loadHistory`. Pinned by `tests/unit/test_deployed_agent_chat_demo.py`.
