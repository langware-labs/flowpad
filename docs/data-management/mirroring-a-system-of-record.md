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
3. **`mirror` turns the items into YOUR rows**, and keeps them so:

   ```python
   await deals.mirror(source, {"key": "external_id",
                               "input": {"name": "name", "stage": "data.stage", "crm_id": "external_id"}})
   ```

   Each value of the map is a path into the item (`{"value": x}` a constant); an item becomes one
   row, keyed by its `key` path. The mirror owns the fields the map names and no others: what the
   app keeps on a mirrored row (its notes, its tags) stays. It is `Dataset.sync` underneath: new rows created, changed ones
   replaced, unchanged ones untouched, rows whose item is gone removed — all or nothing — written
   as the source's provider (`by`), so the schema's `owned_by` fields accept them. A script (which
   cannot read the store) passes the items it fetched:
   `deals.mirror(local_client.graph_get("source_item", {...}), map, by="crm")`. Over REST:
   `POST dataset/<id>/mirror {source_id, map}`; TypeScript `dataset.mirror(sourceId, map)`.
   A row that is more than a reshaped item (joined from two streams, computed) is still built by
   your own code and handed to `sync` — wrap that run in `single_run(project_root, "<name>")`.
4. **Fields the app owns go back through the source**, not through a client of your own:
   `await source.update_item(item_id, {"gtmPersona": "cfo"})` (and `delete_item`) call the
   driver's own `update` / `delete` with the credential the source holds — REST
   `POST data_source/<id>/update_item {item_id, changes}`, TypeScript `source.updateItem(itemId,
   changes)`. Refused before any I/O for a `read_only` source (403) and for a driver that cannot
   write (400). Which side wins a field both changed is the three-way rule
   (`flow_sdk.datasets.three_way(here, there, agreed)`): never last-writer-wins.
5. **The app reads rows, not the outside system**: `rows({match, expand})`, `count`, and
   `onRowsChanged` to re-read when the mirror wrote. A link out is `openExternal(url)`.

## What is not there, on purpose

- **A browser app cannot call the outside system directly.** A general "fetch with a stored
  credential" would hand any frame a signed request to any host. What an app reads from outside is
  mirrored into rows; what it writes back goes through `updateItem`, which only ever reaches the
  source's own system, with the driver's own verbs.
- **A driver that does not implement `update` / `delete` cannot write back** — the capability is
  discovered (`isinstance(source, Mutable)`), never declared. Writing a driver for a system of
  record: the `connect-data-source` skill, `author <system>`.
