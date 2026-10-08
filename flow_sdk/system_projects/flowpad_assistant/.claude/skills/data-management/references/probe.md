# The probe — prove it before it lands

A probe is a throwaway project in `$TMPDIR/dm-probe-<id>/` with its own namespace
`dmprobe<id>`, so nothing it registers can collide with the user's kinds. It is not
in the project picker, and `probe-drop` removes every trace.

`DM` below is the shell function `DM() { "$FLOWPAD_PYTHON" "<this skill>/scripts/dm_ctl.py" "$@"; }`.

## 1. Make it

```bash
DM probe-new
# {"ok": true, "project_id": "…", "root": "/…/T/dm-probe-1a2b3c4d", "ns": "dmprobe1a2b3c4d", "schemas": "…", "datasets": "…"}
```

Keep `project_id`, `root` and `ns` for the rest of the run.

## 2. Put the SAME files in it

Write the schemas and datasets where they will finally live (or in a scratch folder),
then copy them in:

```bash
DM probe-copy "<root>" "<path>/agentic-assets/data_schema/crm" "<path>/agentic-assets/dataset/crm-leads"
```

Every `"ns"` becomes the probe's and every `--<old ns>--.` prefix follows
(`renamed_namespaces`, `files_rewritten`). `--no-rows` copies a dataset without its
rows (e.g. rows with real people's details you do not need for the check).

## 3. Apply and read back

```bash
flow schema apply "<root>/agentic-assets/data_schema"     # exit 0; every schemas[].status == "ok"
DM kind "--<ns>--.crm.lead"                               # the fields, shapes, required flags you meant
DM check "--<ns>--.crm.lead" '<a real value>'             # ok: true
DM check "--<ns>--.crm.lead" '<the same value, one field wrong>'   # ok: false, naming that field
```

`flow schema apply` exit 6 lists each failing folder's `error` — fix and apply again.
`already defined by <path>` means two folders define one kind: keep one.

## 4. Rows, the way the real caller will do them

```bash
flow record index "<root>/agentic-assets/dataset/crm-leads" --types dataset
DM ds-append "<dataset folder>" '[{"key": "dana", "input": {…}}]'
DM ds-put    "<dataset folder>" dana '{"input": {…changed…}}'
DM ds-check  "<dataset folder>" '{"input": {…one field wrong…}}'   # ok: false
DM ds-rows   "<dataset folder>"                                     # key + values, as written
DM ds-validate "<dataset folder>"                                   # problems: []
```

A Python caller is proven with a snippet run by `flow snippet run <file>` — a
standalone process, so it registers the probe's kinds itself:

```python
from pathlib import Path
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.schema.data_spec.declared import load_root

ROOT = Path("<root>")
assert not any(load_root(ROOT).values())          # {folder: error} — all empty
leads = Dataset.at(ROOT / "agentic-assets/dataset/crm-leads")
await leads.put("dana", {"input": {...}})
print([(r.key, r.input.name) for r in leads.read_rows()])
```

## 5. Drop it — always

```bash
DM probe-drop "<project_id>"
# {"ok": true, "deleted_children": 5, "row_gone": true, "folder_gone": true, "rows_swept_after": []}
```

Run it even when an earlier step failed. It refuses any project that is not a probe.
A non-empty `rows_swept_after` means the project delete missed rows and the probe
removed them — mention it in your report.

## What a failure means

| You see | It means | Do |
| --- | --- | --- |
| `kind` → `form: null` or 404 | the name is bare or misspelled, or not applied | use `--<ns>--.<kind>`; apply again |
| `check` → `ok: true` for a value you broke | you are checking the wrong kind | the probe FAILED — find the kind that is really used |
| `names a kind nobody registered` / `no authoring form for typing.Any` / `FolderSpec`…`TextSpec` errors | the dataset's row kind is not registered in that process | `flow schema apply` (server) or `load_root` (script) |
| after a Flowpad restart, a probe kind 404s | probes live in `$TMPDIR`, which the boot scan skips | `flow schema apply` the probe again |
| `HTTP 400: a row does not match` with `data.errors` | a real shape error | read `loc` / `msg`; fix the value or the schema |
| `row keys already taken` | append refuses existing keys | `ds-put` to replace, or another key |
