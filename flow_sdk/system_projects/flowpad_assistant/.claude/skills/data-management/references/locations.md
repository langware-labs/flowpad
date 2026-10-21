# Where a dataset's rows live — the rules

The project ships SHAPE (kinds, rules, viewers); the rows live wherever the person puts them.
`dataset.json` says where, in one field: `location`. Everything here ships with the SDK; nothing
is yours to build.


## FlowCall integration

ComputeOp input/output use this same ShapeForm grammar; registered kinds must resolve before execution. A list is one value, not an implicit dataset write or item loop. Named list entries may be ValueRefs; resolution is explicit. Follow the [FlowCall block recipe](../../../../docs/Getting%20Started/FlowCall.md) for call.py, typed results and chaining, while preserving dataset ownership, write and reference rules here.

## Prefer a data source

Rows that live outside the project go in a **data source** the project declares
(`agentic-assets/data_source/<name>/data_source.json`: `data_driver_name` + `data_driver_config`), and
the dataset names it — not a driver:

```json
"data_source": "gtm-drive", "path": "gtm-personas"          // path: optional, default the dataset's folder name
"data_source": "gtm-crm", "location": {"config": {"resource": "tasks"}, "map": {...}, "by": "crm"}   // a record system
```

- No `data_source` (or `"local"`) = the default source, `<dataset>/rows/`.
- While the source is not set up on this machine the rows are read and written locally, and the
  dataset's `rows_note` says why. That is not an error: don't "fix" it by inlining a location.
- A folder that already holds rows is adopted (read on the first pull; `move-rows` keeps them).
- `move-rows {"location": {"data_source": "<name>"}}` moves a dataset's rows into a source.

## The inline forms (older; still read)

| `location` | Rows live in |
| --- | --- |
| `"local"` (default) | `<dataset>/rows/`, kept out of git (the first write adds it to `.gitignore`) |
| `"file:<folder>"` | `<folder>/rows/` on this machine |
| `"gdrive:<folder path>"` | a Drive folder — the Google connection, drive write scope |
| `"s3:<bucket>/<prefix>"` | S3 — the `aws` credential (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) |
| `{"driver", "config", "map", "by"?, "read_only"?}` | a record system (a CRM, a tracker): one record per row |

A remote location is read and written through a working copy under the instance
(`<instance>/cache/rows/<dataset id>/`), never in the project: pulled before every read and write,
pushed after a write. You never touch it.

```json
"location": {"driver": "twenty", "config": {"resource": "tasks"}, "by": "crm",
             "map": {"key": "external_id",
                     "input": {"title": "data.title", "status": "data.status", "crm_id": "external_id",
                               "deals": {"link": "crm.deal", "by": "crm_id", "path": "data.deal_ids.*"}}}}
```

A link is `{"link": <kind>, "by": <a unique field of that kind>, "path": …}`. When the system holds the
KEY of a row that is yours, say `"by": "key"` — then a rename here does not reach the system; don't
offer one, and record the choice in `docs/data-decisions.md`.

## The laws

1. **A mapped field is the system's.** Every field the map names MUST be `owned_by` the location's
   `by`, or the pull is refused (code `not_owned`). A field the map does NOT name is the app's own.
2. **An edit to the system's field goes to the system first.** Write the row as usual —
   `ds.put(key, {input}, {expected})`, `append`, `put-row` — and Flowpad sends what changed through
   the driver, then writes the row as the system answered. A delete removes the record first.
3. **So a field your users edit that the system must also have is the system's field.** Add it there,
   to the map, and mark it `owned_by`. No merge exists, so none can go wrong.
4. **Only the server holds a driver.** In a script, `Dataset.put` of an owned field is refused
   `owned`, and a sync write to a remote location inside the server raises. A script sends the edit
   with the row action — `local_client.graph_post(f"dataset/{ds.id}/put-row", {...})`.
5. **Rows are data, not code.** `git ls-files agentic-assets/dataset/*/rows` is empty
   (`flow_sdk.datasets.locations.tracked_rows(root)`).

## What a write answers

| Code (`details[].code`) / status | Means | Do |
| --- | --- | --- |
| 409 `Conflict` | someone else wrote the row at the location since it was read | pull, re-read, try again |
| `owned` | not the owner, read-only, or no driver here (a script) | use the row action; or the field is not editable |
| `not_writable` | the map reads this field from a path it cannot write | show it read-only |
| `source_refused` | the system said no (its words follow) | show the message; nothing was written |
| `unlinked` | a list of links holds ids no row here resolves yet | bring in the linked kind first |
| warning `source_partial` | the record was made, one part was not set | SHOW it — the row is saved |

A pull of a record system answers like `sync`, plus `misfit` (records kept as `problems` rows),
`unlinked` and `referenced` (rows gone outside still linked here, kept until the link goes).

## Pull and move

`POST dataset/<id>/pull` → `{moved, num_rows}` (`dataset.pull()`). `POST dataset/<id>/move-rows
{"location"}` → `{from, to, rows}` (`dataset.moveRows(location)`): copies, checks the count, rewrites
`dataset.json`; the old location keeps its rows. Refused into a non-empty location or a record system.

## `three_way` is not for this

`flow_sdk.datasets.three_way(here, there, agreed)` decides one field between two stores that BOTH
accept edits offline with nothing between them. A row in a record system never needs it: law 2 leaves
nothing to merge.
