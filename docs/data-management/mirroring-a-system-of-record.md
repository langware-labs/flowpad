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

## The mirror, today

1. **The schema says who owns what.** Fields copied from outside carry `"owned_by": "<system>"`;
   the outside id is a natural key, `{"unique": ["crm_id"]}`; fields several kinds share
   (`crm_id`, `updated`) are defined once and `include`d. A date you will ask about later is a
   field (`stage_dates`) — there is no row history.
2. **One sync writes the rows.** Read the outside system, build `[{key, input}]`, and
   `await dataset.sync(rows, by="<system>", match=<your slice>)`: new rows are created, changed
   ones replaced, unchanged ones left untouched, rows no longer there removed — all or nothing.
   Wrap the whole run in `single_run(project_root, "<name>")`.
3. **Fields the app owns go back** by the three-way rule
   (`flow_sdk.datasets.three_way(here, there, agreed)`): the side that changed since they last
   agreed wins; both changed is held and reported, never last-writer-wins.
4. **The app reads rows, not the outside system**: `rows({match, expand})`, `count`, and
   `onRowsChanged` to re-read when the sync wrote. A link out is `openExternal(url)`.

## What is not there yet

- **Source items → typed rows.** A driver's items are records of the kind `ingest.source_item`;
  nothing turns them into rows of your own kind. Today the sync builds the rows itself (step 2),
  reading the outside system directly or the source's items
  (`flow_sdk.local_client.graph_get("source_item", {...})`).
- **Write-back of records.** The driver contract names `create` / `update` / `delete`, but nothing
  calls them: step 3's push is the sync's own request.
- **A browser app cannot call the outside system.** By design: a general "fetch with a stored
  credential" would hand any frame a signed request to any host. What an app needs from outside is
  mirrored into rows.

Planned as its own phase: `source.mirror_into(dataset, map=…)` over `Dataset.sync`, and the
driver's `update` / `delete` as data-source actions.
