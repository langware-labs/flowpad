---
id: 44d26316-873d-49f6-95c2-e61d74dee7e6
---

# Data sources

> From a person's words to a labelled dataset: the `data-integrations` Vibe
> persona (`flow_sdk/system_projects/flowpad_assistant/.claude/agents/data-integrations.md`,
> `kind: vibe`, embedded in every vibe session) runs **connect → see a sample →
> define the output** on top of the `connect-data-source` skill (`define` mode,
> `.claude/skills/connect-data-source/scripts/dataset_ctl.py` in that same
> system project). The result is a source that streams and a
> `Dataset` bound to it — see [datasets.md](datasets.md#curating-a-source-into-a-dataset).
>
> `DataSource.config` is coerced by the definition's field types on every save
> (`lines`/`csv` → list, `number` → number), so a value sent as the person typed
> it never reaches a driver in the wrong shape.

The filesystem indexer walks local roots. A **data source** walks something
else — a feed, a mailbox, a channel, a repository — and lands what it finds in
the same graph. One `DataSource` reads **one stream** — one feed, one channel, one mailbox, one
drive or prefix — and owns the relationship with it: which driver, what it needs
to run, how often, and where its payload becomes locally present. Watching three
feeds is three sources; there is no second unit under a source.

The source owns its **query** (built by the driver from its config,
`Source.query()`) and its **position** (`DataSource.cursor`, row-only). A
`SourceItem` is one ingested record.

```
DataSource  (config → query; cursor, manifest, high_water on the row)
     │  origin: FSOrigin  (WHERE the bytes come from — stamped by driver.origin_for)
     │
     └─ source.fetch(cursor) ──> SourceItemSpec ──> ingest_items() ──> SourceItem   (record: DbSerializer resolves by natural key, gates on digest)
                             └─> refs          ──> reflect_refs()  ──> files        (asset: placed, then reindex_paths)
```

## The pipeline

| Stage | File | Contract |
|---|---|---|
| dispatch | `ingest/poller.py` | One heartbeat task, never a job per source |
| one cycle | `ingest/sync.py` | One traversal from the stored position, records before cursor, failure as health |
| the write | `ingest/ingestor.py` | **The single chokepoint** for `SourceItem` — record, index, emit, in that order |

**Why a heartbeat and not a scheduled job per source.** Per-entity jobstore rows
orphan; a heartbeat has nothing to orphan. The tick must do no I/O — it selects
what is due, hands each source to its own task, and returns in milliseconds.
`_inflight` is the entire concurrency control: one poll per source, no locks and
no backoff. `schedule_next` stamps `next_poll_at` on the minute grid the
heartbeat ticks on — a raw `now + interval` carries the dispatcher's
millisecond jitter, and a tick firing a few ms before the stamp would silently
skip the source for a whole minute, turning a one-tick interval into a
60/120s coin flip.

**Attention.** While someone is actually looking at a source's output (a
conversation view has it selected), the UI fires the `request_poll` action on
an interval; each request makes the source due on the next tick, and — for a
driver that declares `attention_poll_seconds` (telegram: 5) — renews a short
lease on the poller's **fast lane**, a loop that polls the watched source at
that sub-tick cadence. `_inflight` stays the one concurrency control, so the
tick lane and the fast lane never poll a source concurrently. The request
stream itself is the liveness signal — nothing is stored, so when the viewer
goes away the requests stop, the lease lapses within seconds, and the standing
`poll_interval_seconds` cadence resumes by itself. Unlike `poll_now`,
`request_poll` never un-latches `config_error` and never wakes a `disabled`
source: an auto-firing viewer must not resurrect what a human or a broken
credential stopped.

**Two properties `sync_source` exists to guarantee.** The cursor advances only
after the write returns, so a crash costs a partial re-fetch and can never open a
gap. And a failed pass leaves the cursor *unadvanced* and records why on the row
(`health`, `error_code`, `consecutive_failures`) — re-delivery is a digest-gate
no-op, so re-fetching is free and losing a window is not. The cadence *is* the
retry rate; there is no backoff.

`sync_source` also stamps `DataSource.kind` and `DataSource.channel` from the
driver on every run, so a row written before either field existed self-heals on
its next poll.

