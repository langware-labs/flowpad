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
the same graph. One `DataSource` owns the relationship with one remote account
or tree: which driver, what it needs to run, how often, and where its payload
becomes locally present.

A **segment** is the unit of sync: one bucket with its own bookmark — a feed
URL, a Slack channel, a git branch, a Drive shared drive. It is the noun the
whole subsystem is keyed on, and it is deliberately not called a scope or a
stream, both of which already mean something else here.

Two entities carry the state. A `DataSourceCursor` is "since last pull", **one
row per segment** — a dict on the source would make every segment's advance a
read-modify-write of the same row, and leave nowhere to record per-segment
health. A `SourceItem` is one ingested record.

```
DataSource ──(one per segment)──> DataSourceCursor
     │  origin: FSOrigin  (WHERE the bytes come from — stamped by driver.origin_for)
     │
     └─ driver.fetch() ──> SourceItemSpec ──> ingest_items() ──> SourceItem   (record: DbSerializer resolves by natural key, gates on digest)
                       └─> refs          ──> reflect_refs()  ──> files        (asset: placed, then reindex_paths)
```

## The pipeline

| Stage | File | Contract |
|---|---|---|
| dispatch | `ingest/poller.py` | One heartbeat task, never a job per source |
| one cycle | `ingest/sync.py` | Per-segment isolation, records before cursor, a budget not a backoff |
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

**Three properties `sync_source` exists to guarantee.** A segment that fails
leaves its cursor *unadvanced* and its siblings running — re-delivery is a
digest-gate no-op, so re-fetching is free and losing a window is not. The cursor
advances only after the write returns, so a crash costs a partial re-fetch and
can never open a gap. And where a provider caps us, a run spends a fixed number
of requests on the segments that waited longest (`_round_robin` by
`last_attempted_at`, never-attempted first); the cadence *is* the retry rate.

Two things the cycle also does that are easy to miss. `sync_source` stamps
`DataSource.kind` and `DataSource.channel` from the driver on every run, so a
row written before either field existed self-heals on its next poll. And a
segment enumeration failure (`driver.segments()` raising) is classified and
recorded as health exactly like a fetch failure — `_fail_source` defaults to
`config_error` but takes the classified health, so a network blip while
listing channels does not park the source.

**The digest gate is the performance story.** An unchanged item costs one indexed
read and nothing else — no save, no metadata write, no FTS write, no broadcast,
no event. In steady state `IngestReport.unchanged` should dominate; if it is near
zero on a repeat poll the gate is not working and every cycle is rewriting rows
and re-firing triggers. The cursor row honours the same rule: a segment that
was already healthy and came back `unchanged` with identical `state` and
`high_water` is **not saved** (`last_attempted_at` stays in memory), so the
steady state is one request and zero writes per feed per tick.

**Run modes and the events a cycle emits.** `IngestMode.for_run` picks
`BACKFILL` on a segment's first run or whenever a page carries more than
`STORM_CAP_PER_MINUTE` (30) items; `INCREMENTAL` otherwise. A backfill saves
with `notify=False` and emits no per-item events — the GraphWorkflow storm caps
silently drop the excess, so announcing 40 items into a 30/min cap delivers
30. The tags (`ingest/ingest_on_tag.py`, four fixed segments so the globs
behave):

| Tag | Target | When |
|---|---|---|
| `ingest.<provider>.item.created` / `.updated` | `source_item:<id>` | one per changed row, `INCREMENTAL` only; `unchanged` is silent |
| `ingest.<provider>.sync.started` / `.completed` / `.failed` | `data_source:<id>` | once per cycle; `completed` carries the counts and `changed_ids` |

The `sync.*` lane is the one a flow should subscribe to — one event per cycle,
with the ids to fan out on. Subscribing to `item.*` is opting into the per-item
lane and its 30/min ceiling.

