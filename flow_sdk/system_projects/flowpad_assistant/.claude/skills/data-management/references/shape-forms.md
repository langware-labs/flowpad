# Shape forms — the one grammar

A schema's fields, an agent's `input`/`output` and a dataset's slots are all written
in this grammar. It is the ONLY copy in the assistant's skills; the others link here.

| form | means |
| --- | --- |
| `"string"`, `"int"`, `"float"`, `"bool"`, `"binary"` | a reserved primitive |
| `"crm.lead"` | a value of a registered kind, by name |
| `{"name": "string", "age": "int"}` | an object — fields and their shapes (inline, no kind) |
| `["string"]`, `["crm.note"]` | a list — EXACTLY one element: the shape every element has |
| `"?string"`, `"?crm.ref"` | may be absent |
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

## Checking one value

- Over HTTP (any caller): `dm_ctl check --acme--.crm.lead '{"name": "Dana", ...}'`
  → `{"ok": false, "errors": ["status: Input should be 'new', 'won' or 'lost'"]}`.
- From TypeScript: `checkKind(kind, value)` → `{ok, errors}` (a 404 throws).
- From Python, in a process that registered the kind:

```python
from pydantic import TypeAdapter
from flow_sdk.schema.data_spec import DataSpec

Lead = DataSpec.parse("--acme--.crm.lead")
TypeAdapter(Lead).validate_python(value)      # raises ValidationError when it does not fit
```

A standalone script sees only the kinds Flowpad ships. Register the project's first:
`from flow_sdk.schema.data_spec.declared import load_root; load_root(<project root>)`.