**The digest gate is the performance story.** An unchanged item costs one indexed
read and nothing else — no save, no metadata write, no FTS write, no broadcast,
no event. In steady state `IngestReport.unchanged` should dominate; if it is near
zero on a repeat poll the gate is not working and every cycle is rewriting rows
and re-firing triggers. The source row honours the same rule: a source that was
already healthy and came back `unchanged` at the same position is **not saved**
(`last_attempted_at` stays in memory), so the steady state is one request and
zero writes per source per tick.

**Run modes and the events a cycle emits.** `IngestMode.for_run` picks
`BACKFILL` on a large first run or whenever a page carries more than
`STORM_CAP_PER_MINUTE` (30) items; `INCREMENTAL` otherwise. A backfill saves
with `notify=False` and emits no per-item events — the GraphWorkflow storm caps
silently drop the excess, so announcing 40 items into a 30/min cap delivers
30. The tags (`ingest/ingest_on_tag.py`, four fixed dot-parts so the globs
behave):

| Tag | Target | When |
|---|---|---|
| `ingest.<provider>.item.created` / `.updated` | `source_item:<id>` | one per changed row, `INCREMENTAL` only; `unchanged` is silent |
| `ingest.<provider>.sync.started` / `.completed` / `.failed` | `data_source:<id>` | once per cycle; `completed` carries the counts and `changed_ids` |

The `sync.*` lane is the one a flow should subscribe to — one event per cycle,
with the ids to fan out on. Subscribing to `item.*` is opting into the per-item
lane and its 30/min ceiling.

**The write route.** `POST /api/v1/ingest/items` (`server/routes/ingest.py`,
body `{"items": [<SourceItemSpec>…]}`, at most 500 items)
exposes the same `ingest_items` chokepoint to anything that is not the
poller — `flow record create source_item`, an agent worker, a test — so a
record written from outside converges with what the poller writes instead of
racing it. `SourceItemSpec`'s own `extra="forbid"` is the refusal: a misspelt
field is an error, not a row with an empty name.

## The source contract

Every data source is a **self-contained asset folder**,
`agentic-assets/data_driver/<name>/` (the shipped ones under
`flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/`): the manifest,
a `source.py` holding one `Source` class, any helper modules beside it (`transport.py`),
its `tests/` and its editor. The class extends one **family** (`flow_sdk/sources/families.py`) —
what its items ARE — and the loader refuses a class that extends `Source` directly:

