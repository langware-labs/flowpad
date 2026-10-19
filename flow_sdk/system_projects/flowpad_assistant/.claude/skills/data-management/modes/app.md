---
id: 7259220e-7660-4b62-93aa-ab747453d3aa
---
# Mode: app — an app or a script over the user's kinds

> **Ground rules (inline by design):**
> **1. Prove it in a probe first** (`references/probe.md`) — nothing lands in the
> user's project until the same files passed there; report the exit codes and read-backs.
> **2. An unknown kind is silently `Any`** — send one deliberately bad value; it MUST be refused.
> **3. Address rows by key; never compute an id.**
> **4. Never write a dataset's files by hand** — `dm_ctl` / the SDK, or tell the user the SDK cannot.
> **5. Schemas apply live** with `flow schema apply`; never ask for a restart.
> **6. Never widen a wait, a timeout or a retry to make something pass.**

`DM` is the shell function `DM() { "${FLOWPAD_PYTHON:-$(flow instance python)}" "<this skill>/scripts/dm_ctl.py" "$@"; }`.

Building the app itself (scaffold, page, styles) is `web-app-builder` / `html-builder`;
this mode is its data layer. The schemas and datasets come from `modes/schema.md` and
`modes/dataset.md` first.


## FlowCall integration

ComputeOp input/output use this same ShapeForm grammar; registered kinds must resolve before execution. A list is one value, not an implicit dataset write or item loop. Named list entries may be ValueRefs; resolution is explicit. Follow the [FlowCall block recipe](../../../../docs/Getting%20Started/FlowCall.md) for call.py, typed results and chaining, while preserving dataset ownership, write and reference rules here.

## The calls

A static Flowpad-SDK app imports `/sdk/flowpad-sdk.js`:

