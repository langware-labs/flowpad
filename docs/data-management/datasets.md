---
id: 214b0833-33ad-5a42-b825-688700d6277a
---

# Dataset Layout (Authoring Guide)

How to lay out a **dataset** on disk so the Flowpad library discovers and parses
it. This is the user-facing contract — the folders and files *you* create. The
parser lives in `flow_sdk/fs_store/indexer/functions/dataset.py`; the entity and
row models in `flow_sdk/builtin/dataset.py`.

A dataset is a **folder** under `agentic-assets/dataset/<slug>/`, marked by a
`dataset.json` manifest at its root. Without that manifest the folder is **not**
discovered as a dataset. It holds many **examples** (rows) in one of two physical
layouts, chosen by `data_layout` in the manifest:

| `data_layout` | Shape | Use when |
|---|---|---|
| `csv` | one `data.csv`; each row is an example | flat, tabular, text-only data |
| `io_folder` | an `examples/` tree; one sub-folder per example | files, binaries, multiple outputs, multi-annotation gold |

Every example normalizes to the same `ExampleSpec` shape regardless of layout, so
downstream code reads `dataset.examples` / `dataset.of_kind(ExampleKind.EVAL)`
without caring which layout produced it.

---

## 0. The two-section convention (`metadata` + `data`)

**Every domain dataset JSON file** — `dataset.json`, `example.json`, and the `<slot>.json`
sidecars — is a two-section document:

```jsonc
{
  "metadata": { /* known schema, managed by flowpad — parsed into typed fields */ },
  "data":     { /* free-form; your use case puts whatever it wants here */ }
}
```

- **`metadata`** holds flowpad-recognized keys (`data_layout`, `field_spec`, `kind`,
  `layout`, `spec`, …). The set grows over time; unknown keys here are preserved
  but not interpreted.
- **`data`** is an opaque object flowpad never reads — it round-trips verbatim onto
  the corresponding model's `.data`.

Both sections are **mandatory**: a *flat* JSON (one with neither key) is treated as
malformed — both sections come back empty, so `kind`/`data_layout`/etc. written at
the top level are **ignored**. Always nest under `metadata`/`data`.

The FlowPad-managed `.flow/capsules/*.json` files are not dataset domain
documents and use the capsule schema described under Portability below.

> The `csv` layout is the one exception — `data.csv` cells are not JSON docs; its
> leftover columns land in `Example.metadata` (see §2).

---

## 1. The dataset manifest — `dataset.json`

Lives at the dataset root. It is both the **discovery marker** and the dataset's
configuration + metadata, in the two-section form:

```jsonc
{
  "metadata": {
    "title": "Grader E2E",                         // display name
    "description": "End-to-end grading eval cases", // free text
    "data_layout": "io_folder",                    // "csv" | "io_folder" (default "csv")
    "field_spec": { "input": "question" },          // CSV column remap only (§2)
    "delimiter": ",",                               // CSV only
    "spec": {                                       // a DatasetSpec authoring form (§ Spec)
      "examples": [ { "input":  { "question": "string" },
                      "output": { "category": "string" } } ]
    }
  },
  "data": {
    "owner": "you@example.com"                      // free — surfaced under record metadata.data
  }
}
```

Computed fields you **do not** write — the indexer fills them in:
`num_examples`, `kind_counts`, `num_annotated`, `num_multi_output`,
`num_binary_inputs`.

### The `spec`

`spec` is a [`DatasetSpec`](data-spec.md) authoring form — the shape every row
has, written as ONE example shape:

```jsonc
"spec": { "examples": [ { "input":  { "subject": "string", "body": "string" },
                          "output": { "category": "string" },
                          "context": { "history": ["string"] } } ] }
```

`input` is required; `output` / `ground_truth` share one shape (either name
declares it); `context` is optional. Each slot is a `DataSpec` authoring form —
a bare kind (`"file_ref"`, `"text"`, a registered class), an object, or a
one-element list. It compiles to `DatasetSpec[ExampleSpec[I, O, C]]`, a real
Pydantic parametrization, and is stored back in exactly this form with kinds
normalized.

Omitting `spec` is legal: rows validate against `DEFAULT_DATASET_SPEC`, whose
slots accept any artifact (`FileRef | FolderSpec | TextSpec`). A malformed spec
is logged and ignored, never fatal — the rows beside it parse fine and must not
be lost over a bad metadata key.

