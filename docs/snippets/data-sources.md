---
id: 08b85341-aaf3-47d3-bf5e-8c09b794205c
version: 2
---
# Data sources — snippets

A data source is one stream Flowpad syncs from — one feed, one channel, one
mailbox, one tree — configured on a driver. Watching three feeds is three sources. It is a `DataSource`, and an asset: `save()` writes
`agentic-assets/data_source/<name>/data_source.json` into the current project
(the user scope outside one), and nothing is on disk before that. Every item it
produces is a `SourceItem`; one cycle is one verb,
`source.sync()` (the heartbeat calls the same code through `sync_source`).
Everything below runs in-process against the session DB, and every `python`
fence is run as written by `tests/unit/test_data_sources_snippets.py`. Deeper
reading: [docs/data-management/data-sources.md](../data-management/data-sources.md).

## 1. Connect a feed and sync it once

Pinned by `tests/unit/test_data_sources_snippets.py`.

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

A first run only takes items newer than `window_days` (default 7) before
`now`; widen it on the row if you want history. A second `sync()` on an
unchanged feed writes nothing: `created == 0`,
`updated == 0`, no row's `updated_date` moves, no `ingest.*.item.*` event
fires. That silence is the contract the whole subsystem rests on.

The config keys are the manifest's, one dict per provider:

| provider      | config                                                               | account key             | secret (never config)                   |
| ------------- | -------------------------------------------------------------------- | ----------------------- | --------------------------------------- |
| `rss`         | `feed_url: str`                                                      | —                       | —                                       |
| `hackernews`  | `types`, `min_score`, `base_url` (all optional)                      | —                       | —                                       |
| `folder`      | `root: str`                                                          | `root`                  | —                                       |
| `git`         | `repo: str`, `branch`                                                | `repo`                  | —                                       |
| `agentmail`   | `inbox`, `base_url`                                                  | `inbox`                 | machine secret `ingest_api.agentmail`   |
| `telegram`    | `base_url`                                                           | stamped from `getMe`    | `telegram` pack: `TELEGRAM_BOT_TOKEN`   |
| `slack`       | `channel` (one id, or a picked `{id, name}`); `allowed_senders` moves onto the row | `channel`               | the Slack connection                    |
| `gdrive`      | `drive` (empty = My Drive), `cache_root`, `base_url`                 | —                       | the Google connection                   |
| `gcs`         | `bucket`, `project`, `prefix`, `cache_root`, `base_url`              | `bucket`                | the Google connection                   |
| `gmail`       | `address`                                                            | `address`               | `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`   |
| `cloud_email` | `address` (`agent_id` is filled from the owner)                      | `agent_id`              | —                                       |
| `agent`       | `connector`, `harness`, `mailbox`, `agent`, `subagent`, `max_items`  | `connector`             | the harness's own                       |
| `voice_phone` | `number`, `project` (OpenAI `proj_…`), `voice`, `model`, `base_url`, `twilio_base_url` | `number`  | `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |

Each driver declares its config as a typed `Config` in its `source.py`: `save()` of a new source
validates it whole (`ValueError: config.feed_url is required`) and shapes what you typed (`"5"`
becomes `5`, a newline string a list). A secret is never config — `data_source.json` is a file a
project may share — so it lives in the store the driver's `auth` names.

## 2. Reuse instead of duplicate

A second source for the same account is a lookup, never a fresh row. `save()` does it for you — a
new source for an account its owner already watches adopts that row — and the lookup is there when
you want the row before deciding.

```python
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource

existing = await DataSource.find_for_account("agentmail", "inbox", "me@agentmail.to")
driver = await DataDriver.get("agentmail")
src = existing or driver.create_source(driver.create_config(inbox="me@agentmail.to"), name="agentmail me@agentmail.to")
await src.save()  # the API key is the machine secret ingest_api.agentmail, never config
```

The natural key is the config field the manifest marks `account_key: true`
(table above). Do not derive an id from it.

## 3. Search what landed

`SourceItem.body` is FTS-indexed straight from the row.

```python
from flow_sdk.builtin.source_item import SourceItem

hits = await SourceItem.search("zebrafish", limit=10)
```

From a shell, the same index:

```bash
flow record search "zebrafish" 7d 10
```

## 4. Watch a folder and mirror it into a project

Pinned by `tests/unit/test_data_sources_snippets.py` (the CRUD matrix is
`tests/unit/test_folder_source/test_crud_matrix.py`).

```python
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.reflect import ReflectMode

driver = await DataDriver.get("folder")
src = driver.create_source(
    driver.create_config(root=WATCHED),  # the tree to watch
    name="Shared drive notes",
    reflect=ReflectMode.COPY.value,  # none | copy | symlink
    reflect_into=DESTINATION,  # absolute, the destination tree
)
await src.save()