| Need | TypeScript (`sdk.*`) | Python |
| --- | --- | --- |
| the dataset holding a kind | `Dataset.forKind(kind, projectId)` — at load, by kind (ids do not survive a clone; kinds do) | `Dataset.for_kind(kind, project_root)` (one folder: `Dataset.at(folder)`); `DM ds-find <kind>` |
| the kind a dataset's rows are | `ds.rowKind` (inline spec) | `ds.row_kind` |
| a kind's fields → build a form | `kindForm("--ns--.kind")` → `{fields: {name: {shape, description, required}}}`; an outage throws | `DataSpec.parse(kind).model_fields` |
| rows | `ds.query()` → `{rows, problems}`; each row has `key`, `id`, `ref`, `version`, `input`; each problem `key`, `id`, `ref`, `errors`, `version` and the `input` as stored (unchecked) — show it, keep links to it, repair it with `put(key, …, {expected: problem.version})` | `ds.rows_and_problems()` → rows with `key`, `id`, `version` (`ds.ref_of(r.id)` for the ref) |
| SOME rows — the list behind a number, a search, a page | `ds.query({match, q, order_by, limit, offset, expand})` → `{rows, total, problems, linked?}`; `match` is `{op, operands}` (`$EQ $NE $GT $GE $LT $LE $IN $NIN $LIKE $IS_NULL $IS_NOT_NULL`, under `$AND` / `$OR`) or a plain `{path: value}` map; a date compares as its ISO string | `ds.query(match, q=, order_by=, limit=, offset=, expand=)` → the same dict |
| a path — in `match`, `order_by`, `group_by`, `expand` | ONE grammar, a rule path with the slot written: `key`, `input.stage`, `input.stage_dates.won`, `input.tags.*` (any element), and **a path follows a link**: `input.persona.icp.key` ("deals of this ICP"), `input.company.name` — no join, no second call | same |
| the linked rows a page shows (names, not references) | `ds.query({expand: ["input.persona"]})` → `linked[row.input.persona].row.input.name` — one call, never one `findRow` per link | `ds.query(expand=[...])["linked"]` |
| a count — a dashboard number | `ds.count({match, q, group_by, metrics, order_by, week_start})` → `{total, groups: [{by, count, metrics?}], metrics?}` — the SAME `match` the list uses, so the number and its rows cannot disagree | `ds.count(match, group_by=[...], metrics={...})` |
| per week / month / quarter | `group_by: ["week:input.day"]` (also `day:` `month:` `quarter:`), keyed `2026-09-13` (the week's first day), `2026-09`, `2026-Q3`; `week_start: "sunday"` when your week begins there; `order_by: {"week:input.day": "asc"}` for a series; `bucketOf(day, "week", "sunday")` gives a period's key | same names |
| people, not rows — first / last / total | `metrics: {people: "distinct:input.email", first: "min:input.day", total: "sum:input.amount"}` (`distinct` · `min` · `max` · `sum`) | same |
| text anywhere in a row | `ds.query({q: "pricing objection"})` (every word, list items included); `$LIKE` on a list field = some element contains it | `ds.query(q=...)` |
| a join on a value that is not a link ("people who replied AND have a meeting") | a sub-query in `$IN` / `$NIN`: `{op: "$IN", operands: ["input.email", {op: "$PROP", operands: ["input.email", {"input.metric": "em_reply"}]}]}` — a third operand names another kind's rows; one call | same |
| who links to a row — and rows nothing links to | `ds.usedBy(keys?)` → `{key: [{dataset_id, kind, key}]}` (`[]` = unused); what a delete is refused for, asked first | `ds.used_by(keys=None)` |
| records (a task, a session, an ingested email) — not rows | `searchRecords(q, {record_type, limit})`; `SourceItem.query(new QueryRequest({type: "source_item", query: new QueryFilter({match: {data_source_id}, limit: 50})}))` — paging goes in `query`, a stray top-level key is refused | a script: `flow_sdk.local_client.graph_get("source_item", {"match": {...}, "limit": 50})`, `.search(q)` |
| link a row to a record | a field shaped `?ingest.source_item` holds `ingest.source_item.id.<item id>`; `expand` returns it as `linked[ref] = {type, id, record}` (over REST). Keep the provider's `external_id` too — record ids are per machine | same |
| one row | `ds.row(key)` | `ds.row(key)` |
| check before saving | `ds.check({input})` → `{ok, errors, details}` (references included); a lone value: `checkKind(kind, value)` | `ds.check_row({...})` → the same `{ok, errors, details}` (`ds.check` → its lines, `[]` when it fits) |
| save | `ds.put(key, {input}, {expected: row.version})` → 409 when someone changed it | `await ds.put(key, {...}, expected=v)` |
| add | `ds.append([{key, input}])` | `await ds.append([...])` |
| rename / delete | `ds.rename(key, newKey, {expected: row.version})` (id and links stay) / `ds.deleteRow(key, {expected: row.version})` (409 while referenced or changed) | `ds.rename_row(key, new, expected=v)` / `ds.delete_row(key, expected=v)` |
| save MANY, as one step | `ds.putMany([{key, input}], {expected: {key: version}})` — one row that does not fit (400, `details` under `<key>.<path>`) or changed since (409) writes nothing | `await ds.put_many([...], expected={...})` |
| delete MANY, as one step | `ds.deleteRows(keys, {expected})` — all or none; rows deleted together do not hold each other back | `ds.delete_rows(keys, expected={...})` |
| mirror an outside system — THE way | no code: a data source with `"mirror": {dataset, by, map}` in its `data_source.json` (`references/mirroring.md` — read it before writing anything that touches a mirrored row); after every sync the dataset is the mirror, the app's writes to `owned_by` fields go to the system first, and a failure shows on the source card (`mirror_failed` / `mirror_misfit`) — show it in the app too (`DataSource.isMirrorBroken`). A record that does not fit the kind is a `problems` row, not a stopped sync | the same file; a driver for the system when none is installed: `connect-data-source author <system>` |
| load rows you computed yourself (joined from two streams, a one-off import) | `ds.sync(rows, {prune, match})` → `{created, updated, unchanged, deleted}` — all or nothing | `await ds.sync(rows, prune=True, match=None)` in a script wrapped in `single_run(...)`: unchanged rows are not rewritten, rows not listed are removed (only those `match` selects, when given). A script that only reshapes a source's items is the declared `mirror`, not this |
| mirror a source's items by hand (a test, a one-off) | `ds.mirror(sourceId, {key: "external_id", input: {name: "name", stage: "data.stage"}})` → `{created, updated, unchanged, deleted, misfit?, unlinked?}` | `await ds.mirror(source, map, by="crm")` — what the declared mirror calls for you |
| a field your users edit that the outside system must ALSO have | make it the system's: add it to the mirror `map` and mark it `owned_by`; then `ds.put(key, {input}, {expected})` as for any row — Flowpad sends the change to the system first and answers `warnings` when a part was not set (show them). Never `updateItem` from your own code, a client, a state file or a merge | a script is not served: `local_client.graph_post(f"dataset/{ds.id}/put-row", {"key": k, "row": {"input": {...}}, "expected": v})`; `Dataset.put` there is refused `owned` |
| a rule that runs a script when rows change | `trigger.json`: `"tag": {"on": "dataset.rows.changed", "scope": ["kind:<full kind>"]}`, `"then": {"run_script": "agentic-assets/trigger/<name>/run.sh"}`, and `"runs_on"` when only one machine should run it. "Run now": `const started = await Trigger.runOnce(id)`, then `Trigger.run(started.run_id)` until it is not `running` | the script: `single_run` around the run, `$FLOWPAD_PYTHON`, exit non-zero on failure (a failed step is a failed run) |
| one run of a script at a time (a trigger's run and a "Sync now") | — (a script's concern) | `with single_run(project_root, "crm-sync"):` around the WHOLE run (`flow_sdk.datasets.run`) — a second run waits, or `wait=False` raises `RunBusy`; never a lock file of your own |
| hear that rows changed | `const off = ds.onRowsChanged(({op, keys, count}) => reload())` — one call per write, by this app, another, or a script; keys, never values | a script's writes tell the running Flowpad by themselves (`ds.announce(op, keys)` to say it by hand) |
| open an outside page (the record in the CRM) | `openExternal(url)` — http/https only; the host opens it in the person's browser | — |
| link to a row | put the target's `row.ref` (or `ds.refOf(id)`) in the field typed by its kind; a picker lists `rows()` of `Dataset.forKind(fieldKind)` | same |

A Python script outside the server calls `load_root(<project root>)` first
(`references/shape-forms.md`), or every project kind is `Any`. It runs on Flowpad's
interpreter, `$FLOWPAD_PYTHON` — a worker has it, and so does a trigger's `run_script`
(with `FLOW_INSTANCE`) — never a bare `python3` for a script that imports `flow_sdk` (a
standard-library-only helper may use it).

## What broke a real app — and the call that replaces it

One project built a CRM-like app on datasets before these calls existed. Each line is a
workaround it shipped; the SDK now does the right side — never reproduce the left:

| It did | Do instead |
| --- | --- |
| re-computed Flowpad's row id (`uuid5(DNS, "<dataset>:<folder>")`) in the browser | rows carry `key`, `id` and `ref`; address by `key`, link by `ref` |
| kept the folder name a second time as `row.json` `data.key` | `row.key` |
| wrote `input/<kind>.json` and `input/<field>/0001/<kind>.json` through the file API | `put` / `append` — the SDK owns the layout |
| validated the WHOLE dataset after writing, then wrote the old files back | `check` before; `put` validates and writes nothing when it fails |
| modelled links as `{type, key}` kinds and read the target out of a description with a regex | a field typed by the target kind holding `<kind>.id.<uuid>` |
| checked that a linked row exists, and refused deletes, on a polled cache | the SDK refuses a dangling reference and a referenced delete |
| sliced `--sales_desk--.` off kind names | keep kinds whole; the link's target is the field's own (full) kind |
| scanned every dataset each load to find its own | `Dataset.forKind(kind, projectId)` |
| re-read a row before saving to detect a concurrent edit | `put(…, {expected: row.version})` |
| a `python3` CRM-sync script wrote `input/<kind>.json` and `row.json` itself | `load_root` + `Dataset.for_kind(kind, root)`, `check` then `put` / `delete_row`, on `$FLOWPAD_PYTHON` |
| read linked datasets with `read_rows()` (one bad row stopped the whole sync) and looked rows up only among the rows that read (a broken row's record was then created a second time) | `rows_and_problems()` everywhere; find a record by its natural key in rows AND in `problems[].input`, and repair a broken one with `put(key, …, expected=problem["version"])` |

A page may keep its own link model (`{type, key}`, easy to show and pick) as long as it converts
to and from references at ONE boundary — the function that reads rows and the one that writes
them — and stores only references. Helpers: `parseValueRef(ref)` → `{kind, id}`,
`Dataset.findRow(ref, projectId)` → `{dataset_id, key, row}` (Python `Dataset.find_row`),
`resolveKind("crm.lead", projectId)` → the full kind (Python `declared.kind_in`), and
`Dataset.forKind` takes a bare kind with a project. `checkKind(kind, value, {projectId})` checks
links and rules too; without `projectId` it is the SHAPE only. Refusals carry `details`
(`{path, code, message}`; `code` `shape:…`, `dangling_ref`, `inline_row`, `rule`, and on a 409
`conflict`, `gone` or `referenced`) — read those, never parse the `errors` lines or the message.
A problem's row is `id` / `ref` (`row_id` is the old name — do not use it). The shape grammar
is read with `enumValues(shape)`, `linkTargets(shape)`, `namedKind(shape)` and `unwrap(shape)` —
never split `enum:` or `|` yourself. `kindForm(kind).rules` lists the kind's rules across rows.

## Still missing — say so in the app and to the user

- **Row events name keys, not values.** `onRowsChanged` says which rows moved; re-read what the
  page shows. The event is enough — no timer, no re-read on focus: a write made while the socket was
  down (a script, Flowpad restarted) is told on reconnect as one `{op: "sync", keys: []}` when the
  rows' `version` moved past what the listener heard or the instance read.
- **A parked tab is a hidden page.** The host keeps an app's frame mounted when its tab is not the
  one shown and makes its `document.hidden` true (a `visibilitychange` fires on each flip). Code that
  rests while hidden rests when parked — never poll, and never work "while the window is visible".
- **A query reads the rows from disk each time** (there is no index over row fields), and each
  dataset a link path leads into once more: fine for thousands of rows, not for millions. Ask for
  what the page shows (`match`, `limit`), never every row on a timer.
- **No row history.** A date you will ask about is a field (`stage_dates`, `owned_by` its source);
  a write log would miss every writer that bypasses the SDK. A dataset in git has its commits.
- **A link to a record is not checked on a write from disk** (records live in the instance's
  store), and a path continues into a record only where they can be read: over REST always; in a
  script, hand `rows` / `count` the records you fetched (`records={ref: record}`).
- **A rule across rows that counts, orders or sums** is not in the schema: write it into the
  kinds' `description.md` and check it in every writer. "The same row" (a tag chain) and "no two
  rows share this value" (`unique`: a natural key) ARE schema `rules` — never app code.
- **`owned_by` is a guard, not a permission.** A field the schema marks as an outside system's is
  refused to every writer that does not say `by: "<owner>"`, so the app and Claude cannot change
  it by mistake — but a writer that claims `by` is believed. Show such a field read-only
  (`kindForm(kind).fields[name].owned_by`) unless the source can write it — then edit it as any
  field (it goes to the system first). Send `by` only from the writer that IS the owner: the
  mirror, or the one script that computes a field it owns (`"owned_by": "board"`, `by="board"`).
- **The delete protection is per checkout.** A row kept out of git that links to a row in git
  can lose its target to a `git pull` (a teammate deleted it): that row then shows in
  `problems` (`no <kind> row <uuid>`) — every reader must keep going and report it.
- **A row of a dataset in ANOTHER project is not a link target.** Links resolve among the
  datasets beside each other (`<owner>/agentic-assets/dataset/*`).

## Probe

Run the app's data calls against a probe dataset before the real one: from Python,
a `flow snippet run` script; for TypeScript, the same calls over `DM` (`ds-put`,
`ds-check`, `ds-rows` hit the routes the TS client uses). Include one save that must
be refused. `probe-drop`.