The index pass reads rows as ARTIFACTS regardless of `spec`: a file is a
`FileRef`, not its contents. Validating contents against the declared shape
means opening the files — `dataset.example_type.model_validate(...)` — and is
the consumer's call.

### Portability

On the first writable index, FlowPad mints a UUID v4 and stores it in the
dataset folder's `Sidecar` carrier:

```json
// .flow/capsules/identity.json
{"version": 1, "data": {"id": "3f2dcaba-0e1f-49b0-b220-467938e4875d"}}
```

Copy or move the complete dataset folder, including `.flow/`, to retain that
identity. You may create the file yourself with a valid UUID v4 or v5 when
pre-pinning is required. A `metadata.id` inside `dataset.json` is not an
identity source; `flow_sdk/migrations/migration_2026_09_identity_live_forms.py`
moves a folder that still relies on one into the sidecar.

---

## 2. `csv` layout

```
agentic-assets/dataset/<slug>/
  dataset.json        # { "metadata": { "data_layout": "csv" }, "data": {} }
  data.csv            # one row per example
```

`data.csv` columns map onto the canonical example fields. By default the layout
(`CsvLayout`) looks for columns named `input`, `expected`, and `kind`. If your
headers differ, remap them with `field_spec` (canonical → your header):

```jsonc
// dataset.json
{ "metadata": { "data_layout": "csv", "field_spec": { "input": "question", "expected": "answer" } } }
```
```csv
question,answer,difficulty
capital of France?,Paris,easy
```

- `input` → `ExampleSpec.input` as a `TextSpec` cell, `expected` →
  `ExampleSpec.ground_truth` as a `TextSpec` (the column keeps its legacy name;
  the row field is the gold slot — there is no `expected` field on the row),
  `kind` → `ExampleSpec.kind` (`train` | `eval` | `test`; default `train`).
- **Any column not mapped lands in `ExampleSpec.metadata`** (here: `difficulty`).
- A CSV row never holds a file or a folder: `CsvLayout.write` refuses anything
  but a `TextSpec` cell, and the per-example verbs (`promote` / `annotate`) are
  `io_folder` only.

`field_spec` is a column **rename map only** — it is not a schema and is ignored
by the `io_folder` layout.

---

## 3. `io_folder` layout

```
agentic-assets/dataset/<slug>/
  dataset.json        # { "metadata": { "data_layout": "io_folder" }, "data": {} }
  examples/
    0001/             # one folder per example (the folder name is the example key)
    0002/
    ...
```

Each `examples/<name>/` folder describes **one example** through up to four
**slots** plus metadata.

### 3.1 Slots: `input`, `output`, `ground_truth`, `context`

| Slot | Meaning |
|---|---|
| `input` | what the system is given (the prompt / scan / document). **Required** — a folder with no input in any form is skipped. |
| `output` | candidate / produced result(s). Informational; **never** treated as the gold. |
| `ground_truth` | the **gold** — the correct/expected answer; multiple = several annotations (consensus). |
| `context` | what surrounds the input (history, retrieved documents). Optional; the `C` of `ExampleSpec[I, O, C]`. |

Each slot's **data** may take any of these forms:

| Form | Example | Becomes |
|---|---|---|
| single file | `input.pdf`, `input.txt` | one FILE artifact |
| folder | `ground_truth/grade.json` | one FOLDER artifact (lists contained files) |
| numbered files | `output-1.txt`, `output-2.txt` | multiple artifacts (index 1, 2, …) |
| numbered folders | `ground_truth-1/`, `ground_truth-2/` | multiple artifacts (consensus annotations) |

Numbering (`<slot>-<N>`) is how you express **multiple outputs** and **multiple
ground-truth annotations** for the same example. The bare form and numbered
forms can coexist (bare sorts first).

### 3.2 Sidecars: `<slot>.json`

A `<slot>.json` (or `<slot>-<N>.json`) file is the **two-section sidecar** for that
artifact — **not** slot data. `.json` is *always* a sidecar in a slot position; its
`metadata`/`data` sections land on the artifact's `.metadata`/`.data`.

```
examples/0001/
  input.pdf            # input data
  input.json           # { "metadata": { "pages": 3 }, "data": { … } }  ← input sidecar
  ground_truth/grade.json   # gold data (structured → use the folder form)
  ground_truth.json    # { "metadata": { "rater": "A" }, "data": { … } } ← gold sidecar
```

