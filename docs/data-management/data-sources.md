---
id: 44d26316-873d-49f6-95c2-e61d74dee7e6
---

# Data sources

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
     │
     └─ driver.fetch() ──> items ──> ingest_items()  ──> SourceItem   (record)
                       └─> refs  ──> reflect_refs()  ──> files        (asset)
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
no backoff.

**Three properties `sync_source` exists to guarantee.** A segment that fails
leaves its cursor *unadvanced* and its siblings running — re-delivery is a
digest-gate no-op, so re-fetching is free and losing a window is not. The cursor
advances only after the write returns, so a crash costs a partial re-fetch and
can never open a gap. And where a provider caps us, a run spends a fixed number
of requests on the segments that waited longest; the cadence *is* the retry rate.

**The digest gate is the performance story.** An unchanged item costs one indexed
read and nothing else — no save, no metadata write, no FTS write, no broadcast,
no event. In steady state `IngestReport.unchanged` should dominate; if it is near
zero on a repeat poll the gate is not working and every cycle is rewriting rows
and re-firing triggers.

## The driver contract

Implemented once per provider in `ingest/drivers/`, registered into a
kind-keyed registry. A driver answers *which segments does this source have* and
*what changed in one segment* — it never writes an entity, emits an event, or
advances a cursor.

**The cursor state it receives is its own.** `SegmentCursorView.state` is an
opaque dict the loop carries and never reads. That is what lets one loop serve
conditional-GET (RSS keeps `{etag, last_modified}`), changed-ids (Hacker News
keeps an update pointer) and a commit sha (git) without a branch.
`test_cursor_state_is_opaque` greps for violations.

### Declared traits

Capabilities are declared, not inherited — a driver implements what its source
can actually promise, and the engine composes behaviour from that.

| Trait | Default | Meaning |
|---|---|---|
| `provider` | — | Registry key. Distinct from `channel`, the user-facing name |
| `record_kind` | — | Ontology kind stamped on each item. Decides inbox membership: the projection admits `content.message.*` and nothing else |
| `segment_budget` | 5 | Segments per run. Slack declares 1 — one history call a minute |
| `stamps_identity` | `True` | Whether this source's bytes are ours to write to |
| `origin_id_for()` | path | The source's own name for an asset |
| `source_root()` | — | Where the source's tree begins, so relative structure survives reflection |
| `verify()` | — | Is the setup finished? Distinct from health, which is about the last run |
| `send()` | — | Can this driver push a message back to its channel? |

Shipped drivers: `rss`, `hackernews`, `slack`, `agent`, `agentmail`,
`cloud_email`, `folder`, `git`, `gdrive`.

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

One behavioural rule: **`config_error` stops polling that scope, `transient_error`
never does.** `SourceError.for_status` is the one status→health table — a 429
read as permanent would park a source forever over a rate limit.

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
| `in-place` | same as `none` | Git-native name; asserts one repository |
| `materialize` | cloned into a local cache | A real repo with history, not copied bytes |
| `vendor` | copied into the receiving repo | They become tracked content there, and will be committed |

Every mode ends at `reindex_paths`. None writes an entity or touches FTS
directly — that boundary is asserted by tests, because a mode that quietly
minted a row would still make every functional test pass.

Two warts worth knowing rather than rediscovering. **`none` and `in-place` are
the same behaviour under two names**; the git name exists so a source asserting
one repository does not read as one that forgot to set a target. And **`symlink`
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
| `folder` | inode (`st_dev:st_ino`) | yes, within a volume |
| `git` | `GitOrigin.key()` — `uuid5(remote : rel_path)` | via the reported rename pair |
| `gdrive` | Drive's `fileId` | yes — and a move, and a content replacement |
| fallback | source-relative path | no — a new path is a new origin |

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

Handlers are driven directly by tests and wired to the bus by `subscribe()`. The
bus does not await consumers, so an emitted event reaches a detached task —
asserting an outcome straight after an emit races it.

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
7. Write the manifest — `agentic-assets/data_source/<name>/data_source.json`. The
   create form is generated from its `config` block; nothing in `ui/` is edited.

## Known gaps

* `reindex_paths` mints by **extension**, so a folder-layout asset arriving from
  a source is typed as its main file — a skill folder becomes a document. Only
  the full walk knows about folder types.
* Deletion is reported and applied, but a source that cannot enumerate has no
  backstop for a missed event.
* `handle_change` ignores the event's `refs` today: the git driver's diff against
  its cursor sha is authoritative, so a hint could only be less accurate.

**Key source files:** `flow_sdk/builtin/data_source.py`,
`data_source_cursor.py`, `source_item.py`, `flow_sdk/ingest/` (`driver.py`,
`poller.py`, `sync.py`, `ingestor.py`, `reflect.py`, `change_event.py`,
`health.py`, `digest.py`, `drivers/`)

## Related

- [The data-source asset](data-source-asset.md) — the manifest a source ships as
- [Items & origins](items_origins.md) — the locators a source resolves against
- [Asset capsules](asset-capsules.md) — identity carriers, and when not to write one
- [Record model](record-model.md) — the `FSRecord` a reflected asset becomes
- [Scan and discovery](scan-and-discovery.md) — the local walk a source parallels
