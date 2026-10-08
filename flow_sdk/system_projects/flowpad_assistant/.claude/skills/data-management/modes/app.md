# Mode: app — an app or a script over the user's kinds

> **Ground rules (inline by design):**
> **1. Prove it in a probe first** (`references/probe.md`) — nothing lands in the
> user's project until the same files passed there; report the exit codes and read-backs.
> **2. An unknown kind is silently `Any`** — send one deliberately bad value; it MUST be refused.
> **3. Address rows by key; never compute an id.**
> **4. Never write a dataset's files by hand** — `dm_ctl` / the SDK, or tell the user the SDK cannot.
> **5. Schemas apply live** with `flow schema apply`; never ask for a restart.
> **6. Never widen a wait, a timeout or a retry to make something pass.**

`DM` is the shell function `DM() { "$FLOWPAD_PYTHON" "<this skill>/scripts/dm_ctl.py" "$@"; }`.

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
| one row | `ds.example(key)` | `ds.example(key)` |
| check before saving | `ds.check({input})` → `{ok, errors}` (references included); a lone value: `checkKind(kind, value)` | `ds.check({...})` → a list of errors, `[]` when it fits |
| save | `ds.put(key, {input}, {expected: row.version})` → 409 when someone changed it | `await ds.put(key, {...}, expected=v)` |
| add | `ds.append([{key, input}])` | `await ds.append([...])` |
| rename / delete | `ds.rename(key, newKey, {expected: row.version})` (id and links stay) / `ds.deleteRow(key, {expected: row.version})` (409 while referenced or changed) | `ds.rename_row(key, new, expected=v)` / `ds.delete_row(key, expected=v)` |
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

## Still missing — say so in the app and to the user

- **Nothing stops two runs of one script at once** (a trigger's run and a "Sync now"). A script
  that writes many rows takes its own lock for the whole run (`flow_sdk.instances.atomic.locked`
  on a gitignored file in the project), or two runs remove the same rows and overwrite each
  other's state.
- **No change events for rows.** Re-read on focus and on a modest timer while the page
  is visible, and say it is polling. Never shorten the timer to hide staleness.
- **A cross-row rule is not in the schema.** Write it into the kinds' `description.md` (so
  `DM kind` shows it to every writer, Claude included) and check it in every writer.
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
