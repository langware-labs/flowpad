---
id: 5b7f5f93-090e-46d1-9a21-eeda92525e3f
---
# The source contract and the sync runtime

Two layers, one dependency direction. Read this before touching either.

## The contract: `flow_sdk/sources/`

A **source** is an async session over one remote or local system:

```
async with await driver_type(row.provider).open(row) as s:   # a DataSource row, bound by flow_sdk.ingest.driver_types
                                                              # (in contract terms: SomeSource(SourceBinding(...)))
    item  = await s.get(origin)                       # SourceItemSpec | None — None only on confirmed absence
    page  = await s.fetch(query, cursor=…, page_size=…)   # DataPage(items, next_cursor)
    async for item in s.iterate(query): …
    async with s.open(file) as chunks: …             # ByteStore
    await s.write(path, chunks)                       # ByteStore
    sent  = await s.send(MessageData(...))            # Messaging
    reply = await s.reply(origin, MessageData(...))   # Messaging
    await s.notify(DataSourceEvent(...))              # every source; one on_change handler per session
```

Values are frozen `DataSpec`s: `CloudOrigin(kind, namespace, key, url|None)` (identity is the
triple), `SourceItemSpec(origin, data)`, `FileData`, `MessageData` (+ `UserProfile` for sender and
recipients), `DataPage`, the `DataQuery` family, `DataSourceEvent`. Capabilities are protocols
discovered by `isinstance` (`Readable`, `Listable`, `Mutable`, `ByteStore`, `Messaging`, `Drafting`),
never declared. Failures are one `SourceError` family (`AccessDenied`, `SourceUnavailable`,
`NotFound`, `Unsupported`, `InvalidCursor`, `Rejected`, `OutcomeUnknown`), each also subclassing the
closest built-in. A source class is the same object whether it ships in `flow_sdk`, is authored as an
asset and runs in a source host, or is reached over REST from a worker — the conformance kit
(`flow_sdk/sources/testing/`) is what makes that a gate rather than a claim.

The contract package imports `flow_sdk.schema` and the standard library. It never imports
`flow_sdk.builtin`, `ingest`, `inbox`, `blocks` or `server`; `tests/unit/assets/test_runtime_boundary.py`
pins that in a fresh interpreter.

## The runtime: `flow_sdk/ingest/` and its neighbours

Everything the contract deliberately refuses is an **application** concern, and it lives here:

| Mechanism | Where | Why it is not in the contract |
|---|---|---|
| Polling and the attention fast lane | `ingest/poller.py`, the heartbeat | Scheduling is policy; the contract answers "what is there now" |
| `_inflight` exclusion, segment budgets, round-robin | `ingest/poller.py`, `ingest/sync.py` | Concurrency across sources is the runtime's |
| Per-segment cursor rows (`DataSourceCursor.cursor`) | `builtin/data_source_cursor.py` | Durable resumption is the runtime's; a source only hands back an opaque token where it documents durability |
| Idempotent writes: natural key + content digest | `ingest/ingestor.py`, `fs_store/serializer/db.py` | The contract returns values and writes nothing |
| Health and parking (`config_error` stops, `transient` retries) | `ingest/health.py` | The contract raises; classifying a raise into a verdict is policy |
| Reflection (`none` / `copy` / `symlink`) and `reindex_paths` | `ingest/reflect.py` | Where bytes land is the source ROW's choice, not the provider's |
| Inbox projection, owner partition, reconcile lane, storm caps | `inbox/projection.py` | A message's placement in a person's inbox is a product rule |
| Allowlists, `open_inbound`, self-address loop guards | `inbox/agent_runner.py`, `inbox/agent_scope.py` | Who may drive an agent is policy |
| Pipes: `ConsumerPosition`, `page_after`, `Inbox.listen`, `FolderChanges.listen`, `Delivered.ack/reply` | `blocks/`, `builtin/consumer_position.py`, `builtin/ingest_order.py` | At-least-once consumption with a durable watermark is what the contract explicitly scrapped as an SDK feature |
| Hub relay, agent places, adoption hints | `builtin/agentic_process/*`, `builtin/agent_places.py` | Which machine holds the send-capable session is deployment |
| Registry, source hosts, trust, venvs | `sources/registry.py`, `sources/runtime.py`, `sources/host/` | Loading and running a source is packaging, not the source's own contract |

The dependency runs one way: the runtime imports the contract. A special case that only one
provider needs belongs as a trait or method on that provider's class, never as an `if provider ==`
on the runtime.

## Two words that are easy to confuse

- **`origin_kind`** is what a source *type* claims (`slack`, `gmail`); it must be unique across
  registered types — the older registration wins a conflict and the loser is shown in the footer.
- **`namespace`** is per *row* (`<workspace>/<channel>`, `<address>`, a bucket, a root); the class
  computes it from the row's config. Together with `key` they make the origin triple.

Related: [data-sources.md](data-sources.md) (the runtime in detail), [data-source-asset.md](data-source-asset.md)
(a source type as a folder asset), [items_origins.md](items_origins.md) (origins).
