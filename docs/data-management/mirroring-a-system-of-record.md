---
id: d6c39daa-b906-4950-b4aa-81e5cbefa32a
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

   After every sync of the source the dataset is made the mirror of its records
   (`flow_sdk/datasets/projection.py`): each item becomes one row, keyed by its `key` path, which
   must also be mapped to a field (`crm_id` here) — that is how a row finds its record again. It is
   `Dataset.mirror` underneath: new rows created, changed ones replaced, rows whose record is gone
   removed, all or nothing, written as `by` (default: the source's provider) so the schema's
   `owned_by` fields accept them. The mirror owns the fields the map names and no others: what the
   app keeps on a mirrored row (its notes, its own links) stays.

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

   A writer that writes AS the outside system (`by` = the mirror's `by`) is the mirror itself and
   sends nothing. Called directly, the source's verbs are `source.create_item(data)`,
   `update_item(item_id, changes)` and `delete_item(item_id)` — REST
   `POST data_source/<id>/{create,update,delete}_item`, TypeScript `createItem`, `updateItem`,
   `deleteItem`. `data` is the record shape the driver's `create` names (a `RecordData` subclass), checked before any
   I/O.
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
  source that lists a window (a feed, a mailbox) leaves it `False`: absence proves nothing. One
  guard: a listing that comes back empty removes nothing: an outage is likelier than a
  collection emptied in one step.

## What is not there, on purpose

- **A browser app cannot call the outside system directly.** A general "fetch with a stored
  credential" would hand any frame a signed request to any host. What an app reads from outside is
  mirrored into rows; what it writes back goes through `updateItem`, which only ever reaches the
  source's own system, with the driver's own verbs.
- **A driver that does not implement `create` / `update` / `delete` cannot write back** — the
  capability is discovered (`isinstance(source, Mutable)`), never declared. A driver that can
  types `create(data: <its RecordData>)`: what `create_item` checks a new record against. Writing a driver for a system of
  record: the `connect-data-source` skill, `author <system>`.
