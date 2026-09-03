# Pipes — wiring a source to whatever consumes it

How data gets from a source to the thing that wants it. Two halves: what runs
today, and what the design review says to add.

Every snippet below is run as written by `tests/unit/test_pipes_snippets.py`.

## 1. One source, one cycle

`sync()` runs a full cycle inline and never raises — a failure is recorded as
health, not thrown. The cursor advances only after the write lands.

```python
from flow_sdk.builtin.data_source import DataSource
import flow_sdk.ingest.drivers          # registers the shipped providers

source = DataSource(name="Notes", provider="folder", config={"root": "/src"})
await source.save()
await source.verify()      # is the setup finished?
report = await source.sync()   # one cycle, now
```

The HTTP verb `poll_now` does NOT do this — it marks the source due for the next
heartbeat tick (≤60s). Use `sync()` when you want it now.

## 2. Mirror one folder into another, and follow it

No new driver: `folder` + `copy` is a folder→folder mirror. Edits, additions and
deletions all propagate, because the driver diffs `{rel_path: [mtime, size,
inode]}` and so *observes* absence rather than guessing it.

```python
source = DataSource(
    name="Mirror notes",
    provider="folder",
    reflect=ReflectMode.COPY.value,     # record | none | copy | symlink
    reflect_into="/dest",               # absolute
    config={"root": "/src"},
)
```

The same folder as a block, with the changes as a stream you can follow:

```python
from flow_sdk.blocks import Folder, workflow

async with workflow("mirror"):                        # the name IS the consumer identity
    docs = Folder(SRC, mirror_to=DEST)               # finds (or creates) the source above
    async for change in docs.listen():                # change: FolderChange(added, changed, removed, renamed)
        change.added, change.removed                  # canonical absolute paths
        await change.ack()                            # position commits LAST — at-least-once
```

A page handed out and never acked comes back after a restart with
`change.redelivered` set. Outside a `workflow()` the position lives only for the
loop; the name is what buys durability.

> **Recommended:** treat the stat diff as a *candidacy filter*, never as the last
> word on "changed". Same-size edits inside one mtime tick are invisible to it —
> the hole git calls *racy-git*. rsync solves it the same way: size as the
> filter, checksum as the truth. Anything correctness-critical downstream (the
> RAG index) should keep hashing.

> **Recommended:** `inode` is a hint, not identity. Windows reports bogus values,
> ext4 reuses an inode immediately after a delete, NFS numbers move on remount.
> Fine for pairing a rename within one pass; confirm with a content hash before
> treating a move as identity-preserving.

## 3. React to a change instead of polling

Every source announces changes on one tag. The payload names WHAT moved and
WHERE — never the bytes — so a replayed or duplicated event is harmless.

```python
from flow_sdk.tags import on_tag

def on_change(event):
    data = event.data
    print(data["source_id"], data["refs"], data["tombstones"])

off = on_tag("ingest.*.change.received", on_change)   # returns an unsubscribe
```

`refs` is an optimization, never a guarantee: a producer that knows exactly what
moved says so, one that does not sends none, and the receiver falls back to
asking the source.

## 4. Cadence

Two rates, two owners. The row owns the heartbeat's: `poll_interval_seconds`,
never below a minute, quantized to the tick. A loop owns its own: `poll_every`
on `listen()`, which drives the source through the poller's slot so the two can
never poll it at once.

```python
from flow_sdk.blocks import Folder

docs = Folder(SRC)
async for change in docs.listen(poll_every=0.5):    # seconds between THIS loop's polls
    await change.ack()
```

`listen()` on a source still `NEW` or `SETUP` works — a local loop legitimately
drives a source the heartbeat would not. The attention fast lane is a different
mechanism (a viewer's lease) and `listen()` deliberately does not use it.

## 5. An agent on several sources

```python
from flow_sdk.blocks import EmailMessageSpec, Folder, FolderChange, Inbox, listen, workflow
from flow_sdk.builtin.agent_registry import get_agent

async with workflow("triage"):
    inbox = Inbox("me@agentmail.to", api_key=KEY)
    docs  = Folder(SRC)
    agent = await get_agent("triager")

    async with agent.process_messages():
        async for item in listen(inbox, docs):        # merged; each item carries ITS source's ack
            if isinstance(item.item, FolderChange):
                await item.ack()                      # a folder page: acknowledged, not answered
                continue
            out = await agent.process_message(item)
            await item.reply(EmailMessageSpec.reply_to(item, body=out.text))   # send → record → ack
```

`listen(*sources)` is a function, like `asyncio.gather`: one loop, arrival order,
and acking an item moves only its own source's position. One source raising is
loud — the merge cancels the others and re-raises — never a quietly dropped
source.

The agent turn is safe to repeat: a redelivered item answers from the recorded
turn instead of prompting again.

## 6. Keep a search index level with a folder

```python
from flow_sdk.blocks import Folder, SearchIndex, workflow

async with workflow("docs-rag"):
    docs  = Folder(SRC)
    index = SearchIndex("notes")                      # a view over RagIndex, created on first use
    async for change in docs.listen():
        report = await index.apply(change)            # +1 present, −1 gone — inside apply
        await change.ack()
```

`apply` folds `added / changed / removed / renamed` into one weight per path, so
a delete flows through the same code as an add and a path both added and
removed in one page nets to nothing. It is idempotent: applying a page twice
embeds nothing the second time, because chunk ids key on their text. A refusal
(nothing funds embeddings yet) comes back as a sentence on the report, never an
exception — ack and move on; the heartbeat pass catches up.

`index.search("how does the walk decide what to skip")` asks it.
