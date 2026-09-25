---
id: 96d65f94-d9b2-4104-92e6-c306db206dee
---

# Agent deployment — snippets

An `Agent` is the definition (`agent.md` and its folder). A `Deployment` is
one placement of it: *this agent runs on that machine*. The two verbs that
start a session (`run`, `use`) go through a placement, and today every caller
resolves the `local` one — the seam for choosing another is `deployment=`.

    Agent.deploy(provider)  -> Deployment        kind "runtime.agent"
    Deployment.launch(...)  -> PromptResult      executor: the AgenticProcess

A deployment is also where the agent ANSWERS. A running local deployment **is a process on this
machine running the agent loop** (`python -m flow_sdk.builtin.agent_loop`, §7): plain SDK code in the
same instance, pulling from the channels it answers and replying on them — its `chat` endpoint
(`service-endpoints.md` §6) is one more channel. A source's `answer_place` names the deployment that
answers it; a source that names none is the default local deployment's. Every turn goes through one
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
)
await agent.save()

here = await agent.deploy("local")             # "This computer" — nothing is placed until you ask
again = await agent.deploy("local")
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
await d.endpoints()                            # where it is reached: one ServiceEndpoint per service (service-endpoints.md)
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

Live only — it needs a hub login and publishes through git; no test runs this fence.

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
  `replies_explicitly` channel to reply by itself. A message it does not answer is acked; a turn
  the process refused is not.
- **`workflow(name)` is the cursor.** A restart resumes after the last acked message; without it
  the position lives only as long as the loop.
- **One loop per channel.** A running local deployment of the agent also answers these channels —
  point each source's `answer_place` at the deployment this loop runs as, or don't also run the agent
  here, or two replies go out.

## 7. Run it on this computer — a process per deployment

"This computer" under New deployment is `run_locally()`: one more local deployment, each its own
process. The first takes the default slot and answers every channel that names no place; the next
ones (`"2"`, `"3"`, …) answer only what names them. Each gets its `chat` endpoint — an HTTP message
channel — at launch.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

agent = await Agent.by_name("researcher")
first = await agent.run_locally()               # a process on this computer running the agent loop
second = await agent.run_locally()              # one more — its own process, its own chat
assert (first.slot, second.slot) == ("", "2") and first.serving and second.serving

chat = await ServiceEndpoint.find_existing(str(second.typeid), "chat")
assert chat.backend.type == "channel"           # POST v1/chat/completions → a message → its loop answers
```

Each deployment runs its own Python file — `~/.flow/instances/<instance>/deployments/<id>.py`, typed as
`python <file> <id>` into the deployment's terminal (a PTY the page shows live, under its thread). The
file is a code snippet: the agent loop itself, shown and editable, its imports and the line that runs
it folded away. A new deployment's file is the stock loop, `flow_sdk/builtin/deployment_loop.py`:

```python
async def answer_every_message(engine, channels, bound, every=None):
    async with workflow(consumer_of(engine.deployment)):  # this deployment's durable position
        async for page in pages(*(StreamInbox.of(c) for c in channels), poll_every=every, poll=False):
            for message in page:
                if is_history(message, bound[page.source_id]):   # there before the agent took the channel
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
`tests/long_tests/test_local_deployment_process.py` (two deployments, two terminals, each answering its
own chat) and live in a browser by `tests/e2e/deployment_process_validate.cjs`.

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