| Family | Items | Lands as | Shipped |
|---|---|---|---|
| `ObjectSource` | files (`FileItem`) | reflected onto disk, indexed as assets; a page of changes is a `SourceChange` | folder, gcs, gdrive, git |
| `RecordSource` | records (`RecordData`: `FeedItemData`, a provider's `IssueData`) | `SourceItem` rows, updated in place when their digest moves | rss, hackernews |
| `MessageSource` (a `RecordSource`) | messages (`MessageData`) in conversations | `SourceItem`s, projected into the stream inbox; answered through the source | the other 15 |

The family is declared (it is the payload shape and the destination); the class then implements
the access protocols it can honour the access protocols it can honour
(`Listable`, `Readable`, `Messaging`, `Verifiable`, `Choosing`,
`Identified`, `StableHandle`) — a capability is discovered by `isinstance`, never
declared. A source answers *what is there* and *what changed since a cursor*; it never
writes an entity, emits an event, or advances a cursor. It imports the public SDK, never
another asset.

The loader (`flow_sdk/ingest/source_registry.py`) builds each folder into a **source
type** (`flow_sdk/ingest/sources.py`, `DataDriver`) from the manifest and the class. What
differs between sources, the source says itself: the credential shape is the manifest's
`auth` (one resolver, `flow_sdk/ingest/credentials.py`); `build` constructs it over an
application transport; `message_for` reads a send's arguments; `query` names the one stream it reads; `local_tree_key` / `origin_id_for` place and name reflected files;
`permalink` addresses its channel's UI; `webhook_challenge` / `webhook_account` /
`events_from_webhook` take push delivery through the one generic route,
`/api/v1/data_source/webhook/<name>`, and `webhook_authentic` — when a class declares it —
must accept the delivery's raw body and headers before anything is ingested. The check is
`DataDriver.ingest_pushed`'s, so no caller can skip it, and the route answers a refusal
with 401 (the URL is public; WhatsApp checks Meta's `X-Hub-Signature-256` against the app
secret). The shipped folders load on the first
`DataDriver.loaded(provider)` call; an authored folder loads on first use
(`DataDriver.get`). `tests/unit/test_data_sources_are_self_contained.py` fails on
any provider knowledge outside an asset folder.

**The cursor is the source's own.** `DataSource.cursor` is an opaque string the
loop carries and never reads, persisted across passes only for a class that
declares `durable_cursor` (a change log, a commit, a watermark).
`DataSource.manifest` is the traversal's own diff bookkeeping for a reflecting
source. `test_cursor_state_is_opaque_to_the_subsystem` (`tests/unit/test_ingest_sync.py`)
greps the engine for provider keys. `DataSource.high_water` is recorded for
operators, never read back as a floor. A cursor is bound to the query that
produced it (`_paging.query_token`); `fetch(cursor, narrow={...})` reads a
narrowed query (`Source.effective_query`) and a field the query lacks is a
`ValueError`.

**Reading a source by hand.** `async with await source.open() as live:` gives
`live.pages()` (from the stored position; `await page.ack()` moves the cursor
past a page, an un-acked page is read again) and `live.items(**narrow)` (the
query narrowed, the position untouched). `sync()` is the same loop with
`ingest_items` between the page and the ack. `pages(page_size=50)` sizes the page.
`merge(*sources)` (`ingest/session.py`) reads several sources as one session with the same
verbs: a page is always one source's and acks that source's cursor, `items(**narrow)`
interleaves by event time, `reply(item, body=…)` goes back through the source whose scope owns
the item's origin; nothing is stored and there is no `send`. On the ingested side the same
shape is `StreamInbox.pages(size=…)` and `blocks.pages(*stream_inboxes)` over `ConsumerPosition`s.

### Traits

Traits are class variables on the `Source`; `DataDriver` exposes the ones the
application reads, so the engine asks the type rather than probing.

| Trait | Default | Meaning |
|---|---|---|
| `provider` | — | Registry key. Distinct from `channel`, the user-facing name (`origin_kind_for`) |
| `kind` (on the type) | — | Ontology kind of the **source** row (`datasource.feed.rss`); stamped by `sync_source` |
| `ns` | `""` (ours) | Whose ontology the shapes this driver registers belong to. A driver OUTSIDE the shipped tree must name one — its own, or its project's — or `load_driver` refuses it, because otherwise a kind it declares lands in ours and can take a shipped one's name. Every kind it mints is prefixed `--<ns>--`; ours is the default and is never written. See [`ontology.md`](../ontology.md) |
| `durable_cursor` | `False` | Whether `ChangePage.resume_cursor` is persisted and resumed |
| `pages_per_pass` | `None` | Page chain cap per traversal |
| `attention_poll_seconds` | `None` | Sub-tick cadence while watched (see *Attention*). Telegram declares 5 |
| `stamps_identity` | `True` | `ObjectSource` only: whether this source's files are ours to write an identity into |
| `local_tree_key` | `""` | `ObjectSource` only: the config key naming a tree read in place (`root`, `repo`); empty when the bytes are pulled into a cache |
| `identity_config_key` | `address` | The config field naming WHICH remote account a source serves — the natural key a caller (e.g. `blocks.StreamInbox`) matches on to reuse a source |
| `connection` | `None` | The machine connection it reads with (`google`, `slack`), checked before a row exists |
| `open_inbound` | `False` | `MessageSource` only: strangers are the point (a help desk): an empty allowlist admits everyone |
| `echoes_sends` / `sends_may_draft` | `True` / `False` | `MessageSource` only: a send comes back as its own record; a send may land as a draft |

Setup (`Verifiable.verify`), a picker (`Choosing.choices`), identity (`Identified.whoami`)
and a targeted reply lookup (`find_reply`, Gmail's In-Reply-To scan) come from the
protocols the class implements. The registry is a `KindRegistry` keyed on `provider`; a
miss answers `None`, and `sync_source` records that as the `unknown_provider` config
error rather than crashing the poller.

Callers send through `DataSource.send(MessageSpec)`, which validates the common
message shape before delegating to the driver's `send()` hook. A sent message is
recorded at once as a `SourceItem` marked `sent_by_us`, so the conversation shows
it without waiting for the next poll. When the provider echoes it back, the echo
has the same natural key, so it updates that row and the mark stays. Every "did we
write this" check reads `SourceItem.is_ours`: the drain's self-filter, crash-recovery
redelivery, and the projection's sender. A draft is never recorded. A send whose
transport records its own copy (the agent-worker driver) is not recorded again, and
that copy is not marked: it reads as ours only by its author. For transports
with reply headers, `DataSource.expect_reply(outcome)` returns when a received
item references the sent provider id; a driver may use its targeted lookup or
session-level wait instead of a mailbox backfill. The caller owns the outer
deadline.

**What a driver is, and what it is not.** The driver is Python and ships with the
SDK. Everything a *person* sees about a source — its title, its glyph, the fields
the create form renders — comes from a `data_driver` **asset**, one folder
per source under `agentic-assets/data_driver/`. That split is what lets a source
be added without a frontend release; see [the data-source asset](data-source-asset.md).

## Status, health, and what stops a poll

`SourceStatus` answers *should this be running* — `new` / `setup` / `active` /
`disabled`. `SourceHealth` answers *is it working*. They are separate axes, and
collapsing them is how a source reads OK while nobody has finished setting it
up. A Slack source whose bot was never invited is neither disabled nor broken;
it is `setup`, and that state has to be representable.

One behavioural rule: **`config_error` stops polling, `transient_error`
never does.** `SourceError.for_status` is the one status→health table — a 429
read as permanent would park a source forever over a rate limit. Anything a
driver raises that is not a `SourceError` classifies as transient: guessing
"permanent" on an error never seen before would silently stop a working source.

A source reads one stream, so its health IS that stream's: a `config_error`
pass parks the source (`may_poll()` refuses it) until `poll_now` or `replay`
un-latches it, and a `transient_error` pass is simply tried again next tick.

`poll_refusal()` is the ONE gate — an empty reason means the source is active
and not in `config_error`; otherwise the returned sentence says exactly why it
cannot run. `is_due`, `request_poll` and the fast lane all ask it.

**Lifecycle.** `NEW` is transient: `DataSource.save` resolves it on the way
in — to `SETUP` (with a default `setup_detail`) when the source class is
`Verifiable`, else straight to `ACTIVE`. An unknown provider also goes `ACTIVE`,
deliberately, so the poller reaches `sync_source` and the card can show
`unknown_provider` instead of a source that silently never runs. `verify`
runs two layers in order — the channel's OAuth probe (the same one the
Connections "Test" button uses), then the source's own `Verdict` — and
moves the source to `ACTIVE` (due on the next tick) only when both pass.
`save` also stamps `channel` (from the source type, on an empty field only),
coerces `config` by the spec's field types, and re-derives `origin` via the
type's `origin_for`.

**Operator controls** (`core_action`s on `DataSource`; all asynchronous — they
make the source due, the heartbeat does the work within a minute):

| Verb | Does | Note |
|---|---|---|
| `poll_now` | make due | **the only un-latch** for `config_error` besides `replay` (`_make_due`) |
| `request_poll` | make due, arm the fast lane | never un-latches, never wakes `disabled`/`setup` — see *Attention* |
| `reset` | clear `cursor`, `manifest` and `high_water`, keep the records | alone it is invisible: the digest gate suppresses re-delivery. `last_synced_at` survives |
| `purge_items` | destroy the source's `SourceItem`s and their stream inbox projection | rebuilt rows are **new** entities; `read`/`starred` are lost |
| `replay` | `purge_items` (optionally `since=`) + `reset` + make due | widens `window_days` to cover `since`, never shrinks it; undated rows survive a bounded replay |
| `verify` | the two-layer setup check above | |

Deleting a source cascades to its items, consumer positions and change log on
all three paths (`delete_by_id` — the HTTP route, `delete`, `destroy`), because
nothing else would: they are separate rows keyed to an id that would no longer
resolve.

**One-time cleanup at boot.** Rows of the retired `data_source_cursor` type are
removed (`RETIRED_TYPES`, `server/app.py`); each source re-reads its window. A
`data_source.json` whose config still lists N containers under a key its driver
retired (`Config.retired_list`, e.g. rss `feed_urls` → `feed_url`) is split into
one source per entry by `migrate_list_configs()`; a list that cannot split stays
and parks with `config.<field> is required`.

## Three families, two destinations

A source's payload lands **either** in the graph as a record **or** on disk as an
asset, never both. The family decides which: an `ObjectSource` reflects (a filesystem
mode), a `RecordSource` or `MessageSource` lands as `record`. Among its family's modes the
SOURCE picks (`reflect`), not the driver: the same folder could reasonably be indexed in place
or mirrored, and a driver deciding it would be deciding policy with only transport knowledge.
`load_driver` refuses a manifest whose `reflect` modes are not its family's, and a `MessageSource`
that is not `Messaging` with `message_for` (`check_family`, `flow_sdk/ingest/driver_registry.py`) —
so "does it send" (`DataDriver.sends`) is the family itself.

`ingest_items` stays the single chokepoint for `SourceItem` writes; reflection is
a second destination *beside* it rather than a branch inside it.

| Mode | Bytes | Notes |
|---|---|---|
| `record` | none — the graph | Every `RecordSource` and `MessageSource`. The default |
| `none` | indexed where they sit | The watched tree is itself a walk root |
| `copy` | duplicated into the project | Relative structure is preserved, so folder-layout assets survive |
| `symlink` | linked into the project | **Presentation only** — see below |

The manifest declares which modes a source offers (`reflect: [...]`, head
first as the default; `record` may not be listed beside a filesystem mode),
and `DataSource.reflect_into` names the directory `copy`/`symlink` land under
and a `GitOrigin` clones into — explicit on the row, because the heartbeat
tick that polls it has no request context to resolve a project from. Note
the row's own default is `record`: a `folder`/`git` source saved without a
`reflect` value has its refs skipped with a warning on every poll while its
cursor still advances and its health still reads `ok` (see *Known gaps*).

WHERE the bytes come from is not a mode: it is the source's typed `origin`
(`DataSource.origin: OriginField`), stamped by the driver's `origin_for` on
every save — a `LocalOrigin` at the watched folder, the checkout, or the
download cache. A `GitOrigin` (a repository that has to be obtained) is
materialized once per page through the `FSOriginDriver` registry into
`reflect_into`, the same seam bundles and projects clone through. For a git
source `copy` vendors changed files into the receiving repo's tracked tree —
they will be committed and pushed like anything else the user wrote.

Every mode ends at `reindex_paths`. None writes an entity or touches FTS
directly — that boundary is asserted by tests
(`tests/unit/test_folder_source/test_reflect_boundaries.py`), because a mode
that quietly minted a row would still make every functional test pass.
Tombstones are the one exception to "ask the orphan rules": `_retire_row`
deletes the row directly, because a tombstone exists only when the driver
enumerated the root successfully in the same pass, which is better evidence
than the stat `reindex_paths` would have to guess from — but only when the
asset ROOT is gone; an inner file of a folder asset vanishing is an edit.

One wart worth knowing rather than rediscovering: **`symlink`
is an addressing no-op**: the indexer resolves through the link, so the entity
keys on the source path exactly as `none` does. The project shows a link a user
can open; nothing downstream can tell the two apart.

## Identity

**Resolved by lookup on the origin, never read out of the bytes.** `Entity.origin_id`
holds the source's own name for an asset; two observations carrying the same
handle converge on one row. That is what makes the reflect mode irrelevant to
identity — a file indexed in place and copied into a project share an origin, so
they are one entity, and neither file has to carry an id for it to work.

The handle is per-driver, because only the driver knows what its source can
promise:

| Source | Handle | Survives a rename |
|---|---|---|
| `folder` | `folder:<source>:ino:<st_dev>:<st_ino>` | yes, within a volume (an atomic-save editor mints a new inode) |
| `git` | `GitOrigin.key()` — `uuid5(remote : rel_path)`; empty (→ fallback) when the checkout has no parseable remote | via the reported rename pair; computable for a path that no longer exists |
| `gdrive` | `gdrive:<fileId>`, read from the cache's `.gdrive-index.json` sidecar | yes — and a move, and a content replacement |
| fallback | `<provider>:<source>:path:<rel>` (`default_origin_id`) | no — a new path is a new origin |

A driver's `origin_id_for` that raises (folder on a vanished file, gdrive on
a path missing from the sidecar) is logged and falls back to the path handle;
identity derivation never fails a poll.