> **Structured gold goes in the folder form.** Because `<slot>.json` is reserved
> for the sidecar, put structured slot *data* inside the folder
> (`ground_truth/grade.json`), not at `ground_truth.json`.

### 3.3 Example metadata: `example.json`

Per-example metadata lives in `example.json` (the file `meta.json` is still
accepted as a back-compat alias; `example.json` wins per section on conflict).

```jsonc
// examples/0001/example.json
{
  "metadata": { "kind": "eval", "layout": "pages" }, // known → lifted to Example.kind/.layout
  "data":     { "anything": "you want" }              // free → Example.data
}
```

- Reserved keys `kind` and `layout` (in the **metadata** section) are lifted onto
  `Example.kind` / `Example.layout`, and the whole metadata section is kept on
  `Example.metadata`; the data section is kept on `Example.data`.
- An example-level `id` is **ignored** — example ids are derived deterministically
  (`example_id`: a uuid5 of `<dataset id>:<folder name>`, or the CSV row index) so
  re-indexing is idempotent. An example is a value inside the dataset row, not an
  entity, which is why a derived id is allowed here.

### 3.4 Resolution rules (the fine print)

- **Gold = `ground_truth` only.** `output` never feeds the gold.
- **Legacy `expected.txt`** (and `input.txt`) still work: `input.txt` →
  `Example.input`, `expected.txt` is folded onto the `ground_truth` slot. A
  native `ground_truth.*` wins over a legacy `expected.txt` if both exist.
- **File beats folder**: if both a bare file and a same-named folder claim one
  slot+index (e.g. `input.txt` *and* `input/`), the file wins and the folder is
  ignored.
- **Binary-safe**: data files are referenced by relative path and never read —
  not even `.txt`. The `.txt`/`.md` extension matters only to `is_binary`, which
  feeds the `num_binary_inputs` count. Decoding a file is the consumer's job.

### 3.5 Canonical example

```
agentic-assets/dataset/grader-e2e/
  .flow/capsules/identity.json     # { "version": 1, "data": { "id": "<uuid-v4-or-v5>" } }
  dataset.json                     # { "metadata": { "data_layout": "io_folder", "title": "Grader E2E" }, "data": {} }
  examples/0001/
    input.pdf                      # raw input (binary; referenced, not read)
    input.json                     # { "metadata": { "pages": 3 }, "data": {} }   ← input sidecar
    output-1.txt   output-2.txt    # two candidate outputs
    ground_truth/grade.json        # gold annotation #1 (structured → folder form)
    ground_truth.json              # { "metadata": { "rater": "A" }, "data": {} } ← gold sidecar
    ground_truth-2/grade.json      # gold annotation #2 (consensus)
    ground_truth-2.json            # { "metadata": { "rater": "B" }, "data": {} }
    example.json                   # { "metadata": { "kind": "eval", "layout": "pages" }, "data": {} }
```

---

## 4. What the parser produces

Each example becomes an `ExampleSpec` (`flow_sdk/schema/data_spec/dataset_spec.py`)
— a VALUE model (the `Spec` suffix), never an entity. `Dataset.examples` is the
list, populated eagerly by `DiskSerializer.load` (a Dataset is written by `save()` — the serializer writes `dataset.json` and the rows through `DatasetLayout`):

```python
class ExampleSpec(DataSpec, Generic[I, O, C]):
    id: str                          # deterministic uuid5(dataset_id : key) — the row index (csv) or folder name (io_folder)
    kind: ExampleKind                # train | eval | test  (from example.json metadata; a FIELD, not the spec_kind hook)
    input: I
    output: O | list[O] | None       # one occurrence → O; numbered output-1, output-2… → list[O], canonical order
    ground_truth: O | list[O] | None # the gold answer — same shape as output
    context: C | None
    metadata: dict                   # example.json `metadata` (+ CSV leftover columns) ∪ sidecars by filename
    data: dict                       # example.json `data` section (free, use-case-owned)
```

`layout` is a property reading `metadata["layout"]`, not a field. `ExampleSpec`
is generic in `I, O, C`; the index pass reads every row as
`DEFAULT_DATASET_SPEC.example_type()` (`ExampleSpec[Artifact, Artifact, DataSpec]`).

The slots hold the three leaves. **The type IS the file/folder distinction:**

