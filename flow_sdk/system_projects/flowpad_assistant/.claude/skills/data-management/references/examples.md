# Examples — complete files, as they sit on disk

All of these were applied and round-tripped in a probe. Copy the shape, not the names.

## A family of kinds: one grouping folder, nested schemas

```
agentic-assets/data_schema/
  crm/                                    the grouping folder
    data_schema.json                      {"type": "data_schema", "ns": "acme"}  ← no body
    description.md                        what the family is, one row per kind
    agentic-assets/data_schema/
      crm.lead/   data_schema.json + description.md
      crm.note/   data_schema.json + description.md
      crm.ref/    data_schema.json + description.md
```

- The folder name IS the kind, the full dot path — never relative to where it nests.
- A grouping folder needs its own body-less `data_schema.json`: the indexer only
  descends through folders that have one.
- **Every** `data_schema.json` declares `"ns"`. A nested schema finds the nearest
  folder holding `agentic-assets/` — the grouping folder, not the project — so
  relying on the project manifest's `ns` gets it refused.

## A record kind — `crm.lead/data_schema.json`

```json
{
  "type": "data_schema",
  "ns": "acme",
  "fields": {
    "name":        {"shape": "string", "description": "The person."},
    "status":      {"shape": "enum:new|engaged|won|lost", "description": "Where the lead is."},
    "referred_by": {"shape": "?crm.ref", "description": "Another lead who referred this one."},
    "notes":       {"shape": ["crm.note"], "description": "What happened, oldest first."},
    "counts":      {"shape": {"*": "int"}, "description": "Touches per channel."},
    "updated":     {"shape": "?string", "description": "Last change, YYYY-MM-DD."}
  }
}
```

`description.md` beside it says what a value IS, in a sentence or two — editors and
`dm_ctl kind` show it.

## A link to another row — `crm.ref/data_schema.json`

```json
{
  "type": "data_schema",
  "ns": "acme",
  "fields": {
    "type": {"shape": "enum:crm.lead|crm.company", "description": "The kind of the row pointed at."},
    "key":  {"shape": "string", "description": "The row's key in that kind's dataset."}
  }
}
```

The target type is an `enum:` IN THE SHAPE, so it is checked and an app reads it from
`kindForm` — never parse it out of a description sentence. Whether the key exists is
not checked by the SDK: the app (or the probe) checks it.

## A dataset of records — `agentic-assets/dataset/crm-leads/dataset.json`

```json
{
  "metadata": {
    "title": "CRM leads",
    "description": "Every lead, one row each; the row key is a short slug of the name.",
    "data_layout": "io_folder",
    "spec": {"examples": [{"input": "--acme--.crm.lead"}]}
  },
  "data": {}
}
```

- The kind is written in FULL here (`--acme--.`), unlike inside a schema.
- Records only need `input`. Add `"output"` (and gold labels) only for a dataset that
  scores a model — then see `connect-data-source define` for labelling.
- A dataset kind can be named instead of inlined: a schema folder with
  `"examples": {"input": "crm.lead", "output": "crm.score"}` registers one, and the
  manifest says `"spec": "--acme--.crm.dataset"`.

## A row, as the SDK writes it

```
examples/dana/                  ← the row's KEY
  example.json                  {"metadata": {"kind": "train"}, "data": {}}
  input/lead.json               the scalar fields
  input/notes/0001/note.json    a list of a kind: one folder per element
  input/notes/0002/note.json
```

You never write these files. `dm_ctl ds-append` / `ds-put` do, and `ds-rows` reads
them back with `key`, `id` and every slot's value.