A folder's handle is re-read after every index pass: stamping a capsule rewrites
the file atomically, so the inode moves and a handle read once would drift.

**Renames need the transport to report them.** `ChangePage.moved` carries
`Move(origin, previous)` pairs, and only a source that can genuinely observe a move may fill it —
git can (`--find-renames`), a lossy watcher cannot. Without the pair, identity is
destroyed at the old path and re-minted at the new one.

**Some bytes are not ours to write.** A source declaring `stamps_identity = False`
reflects with `write=False`, so the identity carrier is read but never
stamped. Git declares it: an id stamped into a tracked file dirties the
working tree, is committed, and propagates to everyone who pulls. See
[asset capsules](asset-capsules.md).

## The change envelope

One shape, any producer. A webhook, a CLI, a scheduler and a test all announce a
change the same way; the system does not care who produced an event, only that
its shape is right.

```
ingest.<provider>.change.received
  target  data_source:<id>
  data    { source_id, provider, scope, refs, tombstones,
            origin, from_sha, to_sha, reason }
```

It carries **identity and a locator, never content** — the standing bus rule
(*event ≠ proof*), and what keeps a replayed or duplicated event harmless: the
receiver re-derives from the source rather than trusting the message.

**`refs` is an optimization, never a guarantee.** A producer that knows which
paths changed may say so; one that does not — Drive's `changes.watch` carries no
payload at all — sends none, and the receiver asks the source instead.
Correctness never depends on the hint, which makes a lost event a latency problem
rather than a data-loss one. `reason` is diagnostics only; nothing may branch on
it, or the producer stops being interchangeable and the single envelope has no
point.

