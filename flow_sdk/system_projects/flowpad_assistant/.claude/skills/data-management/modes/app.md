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

## The calls

A static Flowpad-SDK app imports `/sdk/flowpad-sdk.js`:

| Need | TypeScript (`sdk.*`) | Python |
| --- | --- | --- |
| the dataset holding a kind | `Dataset.forKind(kind, projectId)` — at load, by kind (ids do not survive a clone; kinds do) | `Dataset.for_kind(kind, project_root)` (one folder: `Dataset.at(folder)`); `DM ds-find <kind>` |
| the kind a dataset's rows are | `ds.rowKind` (inline spec) | `ds.row_kind` |
| a kind's fields → build a form | `kindForm("--ns--.kind")` → `{fields: {name: {shape, description, required}}}`; an outage throws | `DataSpec.parse(kind).model_fields` |
| rows | `ds.rows()` → `{rows, problems}`; each row has `key`, `id`, `ref`, `version`, `input`; each problem `key`, `id`, `ref`, `errors`, `version` and the `input` as stored (unchecked) — show it, keep links to it, repair it with `put(key, …, {expected: problem.version})` | `ds.rows_and_problems()` → rows with `key`, `id`, `version` (`ds.ref_of(r.id)` for the ref) |
| SOME rows — the list behind a number, a search, a page | `ds.rows({match, order_by, limit, offset})` → `{rows, total, problems}`; `match` is `{op, operands}` (`$EQ $NE $GT $GE $LT $LE $IN $NIN $LIKE $IS_NULL $IS_NOT_NULL`, under `$AND` / `$OR`) or a plain `{path: value}` map; a field is a path into the row (`key`, `input.stage`, `input.stage_dates.won`), a date compares as its ISO string | `ds.query(match, order_by=, limit=, offset=)` → the same dict |
| a count — a dashboard number | `ds.count({match, group_by: [paths]})` → `{total, groups: [{by, count}]}` — the SAME `match` the list uses, so the number and its rows cannot disagree | `ds.count(match, group_by=[...])` |
| one row | `ds.example(key)` | `ds.example(key)` |
| check before saving | `ds.check({input})` → `{ok, errors}` (references included); a lone value: `checkKind(kind, value)` | `ds.check({...})` → a list of errors, `[]` when it fits |
| save | `ds.put(key, {input}, {expected: row.version})` → 409 when someone changed it | `await ds.put(key, {...}, expected=v)` |
| add | `ds.append([{key, input}])` | `await ds.append([...])` |
| rename / delete | `ds.rename(key, newKey, {expected: row.version})` (id and links stay) / `ds.deleteRow(key, {expected: row.version})` (409 while referenced or changed) | `ds.rename_row(key, new, expected=v)` / `ds.delete_row(key, expected=v)` |
| save MANY, as one step | `ds.putMany([{key, input}], {expected: {key: version}})` — one row that does not fit (400, `details` under `<key>.<path>`) or changed since (409) writes nothing | `await ds.put_many([...], expected={...})` |
| delete MANY, as one step | `ds.deleteRows(keys, {expected})` — all or none; rows deleted together do not hold each other back | `ds.delete_rows(keys, expected={...})` |
| mirror an outside system | `ds.sync(rows, {prune, match})` → `{created, updated, unchanged, deleted}` | `await ds.sync(rows, prune=True, match=None)` — what a sync script calls each run: unchanged rows are not rewritten, rows not listed are removed (only those `match` selects, when given) |
| hear that rows changed | `const off = ds.onRowsChanged(({op, keys, count}) => reload())` — one call per write, by this app, another, or a script; keys, never values | a script's writes tell the running Flowpad by themselves (`ds.announce(op, keys)` to say it by hand) |
| open an outside page (the record in the CRM) | `openExternal(url)` — http/https only; the host opens it in the person's browser | — |
| link to a row | put the target's `row.ref` (or `ds.refOf(id)`) in the field typed by its kind; a picker lists `rows()` of `Dataset.forKind(fieldKind)` | same |

A Python script outside the server calls `load_root(<project root>)` first
(`references/shape-forms.md`), or every project kind is `Any`. It runs on Flowpad's
interpreter, `$FLOWPAD_PYTHON` — a worker has it, and so does a trigger's `run_script`
(with `FLOW_INSTANCE`) — never a bare `python3` for a script that imports `flow_sdk` (a
standard-library-only helper may use it).

## What broke a real app — and the call that replaces it

GTM Studio built a CRM-like app on datasets before these calls existed. Each line is a
workaround it shipped; the SDK now does the right side — never reproduce the left:

| It did | Do instead |
| --- | --- |
| re-computed Flowpad's example id (`uuid5(DNS, "<dataset>:<folder>")`) in the browser | rows carry `key`, `id` and `ref`; address by `key`, link by `ref` |
| kept the folder name a second time as `example.json` `data.key` | `row.key` |
| wrote `input/<kind>.json` and `input/<field>/0001/<kind>.json` through the file API | `put` / `append` — the SDK owns the layout |
| validated the WHOLE dataset after writing, then wrote the old files back | `check` before; `put` validates and writes nothing when it fails |
| modelled links as `{type, key}` kinds and read the target out of a description with a regex | a field typed by the target kind holding `<kind>.id.<uuid>` |
| checked that a linked row exists, and refused deletes, on a polled cache | the SDK refuses a dangling reference and a referenced delete |
| sliced `--gtm_studio--.` off kind names | keep kinds whole; the link's target is the field's own (full) kind |
| scanned every dataset each load to find its own | `Dataset.forKind(kind, projectId)` |
| re-read a row before saving to detect a concurrent edit | `put(…, {expected: row.version})` |
| a `python3` CRM-sync script wrote `input/<kind>.json` and `example.json` itself | `load_root` + `Dataset.for_kind(kind, root)`, `check` then `put` / `delete_row`, on `$FLOWPAD_PYTHON` |
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
A problem's row is `id` / `ref` (`example_id` is the old name — do not use it). The shape grammar
is read with `enumValues(shape)`, `linkTargets(shape)`, `namedKind(shape)` and `unwrap(shape)` —
never split `enum:` or `|` yourself. `kindForm(kind).rules` lists the kind's rules across rows.

## Still missing — say so in the app and to the user

- **Nothing stops two runs of one script at once** (a trigger's run and a "Sync now"). A script
  that writes many rows takes its own lock for the whole run (`flow_sdk.instances.atomic.locked`
  on a gitignored file in the project), or two runs remove the same rows and overwrite each
  other's state.
- **Row events are a hint, not a log.** `onRowsChanged` is best effort: an event sent while the
  page was disconnected is not replayed, and a script that ran while Flowpad was stopped told
  nobody. Re-read on the event AND when the page regains focus; no timer is needed.
- **A query reads the rows from disk each time** (there is no index over row fields): fine for
  thousands of rows, not for millions. Ask for what the page shows (`match`, `limit`), never
  every row on a timer.
- **A rule across rows beyond "two links name the same row"** (a count, an order) is not in the
  schema: write it into the kinds' `description.md` and check it in every writer. "The same row"
  rules (a tag chain) go in the schema's `rules` — never in app code.
- **A field owned by an outside system** (a CRM's stage, an owner) has no mark in the schema:
  every Flowpad writer can change it, and the next sync puts the outside value back. Say in its
  `description` who owns it, keep it read-only in the app, and let only the sync write it.
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
