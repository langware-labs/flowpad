# Examples — complete files, as they sit on disk

All of these were applied and round-tripped in a probe. Copy the shape, not the names.

## A family of kinds: one grouping folder, nested schemas

```
agentic-assets/data_schema/
  crm/                                    the grouping folder
    data_schema.json                      {"type": "data_schema", "ns": "acme"}  ← no body
    description.md                        what the family is, one row per kind
    agentic-assets/data_schema/
      crm.company/ data_schema.json + description.md
      crm.lead/    data_schema.json + description.md
      crm.note/    data_schema.json + description.md
```

- The folder name IS the kind, the full dot path — never relative to where it nests.
- A grouping folder needs its own body-less `data_schema.json`: the indexer only
  descends through folders that have one.
- The grouping folder declares `"ns"` once; the schemas nested in it inherit it. A schema
  outside any grouping folder declares its own (or the project manifest's `ns` applies).

## A record kind — `crm.lead/data_schema.json`

```json
{
  "type": "data_schema",
  "fields": {
    "name":        {"shape": "string", "description": "The person."},
    "status":      {"shape": "enum:new|engaged|won|lost", "description": "Where the lead is."},
    "company":     {"shape": "?crm.company", "description": "Where they work (a link to a company row)."},
    "referred_by": {"shape": "?crm.company|crm.lead", "description": "Who referred them: a company or another lead."},
    "notes":       {"shape": ["crm.note"], "description": "What happened, oldest first (values, not links)."},
    "counts":      {"shape": {"*": "int"}, "description": "Touches per channel."},
    "updated":     {"shape": "?date", "description": "Last change."}
  }
}
```

`description.md` beside it says what a value IS, in a sentence or two — editors and
`dm_ctl kind` show it.

## A link to another row

`company` above is typed by the kind it points at. In a lead row it holds that company row's
reference — the `ref` every read hands out (`<full kind>.id.<uuid>`):

```json
{"name": "Dana", "status": "engaged", "company": "--acme--.crm.company.id.3f6c0d4e-8a1b-4c2d-9e3f-5a6b7c8d9e0f"}
```

The SDK checks it on every write (a missing company row is refused) and refuses deleting the
company while Dana still points at it. Renaming the company row keeps its id, so the link holds.

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
  example.json                  {"metadata": {"id": "<the row's id>", "kind": "train"}, "data": {}}
  input/lead.json               the scalar fields
  input/notes/0001/note.json    a list of a kind: one folder per element
  input/notes/0002/note.json
```

You never write these files. `dm_ctl ds-append` / `ds-put` do, and `ds-rows` reads
them back with `key`, `id`, `ref`, `version` and every slot's value.