Handlers are driven directly by tests and wired to the bus by `subscribe()`,
which `server/app.py` calls at startup right after arming the stream inbox lanes. The
bus does not await consumers, so an emitted event reaches a detached task —
asserting an outcome straight after an emit races it. Note that
`handle_change` calls `sync_source` directly, outside the poller's
`_inflight` set, so a change event and a heartbeat poll of the same source
can overlap (see *Known gaps*).

## Adding a source

1. Make the folder `agentic-assets/data_driver/<name>/` and write the class in its
   `source.py` — one `Source` subclass whose `provider` is the manifest's `name`. It
   imports the SDK; implement the protocols the provider can honour —
   `fetch`/`iterate` for a listing, `send`/`reply` (and `message_for`) for a channel,
   `open` for bytes, `verify` for a setup step.
2. Choose the stream one source reads (`query()` from its config). **Never key it on a
   mutable grouping**: a folder or a space that items move between produces duplicates
   nothing cleans up. A person watching several containers adds several sources.
3. Put resumption in the cursor string, and declare `durable_cursor` only when the
   provider can resume from it. Nothing outside the source reads it.
4. Declare only what the source can promise. A class that claims a capability it does
   not honour is worse than one that omits it.
5. Pick the family — extend `ObjectSource` (yields `FileItem`s, never a `SourceItem`),
   `RecordSource` (yields `RecordData`) or `MessageSource` (yields `MessageData`, and sends).
   One provider with two kinds of stream is two drivers (Jira: issues and their comments).