await src.sync()  # enumerate → reflect bytes → reindex the destination
```

`reflect` is the one axis that decides where a payload lands: `record` (the
default, rows in the graph) or a filesystem mode. `folder` and `git` only offer
`none`, `copy`, `symlink`, so set it explicitly. A `record`-mode folder source
saves fine and ingests nothing.

## 5. Subscribe to arrivals

Pinned by `tests/unit/test_data_sources_snippets.py`.

```python
from flow_sdk.tags import event_bus

def on_item(event):
    print(event.tag, event.data)          # ingest.rss.item.created, {...}

unsub = event_bus.on("ingest.*.item.created", on_item)
try:
    await src.sync()
finally:
    unsub()                               # lifetime is the caller's job
```

The family is `ingest.<provider>.item.created|updated` plus
`ingest.<provider>.sync.started|completed`. A first run on a big feed is a
backfill: it emits the two `sync.*` boundary events and no per-item storm.

## 6. Write items in from outside a driver

An agent, a script or a test can record items through the same chokepoint the
poller uses, so a re-run converges instead of duplicating. Pinned by
`tests/unit/test_ingest_write_route.py`.

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

Four header fields mint identity: `data_source_id`, `provider`, `kind`,
`external_id` (lifted into the item's `origin`). A missing one raises by name; an unknown key
(`subject` instead of `name`) raises rather than landing as an empty column.

Same thing from a worker, over the write route:

```bash
flow record create source_item --json items.json          # array or one object
flow record create source_item --json - < big_backfill.json
```

## 7. Operate a source

The verbs the Data Sources screen calls, as Python. Each is a method on the
row; the HTTP route of the same name is a thin wrapper over it. Pinned by
`tests/unit/test_data_sources_snippets.py` and `tests/unit/test_data_source_actions.py`.

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

Read the row before poking it. `poll_now` clears `health`, `error_code` and
`error_detail` together, so snapshot them first or the evidence is gone.

```python
from flow_sdk.builtin.data_source import DataSource

src = await DataSource.get_one({"id": src.id})
src.status, src.health, src.error_code, src.last_synced_at, src.next_poll_at
src.cursor, src.consecutive_failures  # where the next pass starts; failed passes in a row
```

`status` is the lifecycle (`new`, `setup`, `active`, `disabled`, plus the
`parked` latch after repeated failures);
`health` is the last cycle's verdict (`never_synced`, `ok`, `transient_error`,
`config_error`). A failed pass never moves `cursor`; `config_error` parks the
source until `poll_now` un-latches it.

## 8. Reply through the source

Drivers that can send (`gmail`, `agentmail`, `telegram`, `slack`, `cloud_email`, `agent`)
expose one contract. Pinned by `tests/unit/test_data_source_messaging.py`, and run as written
by `tests/unit/test_data_sources_snippets.py`.

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import EmailMessageSpec, SourceItem

src = await DataSource.get(SOURCE)
item = (await SourceItem.get_all({"data_source_id": str(src.id)}))[-1]   # a message it ingested

outcome = await src.send(
    EmailMessageSpec(
        to=[item.author_external_id],
        body="Got it, thanks.",
        thread_key=item.thread_key,
        reply_to_external_id=item.external_id,
    )
)
outcome.external_id              # identity is born at the provider

reply = await src.expect_reply(outcome)
reply.body
```

For a typed reply that threads correctly per channel, use the
[workflows](workflows.md) surface: `EmailMessageSpec.reply_to(item, body=...)`
and `StreamInbox.send(...)`.

## 9. Ask a provider what you can pick

Three providers ask for values nobody can produce from memory — a shared drive is
`0AB1cdEfGhIjKlMnOpQ`. A manifest field marked `choices` can be listed instead.
Pinned by `tests/unit/test_data_sources_snippets.py`.

```python
from flow_sdk.builtin.data_source import DataSource

picks = await DataSource.choices_for("gcs", "bucket", {"project": PROJECT})

[(c.id, c.name) for c in picks.items]  # what this credential can actually see
picks.detail  # why the list is empty, when it is
```

A refusal is an **empty** **`items`** **and a sentence**, never an exception: no connection, a
scope the consent screen never asked for, a project id nobody set — all of them mean the
same thing to the person filling the form, which is *type it instead*. So the field falls
back to a plain text input carrying `picks.detail`, and never blocks a save.

`choices_for` answers `None` for a provider that does not exist or a field its manifest
never marked — that is the form asking about something it had no business asking about,
and it is a caller bug rather than a refusal. A source reads one stream, so a pick is one
value; picking three channels in the Add Source dialog creates three sources.

