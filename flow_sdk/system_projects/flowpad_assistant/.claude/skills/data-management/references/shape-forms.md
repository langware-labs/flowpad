# Shape forms — the one grammar

A schema's fields, an agent's `input`/`output` and a dataset's slots are all written
in this grammar. It is the ONLY copy in the assistant's skills; the others link here.

| form | means |
| --- | --- |
| `"string"`, `"int"`, `"float"`, `"bool"`, `"binary"`, `"date"` | a reserved primitive (`date`: ISO `YYYY-MM-DD`, checked) |
| `"crm.lead"` | a value of a registered kind — or, in a field or a list, a REFERENCE to one row of it (below) |
| `"crm.company\|crm.lead"` | a reference to one row of any of these kinds |
| `{"name": "string", "age": "int"}` | an object — fields and their shapes (inline, no kind) |
| `["string"]`, `["crm.note"]` | a list — EXACTLY one element: the shape every element has |
| `"?string"`, `"?crm.company"` | may be absent |
| `"enum:new|won|lost"` | one of a closed set of strings (`"?enum:a|b"` — optional) |
| `{"*": "int"}` | a map — any key, every value that shape |

- No other keywords: no `required`, no `default`, no `type:` wrapper. Optional is `?`.
- `["int", "int"]` is an ERROR (a list carries one element shape).
- `?`, `enum:` and `{"*": …}` are input-side: a schema read back from code renders
  without them, a `data_schema` folder keeps what its author wrote.

## Kind names and namespaces

- Inside a `data_schema.json`, write sibling kinds BARE (`"crm.note"`): the loader
  qualifies them with the folder's `ns`.
- EVERYWHERE ELSE — `dataset.json` `spec`, `dm_ctl kind/check`, `kindForm`,
  `DataSpec.parse` — write the full name: `--<ns>--.crm.note`. A bare name of a
  project kind resolves to nothing (`dm_ctl kind crm.lead` → `form: null`).
- Kinds Flowpad ships have no namespace (`navigator.decision`).

## The silent `Any` — the trap behind most "it validated" lies

`DataSpec.parse("a.name.nobody.registered")` returns `Any`, with no error. A field
or slot typed `Any` accepts anything, so a misspelled kind "validates" everything.
Defences, all used by the probe:

- `dm_ctl check <kind> <value>` / `POST /api/v1/kinds/<kind>/check` answer **404** for
  an unknown kind — never "fits";
- `flow schema apply` refuses a schema whose field names a kind nobody defines;
- a dataset whose row kind is not registered refuses its rows with
  `names a kind nobody registered` (older builds: `no authoring form for typing.Any`,
  or a wall of `FolderSpec` / `TextSpec` errors — same cause).

## Links between rows — `<kind>.id.<uuid>`

A kind is a unique name; ONE instance of it is `<full kind>.id.<uuid>`. A dataset row is an instance:
its id is stored in the row (survives a rename and a re-clone) and every read hands out its `ref`.

```json
"company": {"shape": "?crm.company"}            // in crm.lead's schema
"past":    {"shape": ["crm.company"]}
```
```json
"company": "--acme--.crm.company.id.3f6c0d4e-…"   // in a lead row: row.ref of that company
"past":    ["--acme--.crm.company.id.a91e…"]
```

- The target is the field's own kind — no ref kind, no target in prose.
- What the field holds decides it: a STRING `<kind>.id.<uuid>` is a link; an OBJECT is a value
  copied in. A value of a ROW kind (one a dataset beside holds) is refused — link to the row.
  A kind no dataset holds (`crm.note`, an item) is fine inline: that is a value, not a row.
- `check` / `append` / `put` refuse a reference that names nothing: no row of its kind in the
  datasets beside it (`input.company: no --acme--.crm.company row <uuid>`), or — for a kind no
  dataset there holds — no value in a value store (`flow_sdk.values`). `delete_row` refuses while a
  row still references it (`used by --acme--.crm.lead dana`). Re-point or delete that row first.
- **Never link a dataset kept in git to rows kept OUT of git** (gitignored rows, e.g. real
  people): such rows get their ids on each machine, so on another clone the link names nothing.
  Keep the comment or the link on the out-of-git side — and expect it to break: a `git pull`
  can delete its target (the delete refusal only guards this checkout), so the out-of-git row
  then reads as a problem (`no <kind> row <uuid>`); readers report it and re-point it.
- A list of references is written inline in the row's document; a list of values one folder per element.
- A map's values (`{"*": "crm.company"}`) are VALUES, never references — a reference there is
  refused. To link several rows, use a list (`["crm.company"]`) or one field per link.
- `delete_row` counts every row beside it: each slot of the rows that read, and the input as
  stored of the rows that do not — a row broken today still protects what it points at.

## Rules across rows — `rules`

A record may declare that two link paths name the same row wherever both ends are set:

```json
"rules": [
  {"same": ["persona.icp", "icp"], "description": "the persona is one of the deal's ICP"},
  {"same": ["use_case.persona.icp", "icp"]},
  {"same": ["messages.*.use_case.persona", "persona"]}
]
```

- A path walks link fields from the row; `*` follows every element of a list. A step that is
  empty (an unset `?` link) means the rule does not apply — declare every pair you mean,
  skipped levels included (`use_case.persona.icp` checks a deal whose persona is empty).
- `flow schema apply` refuses a path that walks no link, and two ends that can never be the
  same kind. `DM kind` / `kindForm` list a kind's `rules`.
- Flowpad checks the rules on `check` / `append` / `put` (`code: "rule"`, with the broken `rule`
  — both ends — in the detail; identify a broken rule by `detail["rule"]`, never by its `path`:
  several rules may share a left path), reports rows that
  break them in `problems`, and refuses a write to a row that would break a rule of a row that
  reaches it (`would break <kind> <key>`) — so every writer keeps them, Claude included.

## Checking one value

A kind check is the SHAPE only, unless you give it the project: then it checks the value's
references and its kind's rules too — what a row write checks. A row is checked with `ds-check`.

- Over HTTP (any caller): `dm_ctl check --acme--.crm.lead '{"name": "Dana", ...}' [--project <id>]`
  → `{"ok": false, "errors": ["status: Input should be 'new', 'won' or 'lost'"], "details": [{"path", "code", "message"}], "links_checked": false}`.
- From TypeScript: `checkKind(kind, value, {projectId})` → `{ok, errors, details, links_checked}` (a 404 throws).
- From Python, in a process that registered the kind:

```python
from pydantic import TypeAdapter
from flow_sdk.schema.data_spec import DataSpec

Lead = DataSpec.parse("--acme--.crm.lead")
TypeAdapter(Lead).validate_python(value)      # raises ValidationError when it does not fit (shape only)
```

With the project folder, `flow_sdk.server.routes.kinds.check_value_details(kind, value, root)` adds
the links and rules.

A standalone script sees only the kinds Flowpad ships. Register the project's first:
`from flow_sdk.schema.data_spec.declared import load_root; load_root(<project root>)`.