6. On an `ObjectSource` whose bytes are not yours to write, set `stamps_identity = False` and
   give the class an `origin_id_for` classmethod.
7. Write the manifest beside it, `data_driver.json` — `kind`, `auth`, `config`,
   `reflect`, and `ns` if the driver is not shipped by us. The create form is generated
   from its `config` block; nothing in `ui/` is edited, and nothing is registered
   anywhere else.
8. Add `tests/test_<name>_source.py` in the folder: the conformance kit
   (`flow_sdk.sources.testing.checks_for`) over the class, plus its wire cases against a
   loopback server (`flow_sdk.ingest.testing.local_http_server`); import the class with
   `asset_module("<name>")`.
9. Add `tests/matrix.py`: a `Double` — the provider over a loopback socket, `config` (with a
   `base_url`/host seam the driver reads, empty = the real host), `secrets` keyed as the
   manifest's `auth` names them, `deliver(text, sender=…)` for an inbound arriving now and
   `sent()` for what went out — and a `case(monkeypatch, tmp_path)` context manager over it
   yielding the config, the expectations and the double. The data source matrix
   (`tests/api/test_source_matrix.py`, `tests/api/test_source_cli_matrix.py`) drives `case`
   through create, verify, sync, items, send, reply, disable and delete; a message driver's
   `Double` is also what the stream inbox channel matrix reads through, in-process
   (`tests/unit/test_stream_inbox_channel_matrix.py`) and against a running backend
   (`tests/e2e/channel_doubles.py` hosting every driver's double for the browser runbook
   `ui/tests/manual_regression/stream-inbox/channel_matrix.md`).