| On disk | In the row |
|---|---|
| a file (`input.pdf`) | `FileRef(path="input.pdf")` — its example-relative POSIX path, never read |
| a folder (`ground_truth/`) | `FolderSpec(path="ground_truth", files={...})` — members by filename, recursively |
| a CSV cell | `TextSpec(text="…")` |
| numbered occurrences (`output-1.txt`, `output-2.txt`) | `output = [FileRef, FileRef]` — bare first, then numeric ascending |
| a sidecar (`ground_truth-2.json`) | `metadata["ground_truth-2.json"] = {"metadata": …, "data": …}` — legal as an orphan with no data key |

```python
# examples/0001/ from §3.5
ExampleSpec(
    kind=ExampleKind.EVAL,           # lifted from example.json metadata.kind
    input=FileRef(path="input.pdf"),
    output=[FileRef(path="output-1.txt"), FileRef(path="output-2.txt")],
    ground_truth=[FolderSpec(path="ground_truth", files={"grade.json": FileRef(path="ground_truth/grade.json")}),
                  FolderSpec(path="ground_truth-2", files={"grade.json": FileRef(path="ground_truth-2/grade.json")})],
    metadata={"kind": "eval", "layout": "pages",                       # the whole example.json metadata section …
              "input.json": {"metadata": {"pages": 3}, "data": {}},   # … plus every sidecar under its filename
              "ground_truth.json": {"metadata": {"rater": "A"}, "data": {}},
              "ground_truth-2.json": {"metadata": {"rater": "B"}, "data": {}}},
    data={},
)
```

The on-disk grammar is unchanged; what changed is that it is now read and
written by ONE object — [`DatasetLayout`](data-spec.md) (`CsvLayout` /
`FolderLayout`). `ExampleSpec` never learns which layout it came from. A
`FileRef` becomes an absolute path only in `FolderLayout.resolve`.

An example directory with no `input` DATA (a lone `input.json` sidecar is not
data) is skipped entirely and not counted. An `expected*` file is the legacy
alias for `ground_truth`, honoured only when no native gold data exists.

The graph-workflow capture seam (`prepare_execution_io`, `_stamp_example`)
writes through the same `FolderLayout`, so an execution directory IS an
`io_folder` example directory by construction.

## 5. Authoring checklist

- [ ] Every `*.json` is two-section — known keys under `metadata`, free under `data`
      (a flat JSON is ignored).
- [ ] Folder is at `agentic-assets/dataset/<slug>/` with a `dataset.json` at its root.
- [ ] `dataset.json` `metadata` sets `data_layout` (`csv` or `io_folder`); preserve
      `.flow/capsules/identity.json` when copying or moving the dataset.
- [ ] If the dataset declares a shape, put its compact `DataSpec` under
      `dataset.json` `metadata.spec`.
- [ ] **csv**: `data.csv` present; non-standard headers remapped via `field_spec`.
- [ ] **io_folder**: every `examples/<name>/` has an `input` artifact (file/folder).
- [ ] Gold goes under `ground_truth` (structured gold → folder form, e.g.
      `ground_truth/grade.json`); multiple annotations use `ground_truth-1`, `-2`, …
- [ ] `<slot>.json` is a sidecar (metadata/data), not slot data; `example.json`
      `metadata` carries `kind`/`layout`.
- [ ] Run the indexer (`flow record index`) to register the dataset and counts.

See also: [Asset capsules](asset-capsules.md) (portable identity), [Folder
Layout](folder-layout.md) (internal records-root layout), and [Schema
Registry](schema-registry.md) (how the `dataset` type is registered).


## Curating a source into a dataset

A dataset can be **bound to a DataSource** (`Dataset.source_id`, authored in
`dataset.json`). Its row shape is then `input: "ingest.source_item"` — the item
envelope — plus the output shape the person chose, in the keyword form:

```json
{"examples": [{"input": "ingest.source_item", "output": {"topic": "string", "sentiment": "string"}}]}
```

Two actions move data along that seam (`flow_sdk/builtin/dataset.py`), both
`io_folder` only:

