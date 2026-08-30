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
    "spec": {                                       // a compact DataSpec (§ Spec)
      "fields": { "category": "string" }
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
dataset folder's named identity capsule:

```json
// .flow/capsules/identity.json
{"version": 1, "data": {"id": "3f2dcaba-0e1f-49b0-b220-467938e4875d"}}
```

Copy or move the complete dataset folder, including `.flow/`, to retain that
identity. You may create the capsule yourself with a valid UUID v4 or v5 when
pre-pinning is required. An existing `metadata.id` inside `dataset.json` remains
a read-only compatibility source, but new identity is never written there.

---

## 2. `csv` layout

```
agentic-assets/dataset/<slug>/
  dataset.json        # { "metadata": { "data_layout": "csv" }, "data": {} }
  data.csv            # one row per example
```

`data.csv` columns map onto the canonical example fields. By default the parser
looks for columns named `input`, `expected`, and `kind`. If your headers differ,
remap them with `field_spec` (canonical → your header):

```jsonc
// dataset.json
{ "metadata": { "data_layout": "csv", "field_spec": { "input": "question", "expected": "answer" } } }
```
```csv
question,answer,difficulty
capital of France?,Paris,easy
```

- `input` → `Example.input`, `expected` → `Example.expected`, `kind` →
  `Example.kind` (`train` | `eval` | `test`; default `train`).
- **Any column not mapped lands in `Example.metadata`** (here: `difficulty`).

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

Each `examples/<name>/` folder describes **one example** through up to three
**slots** plus metadata.

### 3.1 Slots: `input`, `output`, `ground_truth`

| Slot | Meaning |
|---|---|
| `input` | what the system is given (the prompt / scan / document). **Required** — a folder with no input in any form is skipped. |
| `output` | candidate / produced result(s). Informational; **never** treated as the gold. |
| `ground_truth` | the **gold** — the correct/expected answer; multiple = several annotations (consensus). |

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
  from the dataset id + folder name so re-indexing is idempotent.

### 3.4 Resolution rules (the fine print)

- **Gold = `ground_truth` only.** `output` never feeds the gold.
- **Legacy `expected.txt`** (and `input.txt`) still work: `input.txt` →
  `Example.input`, `expected.txt` is folded onto the `ground_truth` slot. A
  native `ground_truth.*` wins over a legacy `expected.txt` if both exist.
- **File beats folder**: if both a bare file and a same-named folder claim one
  slot+index (e.g. `input.txt` *and* `input/`), the file wins and the folder is
  ignored.
- **Binary-safe**: data files are referenced by relative path and never eagerly
  read; only small `.txt`/`.md` files are decoded into text. PDFs/images carry a
  path but no text.

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
    input=FileRef(path="input.pdf"),
    output=[FileRef(path="output-1.txt"), FileRef(path="output-2.txt")],
    ground_truth=[FolderSpec(path="ground_truth", files={"grade.json": FileRef(path="ground_truth/grade.json")}),
                  FolderSpec(path="ground_truth-2", files={"grade.json": FileRef(path="ground_truth-2/grade.json")})],
    metadata={"input.json": {"metadata": {"pages": 3}, "data": {}},
              "ground_truth.json": {"metadata": {"rater": "A"}, "data": {}}},
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
| `POST /graph/dataset/<id>/promote` | `{"source_item_ids": [...]}` | `examples/NNNN/input/item.json` (the envelope) + `example.json` with `metadata.source` provenance |
| `POST /graph/dataset/<id>/annotate` | `{"example_id", "ground_truth"}` | `examples/NNNN/ground_truth/label.json`, validated against the output shape; `metadata.annotations += {by, at}` |
| `GET /graph/dataset/<id>/examples` | — | `[{example_id, item_id, kind, annotated}]` read from the folder |

Both are per-example writes (`FolderLayout.append` / `annotate`) — the other
rows are never rewritten — and both re-derive the counts through the indexer's
discovery, so `num_examples` / `num_annotated` on the row follow the disk. The
builtin `spec` editor of every source definition carries the pane that drives
them; the `connect-data-source` skill's `define` mode drives them for an agent.