A shipped source and an authored one (the same folder in a project) load the same way;
see [the data-source asset](data-source-asset.md).

## The row a record becomes

`SourceItem` is `db_only`: no `metadata.json` shadow, no walk, and FTS fed
straight from the row (`fts_content=("body",)`). The row stores the contract's
value: `origin`, the resource's `CloudOrigin(kind, namespace, key)`, and `data`,
its typed payload tagged with a `spec_kind` (`ingest.message`,
`ingest.message.email`, `ingest.feed.item`). Drivers still emit the flat
envelope; `ingest/legacy_lift.py` is the one rule that lifts it — `kind` is the
source's channel, `namespace` is the account the source reads as (the kind
itself for a source with no account; a driver that builds its own origin joins
its container, `<account>/<channel>`), `key` is the external id — and the
ingestor, the projection and the cutover migration all lift through it. Its
identity is the natural key declared once on the type —
`natural_key=("data_source_id", "origin_kind", "origin_namespace",
"origin_key")`, the flat copy of the origin a query can reach — resolved by
`DbSerializer.resolve_many` in one query per page (index
`ix_entities_source_item_origin_v3`), and gated by `digest_fields` (`ingest/digest.py`: an allowlist of
normalized fields, never `raw`). `upsert` copies only the spec's fields onto
the row, plus the natural key it resolved by, so `read` and `starred` survive
re-delivery by not being named. A
blank key component is refused by the spec (`NonBlank`), because a blank
collapses every item of a source onto one row. Two edge normalizations live
on the spec, not in drivers: `occurred_at` is coerced to aware-UTC ISO, and an
`external_id` shaped like a Slack `ts` overrides `occurred_at` outright.

## Known gaps

* `reindex_paths` mints by **extension**, so a folder-layout asset arriving from
  a source is typed as its main file — a skill folder becomes a document. Only
  the full walk knows about folder types.
* Deletion is reported and applied, but a source that cannot enumerate has no
  backstop for a missed event.
* `handle_change` ignores the event's `refs` today: the git driver's diff against
  its cursor sha is authoritative, so a hint could only be less accurate. It also
  bypasses `_inflight`, so it can run concurrently with a heartbeat poll of the
  same source.
* A source's code runs in the backend process; the sandboxed source host is a later step
  (no asset changes when it lands).
* The outbound message specs are still named per channel in
  `flow_sdk/builtin/source_item.py` (`SlackMessageSpec`, …) until the messaging verbs
  replace them.

**Key source files:** `flow_sdk/builtin/data_source.py` (the `send`, `reply`, `items`,
`sync`, `set_enabled`, `remove` actions), `source_item.py`
(`SourceItemSpec` = the row's header), `data_driver.py` (`DataDriverSpec` = the
manifest's header), `flow_sdk/ingest/` (`source_registry.py`, `sources.py`,
`credentials.py`, `testing.py`, `poller.py`, `sync.py`, `session.py`, `ingestor.py`, `models.py`,
`reflect.py`, `change_event.py`, `health.py`, `digest.py`, `ingest_on_tag.py`,
`legacy_lift.py`), `flow_sdk/sources/` (the contract), each data source's asset folder,
`flow_sdk/cli/commands/source_cmd.py` (`flow source`),
`flow_sdk/server/routes/data_source_webhook.py`,
`flow_sdk/server/routes/ingest.py`,
`flow_sdk/schema/type_info/{data_source,source_item}_type_info.py`,
`flow_sdk/fs_store/serializer/db.py` (natural-key identity + digest gate),
`flow_sdk/fs_store/origin_identity.py`, `flow_sdk/utils/kind_registry.py`

## Related

- [The data-source asset](data-source-asset.md) — the manifest a source ships as
- [Items & origins](items_origins.md) — the locators a source resolves against
- [Asset capsules](asset-capsules.md) — identity carriers, and when not to write one
- [Record model](record-model.md) — the `FSRecord` a reflected asset becomes
- [Scan and discovery](scan-and-discovery.md) — the local walk a source parallels
