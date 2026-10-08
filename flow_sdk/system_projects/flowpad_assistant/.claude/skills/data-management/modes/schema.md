# Mode: schema — define, change or link kinds

> **Ground rules (inline by design):**
> **1. Prove it in a probe first** (`references/probe.md`) — nothing lands in the
> user's project until the same files passed there; report the exit codes and read-backs.
> **2. An unknown kind is silently `Any`** — send one deliberately bad value; it MUST be refused.
> **3. Address rows by key; never compute an id.**
> **4. Never write a dataset's files by hand** — `dm_ctl` / the SDK, or tell the user the SDK cannot.
> **5. Schemas apply live** with `flow schema apply`; never ask for a restart.
> **6. Never widen a wait, a timeout or a retry to make something pass.**

`DM` is the shell function `DM() { "$FLOWPAD_PYTHON" "<this skill>/scripts/dm_ctl.py" "$@"; }`. The grammar is
`references/shape-forms.md`; complete files are in `references/examples.md`.

## Gate 1 — the shape is the user's

Ask what one value looks like, with a real example from them. Propose the kinds —
names, fields, which are optional, which are closed sets, which point at other rows —
in a short table, and let them edit it. Do not add fields they did not ask for.

- One kind per thing the user names (a lead, a company, a note). A field that is a
  list of things with their own fields is a list of a kind (`["crm.note"]`), not a
  list of strings with a format.
- A link to another row is a ref kind (`{type: enum:…, key: string}`, see examples).
- A closed set is `enum:`; a format (a date, a URL) is `string` plus its description.
- Name the namespace. The project is your working directory; its `ns` is in
  `agentic-assets/project_manifest/project_manifest.json`. No manifest yet: write
  `{"schema": 1, "requires": {}, "ns": "<project_slug>", "entries": []}` there (the slug in
  `a-z 0-9 _`). Never look the project up in Flowpad's database.

**Passes when** the user confirmed the table.

## Gate 2 — write the folders

Where: `<project>/agentic-assets/data_schema/`. Several related kinds go under one
grouping folder (its own body-less `data_schema.json` with `type` and `ns`). Every
`data_schema.json` carries `"type": "data_schema"` and `"ns"`; every folder has a
`description.md` saying what a value is. Inside a schema, sibling kinds are bare.

Changing a schema that already holds data: say which existing values stop fitting
(a new required field, a narrowed enum) BEFORE writing. Adding an optional field is
safe; a new required one needs every row to get it.

**Passes when** the files exist; nothing is applied yet.

## Gate 3 — probe

`references/probe.md` steps 1–3 and 5: `probe-new`, `probe-copy` the schema folders
(and, for a change, the datasets that hold this kind), `flow schema apply` exit 0,
`DM kind` shows each field as meant, `DM check` accepts a real value and refuses a
broken one. For a change, `DM ds-validate` each copied dataset: `problems: []`, or
the user agreed what to fix. `probe-drop`.

**Passes when** all of that held and the probe is dropped.

## Gate 4 — apply for real and read back

```bash
flow schema apply "<project>/agentic-assets/data_schema/<folder>"
DM kind "--<ns>--.<kind>"
```

Then `DM ds-find "--<ns>--.<kind>"` and `ds-validate` each dataset that holds it.

**Passes when** apply exited 0 and the read-back matches the probe.

## Removing or renaming a kind

The folder name IS the kind. Renaming means: rename the folder, update every
reference (`?old.name` in other schemas, `dataset.json` specs, ref enums), apply the
tree. Find the users first: `grep -r "old.name" <project>/agentic-assets` and
`DM ds-find "--<ns>--.old.name"`. Probe the renamed tree before touching the real one.
