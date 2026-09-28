# Flow SDK: Agentic orchestration SDK. Git-native agents you own.

Flow is a git- and file-system-native library for managing and processing data with agents. Build agents and harnesses in a few lines of Python that run on any vendor's models, on your own machines or on-prem, and grow into enterprise-grade agents that keep learning from your data.

Package `flowpad` (Python 3.11+), import `flow_sdk`, CLI `flow`.
Every Python example is quoted verbatim from a documentation page, and CI executes exactly that text;
the few that cannot run yet are marked illustrative. JSON examples are validated against their spec at every build.

## The program this guide explains

```python
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.builtin.agent import Agent

async with workflow("any-channel"):
    # one word = one channel: gmail, slack, telegram, whatsapp
    stream_inbox = StreamInbox("support@acme.com", provider="gmail")
    agent = await Agent.by_name("channel-helper")

    async with agent.process_messages():
        async for m in stream_inbox.listen():
            out = await agent.process_message(m)
            # the reply is addressed the way this channel replies
            await m.reply(out.text)
```

## Two building blocks to power your agentic computing workflows

The two units: `flow.DataSpec` & `flow.AgenticProcess`.

Diagram, role (SDK type): Input (`flow.DataSpec`) -> Your harness (`flow.AgenticProcess`, vendor-agnostic and model-independent: Claude Code, Codex, Copilot, OpenCode, Deep Agents) -> Output (`flow.DataSpec`); Skills & assets (`flow.DataSpec`) from above; Context (`flow.DataSpec`) from below.

### `flow.DataSpec`

The basic unit to manage agentic data, in code and on disk.

In memory, and on the file system after `save()` (`load()` reads it back equal):

```python
from pathlib import Path
from typing import ClassVar

from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text

class Note(DataSpec):
    spec_kind: ClassVar[str] = "notes.note"   # flow.kind
    title: str                                # structured
    body: Text = ""                           # unstructured

note = Note(title="Q3 plan", body="# Goals\n- ship it")
folder = Path("q3-plan")
note.save(folder)                             # note.json + body.md
Note.load(folder) == note                     # True
```

```text
q3-plan/
├── note.json   {&quot;title&quot;: &quot;Q3 plan&quot;}
├── body.md     # Goals
│               - ship it
└── .flow/      its id, kept beside the data
```

`flow.kind`: the type system: every shape has a name, and the name resolves back to its class. `DataSpec.parse("notes.note") is Note`

### `flow.AgenticProcess`

The basic unit to run agentic work

```python
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

process = AgenticProcess(pty_mode=False, visible=False)   # the selected harness
await process.save()

spec = McpSpec(name="playwright", command="npx", args=["-y", "@playwright/mcp"])
assert await process.add_mcp(spec) is True
assert await process.add_mcp(spec) is False      # identical spec: a no-op

await process.prompt("Open https://example.com and tell me the page title.")
```

### Chain them

Any result the SDK generates is a `flow.ReturnedValue`, itself a `flow.DataSpec`, like:

- `cli` — a shell command
- `prompt` — a model call
- `agent` — an agent turn
- `ask` — a user input request

DataSpec in, ReturnedValue out: its `value` is the DataSpec the run produced, so it can be the next step's input.