| Action | Body | Writes |
| --- | --- | --- |
| `POST /graph/dataset/<id>/promote` | `{"source_item_ids": [...]}` | `examples/NNNN/input/item.json` (the envelope) + `example.json` with `metadata.source` provenance; replies `{example_ids, num_examples}`. A dataset whose `input` shape is not `ingest.source_item` refuses (400); an item from another source refuses; an unknown item is 404 |
| `POST /graph/dataset/<id>/annotate` | `{"example_id", "ground_truth"}` | `examples/NNNN/ground_truth/label.json` (replacing any earlier gold), validated against the output shape (a mismatch is a 400 carrying the output JSON schema); `metadata.annotations += {by, at}`; replies `{example_id, num_annotated}` |
| `GET /graph/dataset/<id>/examples` | — | `{"examples": [{example_id, item_id, kind, annotated}]}` read from the folder |

Both are per-example writes (`FolderLayout.append_many` / `annotate`) — the
other rows are never rewritten — and both re-derive the counts from the cheap
per-example index (`FolderLayout.index`: one `example.json` per dir plus an
`exists` on `ground_truth/`, never the payloads) and save the row, so
`num_examples` / `num_annotated` follow the disk without a full reindex. Numbering
follows the highest existing `NNNN`, never the count, so a gap is preserved. The
editor webapp nested in every shipped source definition carries the pane that
drives them; the `connect-data-source` skill's `define` mode drives them for an
agent.

## Typed rows — a `spec` that NAMES a kind