**The write route.** `POST /api/v1/ingest/items` (`server/routes/ingest.py`,
body `{"items": [<SourceItemSpec>…], "first_run"?: bool}`, at most 500 items)
exposes the same `ingest_items` chokepoint to anything that is not the
poller — `flow record create source_item`, an agent worker, a test — so a
record written from outside converges with what the poller writes instead of
racing it. `SourceItemSpec`'s own `extra="forbid"` is the refusal: a misspelt
field is an error, not a row with an empty name.

## The driver contract

Implemented once per provider in `ingest/drivers/`, registered into a
kind-keyed registry. A driver answers *which segments does this source have* and
*what changed in one segment* — it never writes an entity, emits an event, or
advances a cursor.

**The cursor state it receives is its own.** `SegmentCursorView.state` is an
opaque dict the loop carries and never reads. That is what lets one loop serve
conditional-GET (RSS keeps `{etag, last_modified}`), changed-ids (Hacker News
keeps an update pointer) and a commit sha (git) without a branch.
`test_cursor_state_is_opaque_to_the_subsystem` (`tests/unit/test_ingest_sync.py`)
greps for violations. `DataSourceCursor.high_water` is the other half: recorded
for operators, never read back as a floor.

### Declared traits

Capabilities are declared on the driver class; the optional hooks (`verify`,
`channel_for`, `origin_id_for`, `segment_budget`, `sends`) default to `None`/`False`
on the `IngestDriver` base, so the engine reads them directly — no `getattr` probes.