| provider | field      | what it lists                                                        |
| -------- | ---------- | -------------------------------------------------------------------- |
| `gcs`    | `bucket`   | buckets in `config.project` — the project is read for THIS call only |
| `gdrive` | `drive`    | the shared drives the Google account can see                         |
| `slack`  | `channel`  | every channel the token can see, joined or not                       |

## 10. A source behind a connection: Google Drive

Pinned by `tests/unit/test_data_sources_snippets.py` (the source itself by
`flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/gdrive/tests/`).

A Drive source carries no secret in its `config`. Its manifest declares
`auth.connector: google`, and the token comes from the machine's **Google
connection**, made on the Connections screen. The scopes it grants,
`drive.readonly` and `devstorage.read_only`, are what `gdrive` and `gcs` ask for.

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

Until Google is connected, `verify()` answers `ready: False` with a sentence
that says so (`No Google credential on this machine…`); the row parks in
`setup` and nothing is fetched. Once it is, files land in `cache_root` under
Drive's own folder names and are reflected into `reflect_into` like a folder
source's. The report's `created`/`updated` count *records*, so they stay 0 for
a file source: look at the tree.

## 11. Consume a source yourself

`sync()` is pages → ingest → ack. The same loop is yours when you want the items without
the graph: the source owns its query (its config) and its position (`cursor`), so neither
is an argument. Pinned by `tests/unit/test_data_sources_snippets.py`.

```python
async with await src.open() as live:
    async for page in live.pages(page_size=50):  # from the stored position, 50 items a page
        for item in page.items:
            item.origin.key
        await page.ack()  # the next read starts after this page; un-acked = read again

    notes = [item async for item in live.items(prefix="notes/")]  # narrows the query; the position does not move

await src.reset()  # cursor = None: the next read starts from the beginning
```

`items(**narrow)` accepts the fields of the source's own query — `prefix` for a tree, `since`
for a message source (`live.items(since=yesterday)`) — and refuses one the query does not have
(`ValueError`).

## 12. Read two sources as one

`merge(*sources)` opens several sources as one session. Nothing is stored: a page is always ONE
source's (`page.source`) and acks that source's cursor; `items(**narrow)` narrows every source's
query and interleaves by event time; a reply goes back through the source whose scope owns the
item's origin. Pinned by `tests/unit/test_data_sources_snippets.py`.

```python
from flow_sdk.ingest.session import merge

async with await merge(notes, docs).open() as live:
    async for page in live.pages(page_size=50):
        seen = {page.source.name: len(page)}
        await page.ack()                                   # moves that source's cursor only

    recent = [item async for item in live.items(prefix="2026/")]   # narrowed on every source; no position moves
    owner = live.source_of(recent[0])                      # the source whose scope owns the item's origin
```

```python
from flow_sdk.ingest.session import merge

async with await merge(support, sales).open() as live:
    async for m in live.items():
        await live.reply(m, body="on it")                  # through the source m came from, in its own shape
```

There is no `merged.send`: a new message needs a channel, so call `send` on the source you mean.
A push-only source has no pages to read and is refused at `open()`.

## 13. Three families: files, records, messages

Every driver's class extends one family — what its items ARE, and so where they land. An
`ObjectSource` yields files, reflected onto disk and indexed as assets (§4, §10). A `RecordSource`
yields records, kept as `SourceItem` rows updated in place (§1). A `MessageSource` is a record
source of messages in conversations, threaded into the stream inbox and answered through the
source (§8). The row says which as `family`; only a message source `sends`.

```python
from flow_sdk.builtin.data_driver import DataDriver

drive = await DataDriver.get("gdrive")
rss = await DataDriver.get("rss")
slack = await DataDriver.get("slack")

families = (drive.family, rss.family, slack.family)    # ("object", "record", "message")
answers = (drive.sends, rss.sends, slack.sends)        # (False, False, True)
```

A provider with two kinds of stream is two drivers: a Jira issue tracker is a `RecordSource`
of issues, and each issue's comments a `MessageSource`.

## 14. Write your own driver

A driver's class extends its family and, for a listing, `CollectionSource`: three methods, and
paging, `get` and `iterate` come free. This one keeps its table in memory; a real one reads an API
in `_scan` (the shipped `hackernews` driver is 130 lines). Pinned by
`tests/unit/test_data_sources_snippets.py`, which also runs the SDK's conformance kit on it.

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

Put it in `agentic-assets/data_driver/zen/source.py` beside a `data_driver.json` naming it, and
it loads like the shipped ones.
