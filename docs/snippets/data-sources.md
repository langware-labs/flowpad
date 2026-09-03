# Data sources — snippets

A data source is one remote account or tree Flowpad syncs from. The row is a
`DataSource`; every item it produces is a `SourceItem`; one cycle is one verb,
`source.sync()` (the heartbeat calls the same code through `sync_source`).
Everything below runs in-process against the session DB, and every `python`
fence is run as written by `tests/unit/test_data_sources_snippets.py`. Deeper
reading: [docs/data-management/data-sources.md](../data-management/data-sources.md).

```python
import flow_sdk.ingest.drivers  # noqa: F401 — registers the twelve shipped drivers
```

## 1. Connect a feed and sync it once

Pinned by `tests/unit/test_data_sources_snippets.py`.

```python
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem

src = DataSource(
    name="Hacker News front page",
    provider="rss",
    config={"feed_urls": [FEED_URL]},
)
await src.save()                       # NEW → ACTIVE; channel and origin stamped

outcome = await src.sync()
outcome.created, outcome.updated, outcome.unchanged   # what this cycle did

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

| provider | config | account key |
| --- | --- | --- |
| `rss` | `feed_urls: list[str]` | — |
| `hackernews` | `types`, `min_score`, `base_url` (all optional) | — |
| `folder` | `root: str` | `root` |
| `git` | `repo: str`, `branch` | `repo` |
| `agentmail` | `inbox`, `api_key`, `base_url` | `inbox` |
| `telegram` | `bot_token`, `base_url` | `bot_token` |
| `slack` | `channels: list[str]` | `channels` (membership) |
| `gdrive` | `drives`, `cache_root`, `base_url` | — |
| `gcs` | `bucket`, `prefixes`, `cache_root`, `base_url` | `bucket` |
| `gmail` | `address` | `address` |
| `cloud_email` | `agent_id`, `address` | `agent_id` |
| `agent` | `connector`, `harness`, `segments`, `agent`, `subagent`, `max_items` | `connector` |

Values are coerced on `save()` (`"5"` becomes `5` for a `number` field), but
`required` and `pattern` are enforced only by the UI form. Check them yourself
when you build a row in code.

## 2. Reuse instead of duplicate

A second source for the same account is a lookup, never a fresh row.

```python
existing = await DataSource.find_for_account("agentmail", "inbox", "me@agentmail.to")
src = existing or DataSource(
    name="Inbox me@agentmail.to",
    provider="agentmail",
    config={"inbox": "me@agentmail.to", "api_key": KEY},
)
await src.save()
```

The natural key is the config field the manifest marks `account_key: true`
(table above). Do not derive an id from it.

## 3. Search what landed

`SourceItem.body` is FTS-indexed straight from the row.

```python
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
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.reflect import ReflectMode

src = DataSource(
    name="Shared drive notes",
    provider="folder",
    config={"root": WATCHED},                # the tree to watch
    reflect=ReflectMode.COPY.value,          # none | copy | symlink
    reflect_into=DESTINATION,                # absolute, the destination tree
)
await src.save()

await src.sync()   # enumerate → reflect bytes → reindex the destination
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
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestMode

items = [
    SourceItemSpec(
        data_source_id=src.id,
        provider="agent",
        kind="content.message.email",
        segment_key="INBOX",
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

Five header fields mint identity: `data_source_id`, `provider`, `kind`,
`segment_key`, `external_id`. A missing one raises by name; an unknown key
(`subject` instead of `name`) raises rather than landing as an empty column.

Same thing from a worker, over the write route:

```bash
flow record create source_item --json items.json          # array or one object
flow record create source_item --json - --first-run < big_backfill.json
```

## 7. Operate a source

The verbs the Data Sources screen calls, as Python. Each is a method on the
row; the HTTP route of the same name is a thin wrapper over it. Pinned by
`tests/unit/test_data_sources_snippets.py` and `tests/unit/test_data_source_actions.py`.

```python
await src.verify()          # connection + setup probe → status ACTIVE or SETUP
await src.poll_now()        # mark due; the heartbeat picks it up within 60s
await src.replay(since=None)   # re-emit item events from what is stored
await src.reset_cursors()   # forget high-water marks, keep rows
await src.purge_items()     # drop rows AND their read/starred state
await src.delete()          # cascade: cursors, items, projected messages
```

Read the row before poking it. `poll_now` clears `health`, `error_code` and
`error_detail` together, so snapshot them first or the evidence is gone.

```python
src = await DataSource.get_one({"id": src.id})
src.status, src.health, src.error_code, src.last_synced_at, src.next_poll_at
```

`status` is the lifecycle (`new`, `setup`, `active`, `disabled`, plus the
`parked` latch after repeated failures);
`health` is the last cycle's verdict (`never_synced`, `ok`, `transient_error`,
`config_error`). One segment in `config_error` parks the whole source today.

## 8. Reply through the source

Drivers that can send (`gmail`, `agentmail`, `telegram`, `slack`, `cloud_email`, `agent`)
expose one contract. Pinned by `tests/unit/test_data_source_messaging.py`.

```python
from flow_sdk.builtin.source_item import EmailMessageSpec

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
and `Inbox.send(...)`.
