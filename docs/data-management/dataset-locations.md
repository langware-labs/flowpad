---
id: 11d63dec-152a-43bf-836e-c28eea9ae57c
---
# Dataset locations — where a dataset's rows live

The app ships the SHAPE (kinds, rules, viewers) and the DRIVERS. The rows live wherever the person
puts them. One field in `dataset.json` says where: `location`. The spec is the module docstring of
`flow_sdk/datasets/locations.py`.

## The five forms

| `location` | Rows live in |
|---|---|
| `"local"` (default, or no field) | `<dataset>/rows/`. The first write adds `rows/` to the `.gitignore` beside it; rows git already tracks stay tracked |
| `"file:<folder>"` | `<folder>/rows/` on this machine (`file:~/data/leads`) |
| `"gdrive:<folder path>"` | a Google Drive folder (`gdrive:GTM/Rows/leads`) |
| `"s3:<bucket>/<prefix>"` | an S3 bucket, or an S3-compatible store (`s3:my-bucket/gtm/leads`) |
| `{"driver", "config", "map", "by"?, "read_only"?}` | a record system: one record per row (`{"driver": "twenty", "config": {"resource": "companies"}, "map": {"key": "external_id", "input": {...}}, "by": "crm"}`) |

`<driver>:<target>` works for any driver whose source is `RowFiles` (`flow_sdk/sources/protocols.py`);
Drive and S3 ship. A file location holds the rows as they are on disk — `rows/<key>/row.json` and the
slot files beside it. A bad `location` is refused with what is wrong (`ValueError`).

## The working copy

Rows are always read and written through a local folder: the dataset's own (`local`), the named one
(`file:`), or, for a remote location, a disposable working copy under the instance —
`<instance>/cache/rows/<dataset id>/`. It is never in a project and never a second truth.

Every async read and write, and every row action, runs in `Dataset.rows_session(write=...)`: a remote
location is pulled first, and a write's changes are pushed after. Rows on this machine skip both.

## File stores: commit point and conflicts

A row's `row.json` is its commit point. A push sends the slot files first and `row.json` last, as a
write conditioned on the version last seen. If someone else wrote the row since, the write is a
`Conflict` (`flow_sdk.sources.Conflict`) and a row action answers **409**; pull and try again. A row
folder without `row.json` (an interrupted write) is not read.

S3 conditions the write itself (ETag `If-Match` / `If-None-Match: *`). Drive has no conditional
write: the version is checked right before it, so a second writer inside that gap is not caught.

## Record systems

A record location is a driver whose source is `Mutable` and can list its records (Twenty, Jira).

- **`map`** turns a record into a row, in the path grammar: a path (`data.status`), a constant
  (`{"value": x}`), a nested object, a list (`data.labels.*.name`). `key` is the path of the record's
  id, and must also be mapped to a field (`crm_id`) — that is how a row finds its record again. A link
  is `{"link": <kind>, "by": <unique field of that kind>, "path": <path>}`; `"by": "key"` when the
  system holds the linked row's KEY. An id no row holds is left out and named in `unlinked`.
- **`by`** is who the rows are written as (default: the driver name). Every field the map names must
  be `owned_by` that `by` in the schema, or the pull is refused (`LinkError`, code `not_owned`): a
  field the app could also write would take an edit and lose it at the next pull. A field the map
  does not name is the app's own and is kept.
- **A pull re-mirrors every record** (`Dataset.mirror(items, map, by=...)`): new rows created,
  changed ones replaced, rows whose record is gone removed. A record that does not fit the row kind
  becomes a problem row (`rows().problems`) and is named in `misfit`; the others go through. A row
  gone outside that another row still links to is kept and named in `referenced`.
- **Write-through.** A write that changes a field the system owns goes to the system FIRST — an
  existing row through `update_item`, a new row through `create_item`, a delete through
  `delete_item` (`flow_sdk/datasets/projection.py` `write_through`). Only what changed goes out, in
  the system's own names (the map read backwards, so only `data.<name>` paths). The row is then
  written as the system answered; the app's own fields are written with it.
- **`read_only: true`** keeps the rows the system's: any write of an owned field is refused.

| Refusal (`details[].code`) | When |
|---|---|
| `not_writable` | a changed field comes from a path that cannot go back (`external_id`) |
| `source_refused` | the system said no (its words follow) |
| `owned` | read-only, the driver is not `Mutable`, or this writer is not the owner |
| `unlinked` | a list of links holds ids no row here resolves yet |

A write the system made but not all of answers `warnings: [{error_code: "source_partial", message,
key}]` — the row is saved; show the warning. Design rule: a field your users edit that the system must
also have is the system's field — add it there, to the map, and mark it `owned_by`.

## Pull and move

| Action | Answers | Python / TypeScript |
|---|---|---|
| `POST dataset/<id>/pull` | `{moved, num_rows}` — the working copy brought up to date now | `await ds.pull()` / `dataset.pull()` |
| `POST dataset/<id>/move-rows {"location"}` | `{from, to, rows}` | `dataset.moveRows(location)` |

`move-rows` copies every row, checks the new location holds them all, then rewrites `dataset.json`.
The old location keeps its rows. It is refused into a location that already holds rows, and into a
record system (the system makes its own records). TypeScript reads `Dataset.location` and
`locationLabel()`; the dataset editor shows "Stored in <location>" with a Move… picker listing the
drivers that can hold rows (`DataDriver.holds_rows`).

## Credentials

- **Drive**: the Google connection, with the drive write scope.
- **S3**: the `aws` credential — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
  `AWS_SESSION_TOKEN` for temporary keys (`flow credentials set`, or the environment).
- **A record system**: what its driver's manifest names (`auth: {credential, vars}`).

## Script vs server

From a script (no running event loop) a sync call pulls and pushes by itself. Inside the server a
sync WRITE on a remote location raises — use the async API (`put`, `put_many`, `sync`) or a row
action; a sync read reads the working copy as last pulled. Only the server holds a record driver, so
a script's `Dataset.put` of an owned field is refused `owned`; send it with the row action
(`local_client.graph_post(f"dataset/{ds.id}/put-row", {...})`).

## Rows are not the project's code

No dataset's rows are tracked by git: `git ls-files agentic-assets/dataset/*/rows` is empty.
`flow_sdk.datasets.locations.tracked_rows(project_root)` returns the tracked row paths.

## What a record driver must know

- **A record's typed fields are part of change detection.** Fields that move on their own (a view
  count) go in the payload class's `volatile` set, or every sync reads as a change.
- **A record removed outside is removed here only when the driver lists everything**
  (`lists_everything = True`). An EMPTY listing is proof like any other, so an outage must RAISE —
  a driver that swallows errors and returns `[]` would wipe its rows.
- **A listing is one scan**; `page_size` and `pages_per_pass` match the provider's page and rate cap.
- **A write that takes several calls answers what it made**: the record, with
  `SourceItemSpec.warnings` for what was not set — never an exception after the record exists.
- Writing a driver: the `connect-data-source` skill, `author <system>`.
