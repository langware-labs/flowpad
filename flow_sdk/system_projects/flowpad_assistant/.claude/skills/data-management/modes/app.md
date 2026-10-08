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
| the dataset holding a kind | `Dataset.query(new QueryRequest({type: "dataset"}), true)`, match `specKind` / `spec.examples[0].input` — once, at load | `DM ds-find` |
| a kind's fields → build a form | `kindForm("--ns--.kind")` → `{fields: {name: {shape, description, required}}}` | `DataSpec.parse(kind).model_fields` |
| rows | `ds.rows()` → each row's `key`, `id`, `input` | `Dataset.at(folder).read_rows()` |
| one row | `ds.example(key)` | `ds.example(key)` |
| check before saving | `ds.check({input})` → `{ok, errors}`; a lone value: `checkKind(kind, value)` | `ds.check({...})` |
| save | `ds.put(key, {input})` | `await ds.put(key, {...})` |
| add | `ds.append([{key, input}])` | `await ds.append([...])` |
| rename / delete | `ds.rename(key, newKey)` / `ds.deleteRow(key)` | `ds.rename_row` / `ds.delete_row` |

A Python script outside the server calls `load_root(<project root>)` first
(`references/shape-forms.md`), or every project kind is `Any`. It runs on Flowpad's
interpreter, `$FLOWPAD_PYTHON` — a worker has it, and so does a trigger's `run_script`
(with `FLOW_INSTANCE`) — never a bare `python3`, which has no `flow_sdk`.

## What broke a real app — and the call that replaces it

GTM Studio built a CRM-like app on datasets before these calls existed. Each line is
a workaround it shipped; never reproduce one:

| It did | Do instead |
| --- | --- |
| re-computed Flowpad's example id (`uuid5(DNS, "<dataset>:<folder>")`) in the browser | rows carry `key` and `id`; address by `key` |
| kept the folder name a second time as `example.json` `data.key` | `row.key` |
| wrote `input/<kind>.json` and `input/<field>/0001/<kind>.json` through the file API | `put` / `append` — the SDK owns the layout |
| validated the WHOLE dataset after writing, then wrote the old files back | `check` before, `put` validates and writes nothing when it fails |
| read a link's target type out of a description ("… a gtm.ref to a gtm.icp row") with a regex | the target type is an `enum:` in the ref kind; read it from `kindForm` |
| sliced `--gtm_studio--.` off kind names | keep kinds whole; compare full names |
| scanned every dataset each load to find its own | find once by kind, keep the id |
| a `python3` CRM-sync script wrote `input/<kind>.json` and `example.json` itself | `load_root` + `Dataset.at(folder)`, `check` then `put` / `delete_row`, on `$FLOWPAD_PYTHON` |
| deleted a row only after checking every other row by hand | still the app's job (no reference integrity in the SDK) — but do it on `key`s from `rows()` |

## Still missing — say so in the app and to the user

- **No change events for rows.** Re-read on focus and on a modest timer while the page
  is visible, and say it is polling. Never shorten the timer to hide staleness.
- **No reference integrity.** Check that a ref's `key` exists before saving; refuse
  a delete while another row points at it.
- **No concurrency control.** Read the row right before `put`; if it changed since
  the form opened, stop and ask the user to reload.

## Probe

Run the app's data calls against a probe dataset before the real one: from Python,
a `flow snippet run` script; for TypeScript, the same calls over `DM` (`ds-put`,
`ds-check`, `ds-rows` hit the routes the TS client uses). Include one save that must
be refused. `probe-drop`.