| Trait | Default | Meaning |
|---|---|---|
| `provider` | — | Registry key. Distinct from `channel`, the user-facing name |
| `record_kind` | — | Ontology kind stamped on each item; decides inbox membership — the projection admits `content.message.*` and nothing else (see [the inbox projection](inbox-projection.md)). Carried by record-emitting drivers only, not the `IngestDriver` base; an authored source declares `emits` instead (see [the data-source asset](data-source-asset.md#resolved-and-what-is-left)) |
| `segment_budget` | `None` → the loop's `DEFAULT_SEGMENT_BUDGET` (5) | Segments per run; the engine takes `min(caller, driver)`. Slack declares 1 — one history call a minute |
| `attention_poll_seconds` | `None` | Sub-tick cadence while watched (see *Attention*). Telegram declares 5 |
| `kind` | — | Ontology kind of the **source** row (`datasource.feed.rss`); stamped by `sync_source` |
| `stamps_identity` | `True` | Whether this source's bytes are ours to write to |
| `origin_id_for()` | path | The source's own name for an asset |
| `origin_for()` | — | The source's tree as a typed `FSOrigin`, stamped on `DataSource.origin` at save; reflection reads it so relative structure survives |
| `verify()` | — | Is the setup finished? Distinct from health, which is about the last run |
| `send()` | — | Can this driver push a message back to its channel? |
| `identity_config_key` | `inbox` | The config field naming WHICH remote account a source serves — the natural key a caller (e.g. `blocks.Inbox`) matches on to reuse a source instead of minting a twin. Telegram declares `bot_token` |

Shipped drivers: `rss`, `hackernews`, `slack`, `agent`, `agentmail`,
`telegram`, `cloud_email`, `folder`, `git`, `gdrive` — registered by importing
`ingest/drivers/__init__.py`. Authored sources are registered from rows, not
imports: `spec_registry.refresh_spec_drivers()` sweeps `DataSourceSpec` rows
with `runtime=script` on every heartbeat tick (and, name-scoped, on the create
path in `DataSource.save`), wraps each in a `ScriptSource`, and unregisters
the ones whose spec left the disk. A spec whose name collides with a shipped
driver is refused and logged — builtins always win.

The registry is a `KindRegistry` keyed on `provider`; a miss answers `None`,
and `sync_source` records that as the `unknown_provider` config error rather
than crashing the poller.

**What a driver is, and what it is not.** The driver is Python and ships with the
SDK. Everything a *person* sees about a source — its title, its glyph, the fields
the create form renders — comes from a `data_source_spec` **asset**, one folder
per source under `agentic-assets/data_source/`. That split is what lets a source
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

Where that rule actually bites is the **source**, not the segment. A failing
segment records its own health on its cursor, but `_round_robin` does not
consult cursor health — the next cycle fetches it again. What stops polling is
the roll-up: `_roll_up` sets `DataSource.health` to the `worst_of` its cursors
(`config_error` > `transient_error` > `never_synced` > `ok`), copies the
offender's `error_code`/`error_detail` onto the source, and `may_poll()` then
refuses the whole source while its health is `config_error`. So one segment
with a dead credential parks every sibling on the next tick, even though the
cycle that discovered it finished them. `segment_count` is stamped in the same
roll-up, which is why a source that fails before enumerating reads 0.

`may_poll()` is the ONE gate — `status == active and health != config_error` —
asked by `is_due`, `request_poll` and the fast lane alike.

**Lifecycle.** `NEW` is transient: `DataSource.save` resolves it on the way
in — to `SETUP` (with a default `setup_detail`) when the driver declares
`verify`, else straight to `ACTIVE`. An unknown provider also goes `ACTIVE`,
deliberately, so the poller reaches `sync_source` and the card can show
`unknown_provider` instead of a source that silently never runs. `verify`
runs two layers in order — the channel's OAuth probe (the same one the
Connections "Test" button uses), then the driver's own `SetupVerdict` — and
moves the source to `ACTIVE` (due on the next tick) only when both pass.
`save` also stamps `channel` (from the driver, on an empty field only),
coerces `config` by the spec's field types, and re-derives `origin` via the
driver's `origin_for`.

**Operator controls** (`core_action`s on `DataSource`; all asynchronous — they
make the source due, the heartbeat does the work within a minute):

| Verb | Does | Note |
|---|---|---|
| `poll_now` | make due | **the only un-latch** for `config_error` besides `replay` (`_make_due`) |
| `request_poll` | make due, arm the fast lane | never un-latches, never wakes `disabled`/`setup` — see *Attention* |
| `reset_cursors` | clear `state` + `high_water`, keep the rows | alone it is invisible: the digest gate suppresses re-delivery. Rows are kept so `last_synced_at` survives and the next run is not a silent `BACKFILL` |
| `purge_items` | destroy the source's `SourceItem`s and their inbox projection | rebuilt rows are **new** entities; `read`/`starred` are lost |
| `replay` | `purge_items` (optionally `since=`) + `reset_cursors` + make due | widens `window_days` to cover `since`, never shrinks it; undated rows survive a bounded replay |
| `verify` | the two-layer setup check above | |

Deleting a source cascades to its cursors and items on all three paths
(`delete_by_id` — the HTTP route, `delete`, `destroy`), because nothing else
would: cursors and records are separate rows keyed to an id that would no
longer resolve.

## The two destinations

A source's payload lands **either** in the graph as a record **or** on disk as an
asset, never both. Which one is chosen by the source (`reflect`), not the driver:
the same folder could reasonably be mirrored either way, and a driver deciding it
would be deciding policy with only transport knowledge.

`ingest_items` stays the single chokepoint for `SourceItem` writes; reflection is
a second destination *beside* it rather than a branch inside it.

| Mode | Bytes | Notes |
|---|---|---|
| `record` | none — the graph | Every message-shaped driver. The default |
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
they are one entity, and neither file has to carry an identity capsule for it to
work.

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

**Renames need the transport to report them.** `FetchResult.renames` carries
old→new pairs, and only a source that can genuinely observe a move may fill it —
git can (`--find-renames`), a lossy watcher cannot. Without the pair, identity is
destroyed at the old path and re-minted at the new one.

**Some bytes are not ours to write.** A driver declaring `stamps_identity = False`
runs its reflection inside `carrier_writes_suppressed()`, and the carrier is
neither consulted nor written. Git declares it: a capsule stamped into a tracked
file dirties the working tree, is committed, and propagates to everyone who
pulls. See [asset capsules](asset-capsules.md).

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
which `server/app.py` calls at startup right after arming the inbox lanes. The
bus does not await consumers, so an emitted event reaches a detached task —
asserting an outcome straight after an emit races it. Note that
`handle_change` calls `sync_source` directly, outside the poller's
`_inflight` set, so a change event and a heartbeat poll of the same source
can overlap (see *Known gaps*).

## Adding a source

**Most sources need no Python at all.** Write a manifest and a `fetch.py` in
`agentic-assets/data_source/<name>/`, index the project, and `ScriptSource`
(`ingest/drivers/script.py`) adapts it to this same contract by calling the module
over `utils/module_rpc.py` — the engine cannot tell the difference. That path is
the one the `connect-data-source` skill drives, and it is described in
[the data-source asset](data-source-asset.md).

Write a Python driver only when the source needs something a subprocess cannot
have — a live credential that refreshes mid-sync, or an in-process client. Then:

1. Implement a driver in `ingest/drivers/` — `segments()` and `fetch()` are the
   whole required surface, both async. Register it in that package's `__init__`.
2. Choose the segment unit. **Never key it on a mutable grouping**: `segment_key`
   participates in the natural key, so a folder or a space that items move
   between produces duplicates nothing cleans up.
3. Put resumption state in the opaque `state` dict. Nothing outside the driver
   may read it.
4. Declare only what the source can promise. A driver that claims a capability
   it does not honour is worse than one that omits it.
5. Decide the destination — a record source fills `items`, an asset source fills
   `refs`/`tombstones` and never produces a `SourceItem`.
6. If the bytes are not yours to write, set `stamps_identity = False` and supply
   an `origin_id_for`.
7. Write the manifest — `agentic-assets/data_source/<name>/data_source.json`
   (the shipped ten live under
   `flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_source/`). The
   create form is generated from its `config` block; nothing in `ui/` is edited.

## The row a record becomes

`SourceItem` is `db_only`: no `metadata.json` shadow, no walk, and FTS fed
straight from the row (`fts_content=("body",)`). Its identity is the natural
key declared once on the type — `natural_key=("data_source_id", "segment_key",
"external_id")` — resolved by `DbSerializer.resolve_many` in one query per
page, and gated by `digest_fields` (`ingest/digest.py`: an allowlist of
normalized fields, never `raw`). `upsert` copies only the spec's fields onto
the row, so `read` and `starred` survive re-delivery by not being named. A
blank key component is refused by the spec (`NonBlank`), because a blank
collapses every item of a segment onto one row. Two edge normalizations live
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
* One segment's `config_error` parks the whole source (roll-up above); the
  per-segment isolation holds only within the cycle that discovers it.
* A `record`-mode source whose driver returns `refs` (a `folder`/`git` source
  saved with the row default) logs a warning, skips the refs, and still
  advances its cursor and reports `ok`.
* A failure inside `ingest_items`/`reflect_refs` is not classified: it
  escapes `_sync_stream`'s `try` (which wraps only `driver.fetch`), reaches
  the poller's "this is a bug" catch, and leaves no health on the cursor.

**Key source files:** `flow_sdk/builtin/data_source.py`,
`data_source_cursor.py`, `source_item.py` (`SourceItemSpec` = the row's header),
`data_source_spec.py` (`ManifestSpec` = the manifest's header), `flow_sdk/ingest/`
(`driver.py`, `poller.py`, `sync.py`, `ingestor.py`, `models.py`, `reflect.py`,
`change_event.py`, `health.py`, `http.py`, `digest.py`, `ingest_on_tag.py`,
`spec_registry.py`, `drivers/`, `drivers/script.py`),
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
