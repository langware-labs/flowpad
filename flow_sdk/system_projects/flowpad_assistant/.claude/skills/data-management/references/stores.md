# Where a dataset's rows live — the rules

The project ships SHAPE (kinds, rules, viewers); the rows live wherever the person puts them:
**dataset → data source → data store**. Everything here ships with the SDK; nothing is yours to build.


## FlowCall integration

ComputeOp input/output use this same ShapeForm grammar; registered kinds must resolve before execution. A list is one value, not an implicit dataset write or item loop. Named list entries may be ValueRefs; resolution is explicit. Follow the [FlowCall block recipe](../../../../docs/Getting%20Started/FlowCall.md) for call.py, typed results and chaining, while preserving dataset ownership, write and reference rules here.

## A dataset names at most one data source

A data source is the project's `agentic-assets/data_source/<name>/data_source.json`
(`data_driver_name` + `data_driver_config`). The dataset names it — never a driver:

```json
"data_source": "gtm-drive", "path": "gtm-personas"     // path: optional, default the dataset's folder name
```

- **No `data_source` = the project's data store**: the source `flow.json` names as
  `"data_store": "<name>"`, else this instance's folder `<instance>/data_stores/<project ns>/<dataset folder>/`.
  Never inside the project, never in git — a `rows/` folder inside a dataset folder is a leftover.
- **A source not set up holds nothing**: reads and writes are refused (`NotSetUp`, 503) until its setup
  is done. There is no local fallback — finish the setup (connect-data-source), don't work around it.
- `DM ds-move <ds> [<data source>] [--path F]` (`move-rows {"data_source"?, "path"?}`) moves the rows;
  no source = the project's data store.

## The driver's family is the source's type

| Type | Drivers | Holds |
| --- | --- | --- |
| object store | `flow_storage` (Flowpad hub), S3, GCS, Drive; a folder on this machine (`gdrive_mount`) | whole rows, `rows/<key>/row.json` + slot files |
| system of record | a CRM (Twenty) | the fields the data model marks `truth`; the rest of each row in the project's data store, joined by the row key |
| message channel | mail, chat | messages — not a place for rows |

A remote store is read and written through a working copy under the instance
(`<instance>/cache/rows/<dataset id>/`): pulled before every read and write, pushed after a write.
You never touch it.

## Field truth (system of record)

In the row kind's `data_schema.json`:

```json
"name":   {"shape": "string", "truth": "soc.data.title"},
"status": {"shape": "string", "truth": "soc"},
"crm_id": {"shape": "string", "truth": "soc.external_id"},
"deal":   {"shape": "crm.deal", "truth": {"link": "crm.deal", "by": "crm_id", "path": "soc.data.deal_id"}},
"notes":  {"shape": "?string"}
```

`"soc"` = `data.<field name>`; `"soc.<path>"` any path of the record envelope (`external_id`,
`permalink`, `data.*`); `{"value": x}` a constant. A link's `by` is a unique field of that kind, or
`"key"` when the system holds a row KEY of yours — then a rename here does not reach the system; don't
offer one, and record the choice in `docs/data-decisions.md`.

## The laws

1. **Exactly one field reads `soc.external_id`.** It joins a row to its record; without it the pull fails.
2. **A truth field is the system's.** Only the system writes it (`by="soc"`, `DM … --by soc`). A field
   without `truth` is the app's own.
3. **An edit to a truth field goes to the system first.** Write the row as usual —
   `ds.put(key, {input}, {expected})`, `append`, `put-row` — and Flowpad sends what changed through
   the driver, then writes the row as the system answered. A delete removes the record first.
4. **So a field your users edit that the system must also have is the system's field.** Add it there
   and mark it `truth`. No merge exists, so none can go wrong.
5. **Only the server holds a driver.** In a script, `Dataset.put` of a truth field is refused `owned`,
   and a sync write to a remote store inside the server raises. A script sends the edit with the row
   action — `local_client.graph_post(f"dataset/{ds.id}/put-row", {...})`.

## What a write answers

| Code (`details[].code`) / status | Means | Do |
| --- | --- | --- |
| 503 `NotSetUp` | the data source is not set up on this machine | finish its setup |
| 409 `Conflict` | someone else wrote the row in the store since it was read | pull, re-read, try again |
| `owned` | not the system, read-only, or no driver here (a script) | use the row action; or the field is not editable |
| `not_writable` | the truth path cannot be written back (`external_id`) | show it read-only |
| `source_refused` | the system said no (its words follow) | show the message; nothing was written |
| `unlinked` | a list of links holds ids no row here resolves yet | bring in the linked kind first |
| warning `source_partial` | the record was made, one part was not set | SHOW it — the row is saved |

A pull of a system of record answers like `sync`, plus `misfit` (records kept as `problems` rows),
`unlinked` and `gone` (rows whose record left the system, kept for their own fields).

## Pull and move

`POST dataset/<id>/pull` → `{moved, gone, num_rows}` (`dataset.pull()`, `DM ds-pull`).
`POST dataset/<id>/move-rows {"data_source"?, "path"?}` → `{from, to, rows}`
(`dataset.moveRows({data_source, path})`): copies, checks the count, rewrites `dataset.json`; a key
already there keeps its copy there; the old store keeps its rows. Refused into a system of record.

## `three_way` is not for this

`flow_sdk.datasets.three_way(here, there, agreed)` decides one field between two stores that BOTH
accept edits offline with nothing between them. A row in a system of record never needs it: law 3 leaves
nothing to merge.
