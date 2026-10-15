---
id: 11d63dec-152a-43bf-836e-c28eea9ae57c
---
# Mirroring a system of record

How an app keeps typed rows in step with an outside system that owns them — a CRM's deals, a
ticket tracker's issues — and what Flowpad does and does not do for it today.

## The parts, and whose each is

| Part | Is | Does |
|---|---|---|
| credential | what is needed, never where its value lives | names the key (`TWENTY_API_KEY`); a secret store holds it |
| data driver | a folder, `agentic-assets/data_driver/<name>/` | knows the outside system: reads it with the credential it is handed |
| data source | one configured instance of a driver | reads ONE stream (the CRM's people; its opportunities is a second source) into records |
| source item | one ingested record | a row of that stream, as the outside system has it |
| dataset | the folder of typed rows | YOUR model of it: kinds, links, `rules`, what the app shows and edits |

A source never reads a secret store itself, and an app never holds a key: the driver is the one
place that knows the outside system.

## The mirror

1. **The schema says who owns what.** Fields copied from outside carry `"owned_by": "<system>"`;
   the outside id is a natural key, `{"unique": ["crm_id"]}`; fields several kinds share
   (`crm_id`, `updated`) are defined once and `include`d. A date you will ask about later is a
   field (`stage_dates`) — there is no row history.
2. **A data source reads the outside system** — a record driver holding the credential (the
   shipped `jira` driver is the template: `auth: {credential, vars}` in its manifest, one source
   per stream). Its items are records of the kind `ingest.source_item`.
3. **The source declares the dataset its records mirror into** — in its `data_source.json`:

   ```json
   "mirror": {"dataset": "tasks", "by": "crm",
              "map": {"key": "external_id",
                      "input": {"title": "data.title", "status": "data.status", "crm_id": "external_id",
                                "deals": {"link": "gtm.opportunity", "by": "crm_id", "path": "data.deal_ids.*"}}}}
   ```

   A link's `by` is a `unique` field of the linked kind (the system holds an id); `"by": "key"` when
   the system holds the linked row's KEY — a row that is yours, tagged onto its record.

   After every sync of the source the dataset is made the mirror of its records
   (`flow_sdk/datasets/projection.py`): each item becomes one row, keyed by its `key` path, which
   must also be mapped to a field (`crm_id` here) — that is how a row finds its record again. It is
   `Dataset.mirror` underneath: new rows created, changed ones replaced, rows whose record is gone
   removed, written as `by` (default: the source's provider) so the schema's `owned_by` fields
   accept them. `by` names the owner EXACTLY — a mirror written as anyone else is refused whole
   (`owned`): that is the declaration's mistake, not the outside system's. The mirror owns the
   fields the map names and no others: what the app keeps on a mirrored row (its notes, its own
   links) stays. A record whose value does not fit the row kind does not stop the others — see
   *When it goes wrong*.

   The map, in the path grammar: a path (`data.status`), a constant (`{"value": x}`), a nested
   object, a list; a path through `*` gives a list (`data.labels.*.name`). A **link** is
   `{"link": <kind>, "by": <field>, "path": <path>}`: the outside system's id at `path` becomes a
   link to the row of `kind` whose `by` — a `unique` field of that kind — holds it (one link, or a
   list through `*`). An id no row holds is left out and named in the answer's `unlinked`; a row
   whose link fields are all empty links nothing (a general task).

   A script can still mirror by hand: `await tasks.mirror(items, map, by="crm")`; over REST
   `POST dataset/<id>/mirror {source_id, map}`; TypeScript `dataset.mirror(sourceId, map)`.
   A row that is more than a reshaped item (joined from two streams, computed) is built by your own
   code and handed to `sync` — wrap that run in `single_run(project_root, "<name>")`.
4. **A row's outside-owned fields write through the source.** In a mirrored dataset, `put-row`,
   `put-rows`, `append`, `delete-row` and `delete-rows` (TypeScript `put`, `putMany`, `append`,
   `deleteRow`, `deleteRows`) send what a write changes in the fields `by` owns to the outside
   system FIRST: an existing row through `update_item`, a new row through `create_item` (it then
   takes its record's key), a removed row through `delete_item`. Only what changed goes out, in the
   outside system's own names: the map read backwards, so only `data.<name>` paths — and links over
   one, sent as the linked rows' `by` values — can go back. The record the driver answers is kept
   at once and projected into the row; the app's own fields are written with it.

   | Refusal | When | Nothing written |
   |---|---|---|
   | `not_writable` (400) | a changed field comes from a path that cannot go back (`external_id`, `occurred_at`) | before any I/O |
   | `source_refused` (400) | the outside system refused the change | here |
   | `owned` (400) | the source is `read_only`, or its driver is not `Mutable` | before any I/O |
   | `unlinked` (400) | a list of links is written on a row whose RECORD holds ids no row here resolved (the mirror left them out, `unlinked`): sending the list as the row has it would drop those links outside. Mirror the rows they point at first; the row's other fields still go through | before any I/O |

   A write the outside system made but not all of — the driver needed several calls (the record,
   then its links) and a later one failed — is NOT a refusal: the record exists, the row is written
   as the record is, and the answer carries `warnings` (`[{error_code: "source_partial", message,
   key}]`, inside `data` and on the envelope; TypeScript `ds.put(...)` → `.warnings`). Show it; the
   next sync reflects what was actually set.

   A writer that writes AS the outside system (`by` = the mirror's `by`) is the mirror itself and
   sends nothing. Called directly, the source's verbs are `source.create_item(data)`,
   `update_item(item_id, changes)` and `delete_item(item_id)` — REST
   `POST data_source/<id>/{create,update,delete}_item`, TypeScript `createItem`, `updateItem`,
   `deleteItem`. `data` is the record shape the driver's `create` names (a `RecordData` subclass), checked before any
   I/O; the answer is `{item_id, origin, status, warnings?}`.
5. **The app reads rows, not the outside system**: `rows({match, expand})`, `count`, and
   `onRowsChanged` to re-read when the mirror wrote. A link out is `openExternal(url)`.

## What a record driver must know

- **A record's typed fields are part of change detection.** A record is a row updated in place: its
  `data` (an issue's `status`, a deal's `stage`) joins the change digest, so the next sync stores
  what the outside system changed. Fields that move on their own (a view count, a provider's raw
  echo) go in the payload class's `volatile` set, or every sync reads as a change.
- **A record removed outside is removed here, when the source lists everything.** A driver whose
  listing is the whole collection (a table, a CRM object) declares `lists_everything = True`. A pass
  read from the start to the end then proves what exists: a stored record it no longer lists is
  deleted, the sync answers `removed: N`, and the next `mirror(..., prune=True)` drops its row. A
  source that lists a window (a feed, a mailbox) leaves it `False`: absence proves nothing. An
  EMPTY listing is proof like any other — the last record deleted outside goes here too — because a
  traversal that completed is a traversal that got an answer; an outage must RAISE (the SDK's
  `http` helpers do), never return no rows. A driver whose `_scan` swallows errors and returns `[]`
  would wipe its records.
- **A listing is one scan.** `CollectionSource.fetch` scans the collection when it is given no
  cursor and pages THAT scan for the cursors it hands back, so a traversal costs one listing whatever
  the page size; set `page_size` (up to `MAX_PAGE_SIZE`) to the provider's own page, and
  `pages_per_pass` when its rate cap allows one request per interval.
- **A write that takes several calls answers what it made.** `create`/`update` return the record;
  when a later call failed (the links, a tag) the record is still returned, with
  `SourceItemSpec.warnings` saying what was not set — never an exception, which would lose the record
  the system now has (and make the next retry a duplicate). A driver that can undo its first call
  on a later failure may do that instead, and then raise.
- **A change made outside lands within the poll interval** unless the driver takes pushes: a system
  that posts webhooks implements `webhook_challenge` / `webhook_account` / `events_from_webhook`
  (the *Webhooks* part of [`data-sources.md`](data-sources.md)), and the SDK ingests the event at once.

## When it goes wrong

The mirror is a projection of someone else's data; it fails in three ways, each said in one place:

| What | Where it shows | What happens to the rows |
|---|---|---|
| a RECORD does not fit the row kind (a status the enum lacks, a wrong type, a link that does not hold) | the row is a **problem** — `rows().problems`, with its input intact; the source card reads `mirror_misfit` ("N record(s) did not fit the row kind: …") | every other record is mirrored; the misfit row is invisible to `rows()` until it fits again, and is never pruned while the record is listed |
| a row is GONE outside while another row here still links to it | the answer names it in `referenced` (code `referenced`, "used by …"); the source card reads `mirror_misfit` ("N row(s) gone outside are still used here: …") | that row is KEPT, and what it links to with it; every other record is mirrored and pruned; it goes on the sweep after the link does |
| the SWEEP itself failed (the dataset is missing, the map names no such kind, a `by` that is not the owner, a mapped field the schema does not mark `owned_by` that `by` — code `not_owned`) | the source card reads `mirror_failed` with the reason; `health` stays `ok` and polling goes on | nothing written this sweep; the next good sweep clears the mark |
| the LISTING came back empty | nothing: it is the truth | every row goes (`deleted`) — and comes back on the next sync if the system has them again |

The answer of `Dataset.mirror` (and the `mirror` action) names every kind of leftover:
`misfit: [{key, details}]`, `unlinked: [{key, field, value}]` and `referenced: [{key, details}]`. The card's mark is the
`write_back_held` pattern (`DataSource.isMirrorBroken` in TypeScript; attention kind `mirror`).
An app's own batch write (`put_many`, `sync-rows`) is NOT lenient: it fits whole or writes nothing.

Design the schema for this: a field the outside system owns is an open `?string` whose description
names the values you know — a closed `enum:` there turns the system's next value into a problem row.
`enum:` is for the fields that are yours.

## Every mapped field is the outside system's

A field the map names is rewritten from the record on every sweep. If the schema let the app write
it too, an edit would be taken and then silently lost at the next sweep — so a declared mirror
whose map names a field that is not `owned_by` its `by` is refused (`mirror_failed`, `not_owned`).
The consequence is the design rule: **a field your users edit that the system must also have is
the system's field.** Add it to the system, to the map, and mark it `owned_by`. It is edited here,
sent there first, and an edit made there arrives at the next sync. There is no two-sided merge, no
stored "agreed" value and no hold state — and so none to get wrong. (`three_way` is for two stores
with no source between them; a mirrored row never needs it.)

One way in, wherever the write comes from: the row actions (`put-row`, `put-rows`, `append`) and
Python's `Dataset.put` / `put_many` / `append` share it. Only the server holds a driver, so in any
other process (a script) `Dataset.put` of an owned field is refused `owned`; a script sends the
edit with the row action. Deleting a mirrored row in the outside system is the `delete-row` /
`delete-rows` action.

## What is not there, on purpose

- **A browser app cannot call the outside system directly.** A general "fetch with a stored
  credential" would hand any frame a signed request to any host. What an app reads from outside is
  mirrored into rows; what it writes back goes through `updateItem`, which only ever reaches the
  source's own system, with the driver's own verbs.
- **A driver that does not implement `create` / `update` / `delete` cannot write back** — the
  capability is discovered (`isinstance(source, Mutable)`), never declared. A driver that can
  types `create(data: <its RecordData>)`: what `create_item` checks a new record against. Writing a driver for a system of
  record: the `connect-data-source` skill, `author <system>`.