Chart: IN CVSpec (`flow.DataSpec`: cv.docx | pdf | md) -> CV reviewer (`flow.AgenticProcess`, prompt: “Review and improve the CV, save it with _reviewed”) -> OUT cv_reviewed (`flow.ReturnedValue`, itself a `flow.DataSpec`; exit_code = OK, value = the reviewed CVSpec, text = the agent's message) -> value can be chained next: the next step takes input=cv_reviewed.value.

```python
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text

class CVSpec(DataSpec):
    name: str
    email: str
    skills: list[str] = []
    body: Text = ""                              # the CV itself, as markdown -> body.md

cv = CVSpec(name="Dana Levi", email="dana@x.io", body=CV_TEXT)

cv_reviewed = await AgenticProcess.run("Review and improve the CV, save it with _reviewed", input=cv, output_spec=CVSpec)

cv_reviewed.exit_code                            # ExitCode.OK
cv_reviewed.text                                 # "Your CV was reviewed" — the agent's last message
cv_reviewed.value                                # CVSpec — the reviewed CV, loaded from the output folder
cv_reviewed.value.body.path                      # <record>/execution/output/body.md — where save() writes it
```

## Secrets & credentials

Connecting to data sources, MCPs and APIs takes keys and logins. Flow manages configuration and secrets as named groups of keys and values, compatible with standard .env files and the way you already use them.

Infographic, a secret's life cycle: Declare (`flow.CredentialSpec`, build time: its name and how to obtain it) -> Store (`flow.SecretStore`, this machine: an .env file or the encrypted vault) -> Share (a secret manager, for your team: GCP Secret Manager, or 1Password plugged in).

### CredentialSpec — declare it

At build time: each secret's name, and how to configure or obtain it. No value ever sits in the file.

```json
{
  "schema": 2,
  "name": "telegram",
  "title": "Telegram bot",
  "icon_name": "Telegram",
  "description": "The Bot API token a Telegram data source sends and reads with.",
  "setup": "Create a Telegram bot and store its token.\n1. In Telegram, open a chat with @BotFather (https://t.me/BotFather) and send `/newbot`.\n2. Give it a display name, then a username ending in `bot`. BotFather answers with the token (`123456:ABC-...`).\n3. Store it: pipe the line `TELEGRAM_BOT_TOKEN=<token>` into `flow credentials set telegram --stdin`.\n4. Confirm with `flow credentials check telegram`. Never print or repeat the token.",
  "help_url": "https://t.me/BotFather",
  "value_store": "env",
  "vars": {
    "TELEGRAM_BOT_TOKEN": {
      "label": "Bot token",
      "placeholder": "123456:ABC-...",
      "hint": "From @BotFather (/newbot). The bot's @username is stamped from getMe on first sync.",
      "secret": true,
      "required": true
    }
  }
}
```

### SecretStore — store it

Where the value lives on this machine: the project's .env file or Flow's encrypted vault. One API for both.

```python
from flow_sdk.secrets import MissingSecrets, SecretStore

store = await SecretStore.get()  # current project's .env.local
await store.save({"DATABASE_URL": "postgres://localhost:54322/dev"})

values = await store.load(["DATABASE_URL", "SENTRY_DSN"])  # SENTRY_DSN was never saved: absent
values["DATABASE_URL"].get_secret_value()

await store.names()  # ["DATABASE_URL"]

try:
    await store.validate_keys(["DATABASE_URL", "SENTRY_DSN"])
except MissingSecrets as e:
    e.missing  # ["SENTRY_DSN"] — names only
```

### Secret manager — share it

When a team shares a secret, a manager holds it. GCP Secret Manager ships; others, such as 1Password, plug in with register_store.

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.connections import Connection
from flow_sdk.secrets import SecretStore

agentmail = await DataSource.get("agent mailbox")
remote = await SecretStore.get("gcp_secret_manager", {"gcp_project": "acme-prod", "prefix": "agentmail-production-"})

google = await Connection.get("google")  # remote.connections.names() → ["google"]
await google.validate_scopes(remote.connections.scopes("google"))
await remote.set_connection(google)  # the account comes from the connection, never from config

await remote.validate_keys(agentmail.credentials.names())
await agentmail.set_secret_store(remote)  # the agentmail source now loads its key from GCP
```

### One command, the whole life cycle

flow project setup walks every key and login the project declares, for a person or an agent.

```bash
flow credentials declare secret_pack.json  # declare one in this folder's project (created if none)
flow project setup --dry-run    # what the project needs, and what already holds
flow project setup              # walk it: sign in, type keys, or leave one empty for the AI
flow project setup --no-ai      # never hand a value to the AI setup
flow credentials check telegram # exit 0 when every development value is present
flow credentials set telegram TELEGRAM_BOT_TOKEN=123456:abc  # store one (declares it from its template)
flow credentials set telegram --stdin  # the same, VAR=VALUE lines on stdin: how an agent stores one
flow connections test google --scope https://www.googleapis.com/auth/drive.readonly
```

## Data connectors

Agents are useless without data. Flow connects them to it: simple, secured and customizable.

Infographic: your data (Gmail, Slack, Drive, GitHub, WhatsApp, Telegram, Linear, Teams, RSS) -> Flow connectors (simple · secured · customizable) -> your agent, now with data.

Flow data connectors are managed by two SDK entities:

- `flow.DataDriver` — how Flow connects to a provider, like the Slack driver
- `flow.DataSource` — one specific source of data a driver works with, like a Slack channel or a shared Google Drive

`flow.DataSource` = `flow.DataDriver` + `Config`.

Infographic: one `flow.DataDriver` (the gdrive driver) -> two `flow.DataSource`s: "Team drive" (config `{"drive": "<shared drive id>"}`) and "My Drive" (config `{"drive": ""}`).

Flow defines three types of data sources — what a source's items are, and where they land:

- `flow.ObjectSource` — Files, e.g. Google Drive: Unstructured data in path-driven stores. Its files land on disk and are indexed.
- `flow.RecordSource` — Records, e.g. Jira: Table-driven data. Its issues are kept as rows, updated in place.
- `flow.MessageSource` — Messages, e.g. Slack: Message-driven channels. Threaded into the stream inbox, and answered through the source.

```python
from flow_sdk.builtin.data_driver import DataDriver

drive = await DataDriver.get("gdrive")
jira = await DataDriver.get("jira")
slack = await DataDriver.get("slack")

families = (drive.family, jira.family, slack.family)   # ("object", "record", "message")
answers = (drive.sends, jira.sends, slack.sends)       # (False, False, True)
```

### `flow.SourceItem`

Every source yields items: an origin plus a typed payload. Where they land, and how you read them, is the family's.

Graphic, per family — Google Drive (ObjectSource) → files on disk, indexed, a SourceChange log → open and search the files; Jira (RecordSource) → SourceItem rows updated in place → query and search (SourceItem.get_all()); Slack (MessageSource) → SourceItem rows threaded into the stream inbox → listen() → reply(), each ack moving the position.

#### Files — ObjectSource

Paths. Each file reflects onto disk at its own path (none, copy or symlink); a change is a page of paths.

```python
from pathlib import Path

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.reflect import ReflectMode

driver = await DataDriver.get("gdrive")
src = driver.create_source(
    driver.create_config(cache_root=CACHE_ROOT),  # `drive=...` for a shared drive; empty = My Drive
    name="My Drive",
    reflect=ReflectMode.COPY.value,
    reflect_into=DESTINATION,
)
await src.save()

verdict = await src.verify()  # layer 1: the `google` connection; layer 2: Drive answers /about
verdict["ready"], verdict["layer"], verdict["detail"]

outcome = await src.sync()  # first pass enumerates the drive and takes a change token
sorted(p.name for p in Path(DESTINATION).rglob("*") if p.is_file())
```

#### Records — RecordSource

Tables. Pages of rows whose columns are the record's fields; one line to a DataFrame.

```python
import pandas as pd
from flow_sdk.builtin.data_source import DataSource

issues = await DataSource.get("PROJ issues")           # jira: a RecordSource
async with await issues.open() as live:
    async for page in live.pages(page_size=100):       # a page is a slice of the table
        df = pd.DataFrame([row.data.model_dump() for row in page.items])   # columns = the record's fields
        print(df[["key", "status", "assignee"]])
        await page.ack()
```

#### Messages — MessageSource

Serial. Arrivals come one at a time in order, and each has a reply that goes back the same way.

```python
from flow_sdk.blocks import StreamInbox, SlackMessageSpec, workflow
from flow_sdk.builtin.agent import Agent

async with workflow("channel-helper"):
    stream_inbox = StreamInbox("C0123456789", provider="slack")   # the channel id, not its name
    agent = await Agent.by_name("slack-summarizer")

    async with agent.process_messages():
        async for m in stream_inbox.listen():
            out = await agent.process_message(m)       # session per thread
            await m.reply(SlackMessageSpec.reply_to(m, body=out.text))
```

## `flow.Agent`

An agent is a deployable unit — a DataSpec, like everything else. It exposes interfaces and talks to the outside world: every channel it owns, and HTTP. One agent, many deployments.

Graphic: an Agent — an AgentSpec (a DataSpec) with its channels (phone, chat, mail) and its tools (skills, MCP) — has many Deployments (this computer, its own machine); each answers on the agent's channels and its own HTTP `chat` endpoint, and every call or chat is its own Conversation.

### A DataSpec, like everything else

Validated in memory, a folder on disk, the same save and load.

```python
from pathlib import Path

from flow_sdk.schema.data_spec.agent_spec import AgentSpec

spec = AgentSpec(model="haiku", system_prompt="You answer Acme's phone. Be brief.")
folder = Path("front-desk")
spec.save(folder)                    # agent.json + system_prompt.md, like any DataSpec
AgentSpec.load(folder) == spec       # True
```

### This is all you need to deploy a phone-calling agent

An agent, a phone line it owns, a deployment — every call a Conversation with its address.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver

agent = Agent(name="front-desk", system_prompt="You answer Acme's phone. Be brief.")
await agent.save()

phone = await DataDriver.get("voice_phone")          # Twilio → OpenAI Realtime over SIP
line = phone.create_source(
    phone.create_config(number="+14155550100", project="proj_acme"),
    name="Acme front desk",
    owner=agent,                                     # the agent answers every call on it
    allowed_senders=["+972501234567"],               # who may call; kept on this machine
)
await line.save()
(await line.verify())["ready"]                       # keys set, number on the Twilio account

await agent.run_locally()                            # each call is a Conversation, live
call = await line.start(to="+972501234567", body="Confirm tomorrow's delivery window.")
call.address                                         # ["+972501234567"]: who it is with
```

### Its own process, with HTTP

An agent runs here as one deployment: its own process, with its own chat endpoint.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

agent = await Agent.by_name("researcher")
here = await agent.run_locally()                # a process on this computer running the agent loop
again = await agent.run_locally()               # the same deployment — one per agent here
assert again.id == here.id and here.serving

chat = await ServiceEndpoint.find_existing(str(here.typeid), "chat")
assert chat.backend.type == "channel"           # POST v1/chat/completions → a message → its loop answers
assert chat.subkind == "agent"                  # what it is for: talking to the agent
```

## Nine chapters

1. **Shapes you can trust** (`flow.DataSpec`): Every value is typed, frozen and file-friendly.
2. **Files are the database** (`flow.SourceItem`): Disk is the truth; the index rebuilds from it.
3. **Agents** (`flow.Agent`, `flow.AgenticProcess`): A folder defines it; a process runs it, on any harness.
4. **Orchestration is Python** (`flow.ComputeOp`, `flow.ReturnedValue`): Your loop is the engine. Every call answers the same way.
5. **Data in** (`flow.DataDriver`, `flow.DataSource`): A driver talks to a system; a source is one stream on it.
6. **Every channel** (`flow.StreamInbox`): One loop body answers email, Slack, Telegram and WhatsApp.
7. **Accounts, not tokens** (`flow.Connection`): Sign in once; code asks for the account by name.
8. **Secrets, declared** (`flow.SecretPack`, `flow.SecretStore`): Declarations hold names; values live in a store git never sees.
9. **Place it anywhere** (`flow.Deployment`): Same verbs on this computer or a machine of its own.

## Before you start

```bash
pip install flowpad        # Python 3.11+; or: uv tool install flowpad
flow start                 # runs the local app the SDK talks to
python -m asyncio          # a REPL where top-level `await` works, as in every example
```

Names in CAPITALS in the examples (`KEY`, `FEED_URL`, `PHONE_NUMBER_ID`) are values you supply.

## Chapter 1: Shapes you can trust

`flow.DataSpec` — Every value is typed, frozen and file-friendly.

### Written as JSON

Any document can declare a shape.

```python
from flow_sdk.schema.data_spec import DataSpec, to_authoring_form

Endpoint = DataSpec.parse({"host": "string", "port": "int"})
Endpoint(host="h", port=8099).model_dump()   # {'host': 'h', 'port': 8099}
to_authoring_form(Endpoint)                  # {'host': 'string', 'port': 'int'}
```

### Named kinds

Give a shape a name, and find it by name.

```python
from typing import ClassVar

from flow_sdk.schema.data_spec import DataSpec, to_authoring_form

class Endpoint(DataSpec):
    spec_kind: ClassVar[str] = "demo.endpoint"
    host: str = "localhost"
    port: int

DataSpec.parse("demo.endpoint")   # <class 'Endpoint'> — your class
to_authoring_form(Endpoint)       # 'demo.endpoint'
```

### Fields that are files

Text and bytes get their own file.

```python
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Binary, Text

class Op(DataSpec):
    name: str            # a value    -> op.json
    setup: Text = ""     # a document -> setup.md
    readme: Text = ""    # another    -> readme.md
    icon: Binary = b""   # bytes      -> icon.bin
```

### Identity lives beside it

Save mints an id once, then reuses it.

```python
from pathlib import Path

from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text

class Op(DataSpec):
    name: str
    setup: Text = ""

op = Op(name="pick-port")
root = Path("pick-port")
op.save(root)
# pick-port/op.json                      {"name": "pick-port"}
# pick-port/.flow/capsules/identity.json {"data": {"id": "7c9e6679-…"}, "version": 1}

Op.load(root) == op                 # True — content is equal
```

## Chapter 2: Files are the database

`flow.SourceItem` — Disk is the truth; the index rebuilds from it.

### Everything that arrives is a record

Running it twice converges, never duplicates.

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestMode

src = await DataSource.get(SOURCE)     # the source these items belong to, by name
items = [
    SourceItemSpec(
        data_source_id=src.id,
        provider="agent",
        kind="content.message.email",
        external_id="msg-42",          # provider-native, stable
        name="Invoice #42",
        body="Please find attached...",
        thread_key="thr-7",
        author_external_id="alice@example.com",
    ),
]
report = await ingest_items(items, mode=IngestMode.INCREMENTAL)
report.outcomes                    # one per item: created | updated | unchanged
```

### Search by keyword

From a shell: flow record search "zebrafish" 7d 10

```python
from flow_sdk.builtin.source_item import SourceItem

hits = await SourceItem.search("zebrafish", limit=10)
```

### Search by meaning

A folder becomes a semantic index.

```python
from flow_sdk.builtin.rag_index import RagIndex
from flow_sdk.rag import reconcile

index = await RagIndex.ensure_default()
await index.add_root(NOTES)                  # cover the folder
await index.settle_status()                  # active once a key or a bound endpoint funds it
await reconcile.run_index(index)             # embed only the chunks it has not seen

for hit in await index.search("how does the gitignore walk decide what to skip", top_k=5):
    print(f"{hit.score:.3f}  {hit.doc_ref}  {' / '.join(hit.heading_path)}")
```

### Same records in the browser

A live query: the callback fires on every change.

```js
import * as sdk from '/sdk/flowpad-sdk.js';

await sdk.initSdk();
const request = new sdk.QueryRequest({
  type: 'task',
  scope: [],
  callback: (rows) => render(rows),       // fires whenever the rows change
});
await sdk.dataManager.watchQuery(request);
```

## Chapter 3: Agents

`flow.Agent` · `flow.AgenticProcess` — A folder defines it; a process runs it, on any harness.

### An agent is a folder

agent.json and system_prompt.md, committed like code.

```json
{
  "type": "agent",
  "name": "email-summarizer",
  "description": "Reads your recent mail and tells you what actually needs you. Summarizes what has already been ingested \u2014 it never opens the mailbox itself.",
  "model": "haiku",
  "subagents": [
    "email_summarizer",
    "email_analyzer"
  ],
  "enabled": true
}
```

### Prompt in, reply out

The process lives for the block.

```python
from flow_sdk.blocks import MessageBlock
from flow_sdk.builtin.agent import Agent

channel = MessageBlock.get("simple")
agent = Agent(
    name="pirate",
    system_prompt="Answer like a pirate.",
)
await agent.save()

async with agent.respond_to(channel):
    reply = await channel.send("Where is the treasure?")

print(reply)
```

### Tools travel with the agent

Every process it spawns gets them.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.schema.data_spec.mcp_spec import McpSpec

agent = await Agent.get_one({"name": "researcher"})

await agent.add_mcp(McpSpec(name="linear", transport="http", url="https://mcp.linear.app/sse"))
await agent.add_mcp(McpSpec(name="docs", command="fastmcp", args=["run", "server.py"]))

answer = await agent.launch("Find the open Linear issues assigned to me.", wait=True)
```

### Who pays for tokens

A provider key, a budget, or a harness login.

```python
from flow_sdk.builtin.llm_endpoint import LLMEndpoint

llm = LLMEndpoint(provider="openrouter")          # kind=api_key, base_url and models filled in
vectors = await llm.create_embeddings(["a hot day in July", "a cold night in January"])
answer = await llm.create_completion("You answer in one word.", "Capital of France?")
```

## Chapter 4: Orchestration is Python

`flow.ComputeOp` · `flow.ReturnedValue` — Your loop is the engine. Every call answers the same way.

Chart: Check (`flow.ComputeOp`) -> Run (`flow.ComputeOp`) -> Re-check (`flow.ComputeOp`) -> Answer (`flow.ReturnedValue`)

### Control flow is Python

An if and a continue are the whole filter API.

```python
from flow_sdk.blocks import EmailMessageSpec, StreamInbox
from flow_sdk.builtin.agent import Agent

agent = await Agent.by_name("email-summarizer")
stream_inbox = StreamInbox("me@agentmail.to", api_key=KEY, senders=["boss@corp.com"])

async with agent.process_messages():
    async for m in stream_inbox.listen():
        if "urgent" not in m.name.lower():
            await m.ack()                        # handled: deliberately ignored
            continue
        out = await agent.process_message(m)
        await m.reply(EmailMessageSpec.reply_to(m, body=out.text))
```

### Ask a person, once

The answer is held to a declared shape.

```python
from flow_sdk.builtin.compute_op import ComputeOp

key = await ComputeOp.by_name("get-api-key")
answer = await key.run(approved=True)     # an AskResult
answer.exit_code         # ExitCode.OK once a person answers
answer.value             # 'sk-live-…' — what they typed, held to output_spec_kind
```

### Run twice, it happens once

A check that already holds means ran=False.

```python
from flow_sdk.builtin.compute_op import ComputeOp

key = await ComputeOp.by_name("get-api-key")
answer = await key.run(approved=True)     # the completion check now passes
answer.ok                  # True
answer.ran                 # False — nobody was asked a second time
answer.value               # 'sk-live-…' — read off what the check printed
```

### Nothing raises for an outcome

Raising is opt-in, and the error carries the answer.

```python
import sys
import tempfile
from pathlib import Path

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import CliOp, ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, OpNotReached

tmp = Path(tempfile.mkdtemp())
broken = ComputeOpSpec(name="build", subkind="cli",
                       exe_data=CliOp(commands={sys.platform: "exit 2"}))

refused = await run_op(broken, trusted=False, workdir=tmp)
refused.exit_code, refused.ran            # (ExitCode.REFUSED, False) — not approved; nothing ran
type(refused) is CliResult                # True — the subkind's own class, even here

try:
    (await run_op(broken, trusted=True, workdir=tmp)).raise_for_status()
except OpNotReached as failed:
    carried = failed.answer
carried.returncode                        # 2 — the exception CARRIES the result
```

## Chapter 5: Data in

`flow.DataDriver` · `flow.DataSource` — A driver talks to a system; a source is one stream on it.

Chart: Driver (`flow.DataDriver`) -> Source (`flow.DataSource`) -> Items (`flow.SourceItem`)

### Connect a feed

A second sync of an unchanged feed writes nothing.

```python
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.source_item import SourceItem

driver = await DataDriver.get("rss")
config = driver.create_config(feed_url=FEED_URL)  # optional: validates now; a plain dict is validated on save()
src = driver.create_source(config, name="Hacker News front page")
await src.save()  # writes data_source.json; NEW → ACTIVE; channel and origin stamped

outcome = await src.sync()
outcome.created, outcome.updated, outcome.unchanged  # what this cycle did

rows = await SourceItem.get_all({"data_source_id": src.id})
for item in rows:
    item.name, item.permalink, item.occurred_at, item.body[:80]
```

### Operate it

The verbs behind the Data Sources screen.

```python
from flow_sdk.builtin.data_source import DataSource

src = await DataSource.get(SOURCE)
await src.verify()          # connection + setup probe → status ACTIVE or SETUP
await src.poll_now()        # mark due; the heartbeat picks it up within 60s
await src.replay(since=None)   # re-emit item events from what is stored
await src.reset()           # forget the position (cursor), keep rows
await src.purge_items()     # drop rows AND their read/starred state
await src.delete()          # cascade: items, projected messages
```

### Write your own driver

Three methods; paging, get and fetch come free.

```python
from typing import Any, Optional

from flow_sdk.sources.base import CollectionSource
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.families import RecordSource
from flow_sdk.sources.values.items import RecordData, SourceItemSpec

ROWS = {"q1": "Simple is better than complex.", "q2": "Flat is better than nested.", "q3": "Readability counts."}


class ZenSource(RecordSource, CollectionSource):
    Config = SourceConfig
    provider = "zen"

    async def _scan(self, query: Any) -> list[tuple[str, str]]:   # list what exists, in key order
        return sorted(ROWS.items())

    async def _lookup(self, key: str) -> Optional[str]:           # find one by key
        return ROWS.get(key)

    def _item(self, key: str, raw: str) -> SourceItemSpec:        # one raw record -> a typed item
        return SourceItemSpec(origin=self.origin(key), data=RecordData(title=key, text=raw))


async with ZenSource(SourceBinding(config={}, account_key="zen")) as zen:   # the account it reads as
    page = await zen.fetch(page_size=2)
    [item.data.text for item in page.items]        # the first two, in key order
    await zen.get(zen.origin("q3"))                # one by key
```

## Chapter 6: Every channel

`flow.StreamInbox` — One loop body answers email, Slack, Telegram and WhatsApp.

Chart: Channel (`flow.DataSource`) -> Stream inbox (`flow.StreamInbox`) -> Agent (`flow.AgenticProcess`) -> Reply (`flow.DataSpec`)

### Let the app answer

Give the agent a channel; nothing of yours keeps running.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver

agent = Agent(name="support-bot",
              system_prompt="You answer WhatsApp messages for Acme support. One short paragraph.")
await agent.save()
await agent.run_locally()                      # a process on this machine runs its loop and answers

whatsapp = await DataDriver.get("whatsapp")
source = whatsapp.create_source(
    whatsapp.create_config(phone_number_id=PHONE_NUMBER_ID, verify_token=VERIFY_TOKEN),
    name="Acme support line",
    owner=agent,                               # the agent's stream inbox; the agent answers
    allowed_senders=[CUSTOMER],        # who may drive it — empty admits nobody
)
await source.save()
verdict = await source.verify()                # ACTIVE once the token works
```

### Several sources, one loop

Each item acks only its own source.

```python
from flow_sdk.blocks import EmailMessageSpec, FolderChange, FolderChanges, StreamInbox, listen, workflow
from flow_sdk.builtin.agent import Agent

async with workflow("triage"):
    stream_inbox = StreamInbox("me@agentmail.to", api_key=KEY)
    docs = FolderChanges(SRC)
    agent = await Agent.by_name("triager")

    async with agent.process_messages():
        async for item in listen(stream_inbox, docs): # merged; each item carries ITS source's ack
            if isinstance(item.item, FolderChange):
                await item.ack()                      # a folder page: acknowledged, not answered
                continue
            out = await agent.process_message(item)
            await item.reply(EmailMessageSpec.reply_to(item, body=out.text))   # send → record → ack
```

## Chapter 7: Accounts, not tokens

`flow.Connection` — Sign in once; code asks for the account by name.

### See what you can connect

The same catalogue in Python, the CLI and the app.

```console
$ python -m asyncio
asyncio REPL ...
>>> from flow_sdk.connections import get_connections
>>> connections = await get_connections()
>>> [(c.provider, c.connected) for c in connections]
[('flowpad_account', False), ('claude', True), ('codex', True), ('copilot', True), ('opencode', False), ('anthropic', False), ('atlassian', False), ('flowpad', False), ('github', False), ('gitlab', False), ('google', False), ('linear', False), ('slack', False)]
>>> slack = next(c for c in connections if c.provider == "slack")
>>> slack = await slack.connect()
>>> slack.connected
True
>>> (await slack.test()).ok
True
```

### Require it in code

A cheap gate, then a token when the provider allows it.

```python
from flow_sdk.connections import NotConnected, TokenUnavailable, get_connections, require

try:
    slack = await require("slack")
except NotConnected:
    slack = next(c for c in await get_connections() if c.provider == "slack")
    slack = await slack.connect()

try:
    token = await slack.token()
except TokenUnavailable:
    token = None  # Use the SDK driver/block; this provider keeps its token on the Hub.
```

### A driver asks for an account

Scopes in the manifest; no token in config.

```json
{ "auth": { "connector": "google", "scopes": ["https://www.googleapis.com/auth/drive.readonly"] } }
```

## Chapter 8: Secrets, declared

`flow.SecretPack` · `flow.SecretStore` — Declarations hold names; values live in a store git never sees.

Chart: Declare (`flow.SecretPack`) -> Check (`flow.SecretStore`) -> Bind (`flow.DataSource`)

### Declare, never paste

The setup text guides a person or an agent.

```json
{
  "schema": 2,
  "name": "telegram",
  "title": "Telegram bot",
  "icon_name": "Telegram",
  "description": "The Bot API token a Telegram data source sends and reads with.",
  "setup": "Create a Telegram bot and store its token.\n1. In Telegram, open a chat with @BotFather (https://t.me/BotFather) and send `/newbot`.\n2. Give it a display name, then a username ending in `bot`. BotFather answers with the token (`123456:ABC-...`).\n3. Store it: pipe the line `TELEGRAM_BOT_TOKEN=<token>` into `flow credentials set telegram --stdin`.\n4. Confirm with `flow credentials check telegram`. Never print or repeat the token.",
  "help_url": "https://t.me/BotFather",
  "value_store": "env",
  "vars": {
    "TELEGRAM_BOT_TOKEN": {
      "label": "Bot token",
      "placeholder": "123456:ABC-...",
      "hint": "From @BotFather (/newbot). The bot's @username is stamped from getMe on first sync.",
      "secret": true,
      "required": true
    }
  }
}
```

### Store and validate

The project's .env.local, the vault, or GCP.

```python
from flow_sdk.secrets import MissingSecrets, SecretStore

store = await SecretStore.get()  # current project's .env.local
await store.save({"DATABASE_URL": "postgres://localhost:54322/dev"})

values = await store.load(["DATABASE_URL", "SENTRY_DSN"])  # SENTRY_DSN was never saved: absent
values["DATABASE_URL"].get_secret_value()

await store.names()  # ["DATABASE_URL"]

try:
    await store.validate_keys(["DATABASE_URL", "SENTRY_DSN"])
except MissingSecrets as e:
    e.missing  # ["SENTRY_DSN"] — names only
```

### One command sets up a project

Walks every account and key the project needs.

```bash
flow credentials declare secret_pack.json  # declare one in this folder's project (created if none)
flow project setup --dry-run    # what the project needs, and what already holds
flow project setup              # walk it: sign in, type keys, or leave one empty for the AI
flow project setup --no-ai      # never hand a value to the AI setup
flow credentials check telegram # exit 0 when every development value is present
flow credentials set telegram TELEGRAM_BOT_TOKEN=123456:abc  # store one (declares it from its template)
flow credentials set telegram --stdin  # the same, VAR=VALUE lines on stdin: how an agent stores one
flow connections test google --scope https://www.googleapis.com/auth/drive.readonly
```

## Chapter 9: Place it anywhere

`flow.Deployment` — Same verbs on this computer or a machine of its own.

Chart: Agent (`flow.Agent`) -> Placement (`flow.Deployment`) -> Session (`flow.AgenticProcess`)

### Place it

deploy() converges on the placement it already has.

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

assert here.element_type == "agent"            # what it places is its parent — no stored kind
assert here.identity == "agent"                # a box it runs on logs in as the agent
assert here.target.provider == "local"
assert here.is_local                           # an id comparison, not a provider test
```

### Run it on this computer

One process per deployment, each with a chat endpoint.

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

agent = await Agent.by_name("researcher")
here = await agent.run_locally()                # a process on this computer running the agent loop
again = await agent.run_locally()               # the same deployment — one per agent here
assert again.id == here.id and here.serving

chat = await ServiceEndpoint.find_existing(str(here.typeid), "chat")
assert chat.backend.type == "channel"           # POST v1/chat/completions → a message → its loop answers
assert chat.subkind == "agent"                  # what it is for: talking to the agent
```

### Serve it your way

Two agents, two channels, your routing.

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

## Rules for coding agents

```text
You are building on the Flow SDK (Python package `flowpad`, import `flow_sdk`, CLI `flow`).
Read the Flow SDK guide in flow-sdk.md before writing code. Follow its rules:
- Every value you pass or return is a DataSpec subclass (frozen, extra="forbid"); never a bare dict.
- Integrations are data driver folders: agentic-assets/data_driver/<name>/ with data_driver.json and one Source subclass in source.py.
- Never put a secret in config. Declare it in a credential (secret_pack.json with a `setup` text) and read it from a SecretStore; accounts come from connections.
- In a listen() loop, give every item exactly one ack() or reply().
- Read ReturnedValue.exit_code instead of catching exceptions for outcomes.
- Run `flow project setup --dry-run` to see what the project still needs.
```