`spec` may be the name of a registered dataset kind (`"navigator.dataset"`), typically one whose
schema a `data_schema` folder defines — nested in the dataset itself, so the dataset carries its own
schemas (see [data-spec](data-spec.md#schemas-defined-by-a-folder)). Then every slot is a typed
value, written by the generic walker as `«slot»/<last kind segment>.json` (`input/request.json`,
`ground_truth/decision.json`), several gold answers as `ground_truth-1/`, `ground_truth-2/` — any
one is right.

A row's **key** is its example folder's name (`examples/<key>/`); its **id** is stored in the row
(`example.json` `metadata.id`, a v4 minted on first write — a row written before that adopts its legacy
`layout.example_id` on its next write), so a rename or a re-clone keeps it. Every read hands back `key`,
`id`, `ref` (`<row kind>.id.<id>`, how another row links to this one) and `version`. A key a caller
chooses is `a-z 0-9 _ -`; `append` numbers rows that bring none (`0001`, `0002`, …).

| verb | what |
|---|---|
| `POST append {rows}` | typed rows in; every row is checked first, one bad row writes nothing; a row's `key` names its folder (refused when taken) |
| `POST put-row {key, row, expected?}` | create the row `key` or replace it — checked first, references included; slots the row leaves out (gold, output, context) and its metadata are kept; `expected` (the `version` read) answers 409 when the row changed since |
| `POST delete-row {key, expected?}` | remove one row (a key or an id); 404 when absent, 409 while another row references it or (with `expected`) when it changed since |
| `POST rename-row {key, new_key, expected?}` | move a row to a new key; its id (and every reference to it) stays |
| `POST check-row {row}` | `{ok, errors, details}` for one row — shape, references and the schema's rules, links checked even when the shape fails; writes nothing |
| `GET example/<key or id>` | one example's slot VALUES (an editor's read) |
| `POST annotate {example_id, ground_truth}` | REPLACES the gold: a named output kind is written as its own document (`ground_truth/decision.json`; a list → `ground_truth-N/`), an inline shape as `ground_truth/label.json` |
| `GET rows` | `{rows, total, problems}`: every row that fits with its slot values, and the ones that do not, by key with all their errors — one bad row hides nothing. `?filter={match, order_by, limit, offset}` (JSON) answers only the rows that match, ordered and paged; `total` counts the matches before paging, and `problems` is still every row that does not fit |
| `GET count` | `{total, groups}`: how many rows match `?filter=`, and per distinct value of `?group_by=<path>,<path>`: `[{by, count}]`, largest first |
| `POST put-rows {rows, expected?}` | create or replace several rows (`[{key, input, …}]`) as ONE step: every row checked first, one that does not fit (400, `details` under `<key>.<path>`) or changed since `expected` (`{key: version}`, 409) writes nothing |
| `POST delete-rows {keys, expected?}` | remove several rows as ONE step, or none: 404 a key that is no row, 409 a row changed since or still referenced. Rows removed together do not hold each other back |
| `POST sync-rows {rows, prune?, match?}` | make the dataset hold exactly `rows` → `{created, updated, unchanged, deleted}`: a row that reads the same is not rewritten; rows not listed are removed unless `prune` is false, and only those `match` selects when given. All or nothing |
| `POST rows-changed {op, keys}` | a writer outside the server says rows changed (`Dataset.announce`); the server emits the event below. Writes nothing |
| `POST validate` | every row read as the declared schema; names each row that does not fit by its `key` (and `example_id`), with its slot (`ground_truth.route`) |
| `POST score` | each recorded `output` against its gold: a gold field left empty constrains nothing; several golds mean any one is right (`flow_sdk/datasets/score.py`) |

Every refusal and problem carries `details` beside `errors`: `[{path, code, message}]`, `code` one of
`shape:<pydantic type>`, `dangling_ref`, `inline_row`, `rule`, and on a 409 `conflict` (changed since),
`gone` (gone since) or `referenced` (a delete another row still points at) — read those, not the lines.
A field kept in step with a copy outside Flowpad follows the three-way rule:
`flow_sdk.datasets.merge.three_way(here, there, agreed)` → `"same"` / `"here"` / `"there"` / `"hold"`.

**Asking for some rows.** A `match` is the entity query expression (`flow_sdk/db/drivers/query.py`
`ExpressionNode`), evaluated in memory over a row as the API hands it out (`flow_sdk/datasets/query.py`;
the TypeScript twin is `QueryFilter.validate`, and `test_fixtures/dataset_query_cases.json` is run by
both). A field is a path — `key`, `input.stage`, `input.stage_dates.won` — and a date compares as its
ISO string. From Python: `Dataset.query(match, order_by=, limit=, offset=)`, `Dataset.count(match, group_by=)`.

**Many rows in one step.** `Dataset.put_many`, `delete_rows` and `sync` take the project's row lock
once and read what their checks need once. A delete reads only the datasets whose schema can reach
the row's kind (`links.linkers_of`) — none when nothing links to it — where it used to re-read every
row of the project per row deleted.

**One run at a time.** A script that mirrors an outside system wraps its whole run in
`flow_sdk.datasets.run.single_run(project_root, "<name>")`: two runs at once (a trigger's and a
person's "Sync now") would decide on the same reading and overwrite each other's state. The lock is a
file under `<project>/.flow/runs/`; a second run waits, or `wait=False` raises `RunBusy`.

**Rows changing is an event.** Every row write emits `dataset.rows.changed` once per call — target
`dataset:<id>`, data `{op: put|delete|rename|sync, keys (at most 100), count}`, never a value — and
the tag is forwarded to the app (`tags/ws_forward.py`): `dataset.onRowsChanged(handler)` in
TypeScript. A writer outside the server process tells the running instance (`Dataset.announce`, the
`rows-changed` action) — best effort: an event is a hint to re-read, and a write never fails for it.

Indexing still reads rows as artifacts (fast, never fatal); `validate` is the check. One value
against a kind, outside any dataset: `POST /api/v1/kinds/<kind>/check {value}` → `{ok, errors, details,
links_checked}` — the SHAPE only, unless `?project=<id>` adds its references and rules; a kind nobody
registered is a 404, never "fits" (`DataSpec.parse` alone would read it as `Any`). A kind's datasets:
`GET /api/v1/kinds/<kind>/datasets?project=<id>` (a bare kind the project defines works); its full name:
`GET /api/v1/kinds/<bare>/resolve?project=<id>`; the row a reference names: `GET /api/v1/refs/<ref>?project=<id>`.

## Editors

A dataset opens in the app that edits it (`flow_sdk/builtin/faas/editors.py`, `GET /api/v1/editors/<typeid>`):
its own nested editor (`<dataset>/agentic-assets/webapp/<name>/`, kind `application.web.editor`),
else an editor whose `webapp.json` `edits` names the dataset's kind or an ancestor of it (most
specific first), else one that edits the `dataset` type — the shipped generic editor. The SDK app
behind them is `mountDatasetEditor`: it builds every form from the declared kinds
(`GET /api/v1/kinds/<kind>`), so one editor serves every typed dataset.

The example is the SmartNavigator eval set. Its row schemas ship as flat `data_schema` folders
(`flowpad_assistant/agentic-assets/data_schema/navigat*`); its rows do not — they live beside the
checkout at `dev/dataset/smart-navigator/` (`flow_sdk.core.navigation.DATASET`). Shipped assets stay flat:
a nested tree inside the install crossed Windows' 260-char MAX_PATH.
