---
id: 11d63dec-152a-43bf-836e-c28eea9ae57c
---
# Dataset stores — where a dataset's rows live

The app ships the SHAPE (kinds, rules, viewers) and the DRIVERS. The rows live wherever the person
puts them: **dataset → data source → data store**. The spec is the module docstring of
`flow_sdk/datasets/stores.py` (and of `flow_sdk/datasets/truth.py` for field truth).

## A dataset names at most one data source

```json
"data_source": "gtm-drive",     // agentic-assets/data_source/gtm-drive/data_source.json
"path": "gtm-personas"          // its folder inside the source; default: the dataset's folder name
```

- **No `data_source` → the project's data store.** That is the data source `flow.json` names as
  `"data_store": "<data source name>"` (it must be an object store), else this instance's folder
  `<instance>/data_stores/<project ns>/<dataset folder>/` — named by what the project's git holds, so a
  fresh clone or a moved project finds its rows again. Rows are never inside the project, never in git.
- **A source that is not set up holds nothing.** Before a session the dataset asks its source
  (`stores.readiness`: the `DataSource` row's `setup_owed`, disabled, config error). Until setup is
  done every read and write is refused — `NotSetUp`, a row action answers **503**. Rows are never kept
  anywhere else meanwhile.
- **A source knows what it hosts** (`DataSource.datasets()`). A source that hosts datasets is a
  container, not a feed: its poll is only its setup check, nothing in it is ingested, and the setup
  tree labels it "hosts N datasets".

## The source's driver family is its type

| Driver type | Drivers | Holds |
|---|---|---|
| **object store** (`DataDriver.holds_rows`) | `flow_storage` (the Flowpad hub), S3, GCS, Drive — a `RowFiles` source placing the dataset inside it (`rows_within`); or a folder on this machine (`rows_folder`: `gdrive_mount`) | whole rows: `rows/<key>/row.json` and the slot files beside it |
| **system of record** (`DataDriver.is_system_of_record`, family `record`) | a CRM such as Twenty | the fields the data model marks `truth`; every other field and the slot files live in the project's data store, one row key joins both |
| **message channel** (family `message`) | mail, chat | messages, not dataset rows |

A bad `data_source` (no such source, a driver that cannot hold rows) is refused with what is wrong
(`ValueError`).

## The working copy

Rows are always read and written through a local folder: the store's own for a folder on this machine,
else a disposable working copy under the instance — `<instance>/cache/rows/<dataset id>/`. It is never
in a project and never a second truth.

Every async read and write, and every row action, runs in `Dataset.rows_session(write=...)`: a remote
store is pulled first, and a write's changes are pushed after. Rows on this machine skip both.

## Object stores: commit point and conflicts

A row's `row.json` is its commit point. A push sends the slot files first and `row.json` last, as a
write conditioned on the version last seen. If someone else wrote the row since, the write is a
`Conflict` (`flow_sdk.sources.Conflict`) and a row action answers **409**; pull and try again. A row
folder without `row.json` (an interrupted write) is not read.

S3 conditions the write itself (ETag `If-Match` / `If-None-Match: *`). Drive has no conditional
write: the version is checked right before it, so a second writer inside that gap is not caught.

## Systems of record — field `truth`

A field of the row kind says, in `data_schema.json`, that the system of record holds it:

```json
"name":   {"shape": "string", "truth": "soc.data.title"},
"stage":  {"shape": "string", "truth": "soc"},
"crm_id": {"shape": "string", "truth": "soc.external_id"},
"icp":    {"shape": "gtm.icp", "truth": {"link": "gtm.icp", "by": "key", "path": "soc.data.gtm_icp"}},
"notes":  {"shape": "?string"}
```

- `soc` is the record as a flat envelope (`external_id`, `permalink`, `data.<field>`); `"soc"` alone
  reads `data.<the field's name>`; `{"value": x}` is a constant. A link makes the system's id at `path`
  a link to the row of `link` whose `by` (a `unique` field, or `key`) holds it; an id no row holds is
  left out and named in `unlinked`.
- **Exactly one field reads `soc.external_id`** — it joins a row to its record. Without it the pull
  is refused.
- A field without `truth` is the app's own, kept in the project's data store. In any other source
  `truth` is ignored: every field is the app's.
- **Only the system writes a truth field** (`by="soc"`: a pull, a write-through's answer; `DM … --by
  soc`). Anyone else changing one is refused `owned` — unless the change goes to the system first:
- **Write-through.** A write that changes a truth field goes to the system FIRST — an existing row
  through `update_item`, a new row through `create_item`, a delete through `delete_item`
  (`flow_sdk/datasets/projection.py`). Only what changed goes out, in the system's own names. The row
  is then written as the system answered; the app's own fields are written with it.
- **A pull re-mirrors every record**: new rows created, changed ones updated; a row whose record left
  the system is kept for its own fields and named in `gone`. A record that does not fit the row kind
  becomes a problem row (`rows().problems`) and is named in `misfit`.
- A data source with `read_only: true` keeps its truth fields the system's: any write of one is refused.

| Refusal (`details[].code`) | When |
|---|---|
| `not_writable` | a changed field comes from a path that cannot go back (`external_id`) |
| `source_refused` | the system said no (its words follow) |
| `owned` | read-only, the driver is not `Mutable`, or this writer is not the system |
| `unlinked` | a list of links holds ids no row here resolves yet |

A write the system made but not all of answers `warnings: [{error_code: "source_partial", message,
key}]` — the row is saved; show the warning. Design rule: a field your users edit that the system must
also have is the system's field — add it there and mark it `truth`.

## Pull and move

| Action | Answers | Python / TypeScript |
|---|---|---|
| `POST dataset/<id>/pull` | `{moved, gone, num_rows}` — brought up to date now | `await ds.pull()` / `dataset.pull()` |
| `POST dataset/<id>/move-rows {"data_source"?, "path"?}` | `{from, to, rows}` | `dataset.moveRows({data_source, path})` |

`move-rows` copies every row into that data source (none: the project's data store), checks it holds
them all, then rewrites `dataset.json`. A row already there under the same key stays as it is there;
the old store keeps its rows. It is refused into a system of record (400 — the system makes its own
records) and while the source is not set up (503). The dataset editor shows where the rows are with a
Move… picker listing the sources whose driver `holds_rows`.

## Credentials

- **Drive**: the Google connection, with the drive write scope.
- **S3**: the `aws` credential — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
  `AWS_SESSION_TOKEN` for temporary keys (`flow credentials set`, or the environment).
- **Flowpad storage**: the hub sign-in.
- **A system of record**: what its driver's manifest names (`auth: {credential, vars}`).

## Script vs server

From a script (no running event loop) a sync call checks the data source, pulls and pushes by itself.
Inside the server a sync WRITE on a remote store raises — use the async API (`put`, `put_many`, `sync`)
or a row action; a sync read reads the working copy as last pulled. Only the server holds a record
driver, so a script's `Dataset.put` of a truth field is refused `owned`; send it with the row action
(`local_client.graph_post(f"dataset/{ds.id}/put-row", {...})`).

## What a record driver must know

- **A record's typed fields are part of change detection.** Fields that move on their own (a view
  count) go in the payload class's `volatile` set, or every sync reads as a change.
- **A record removed outside is noticed only when the driver lists everything**
  (`lists_everything = True`). An EMPTY listing is proof like any other, so an outage must RAISE —
  a driver that swallows errors and returns `[]` would mark every row gone.
- **A listing is one scan**; `page_size` and `pages_per_pass` match the provider's page and rate cap.
- **A write that takes several calls answers what it made**: the record, with
  `SourceItemSpec.warnings` for what was not set — never an exception after the record exists.
- Writing a driver: the `connect-data-source` skill, `author <system>`.
