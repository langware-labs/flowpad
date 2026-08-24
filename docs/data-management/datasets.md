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

Every example normalizes to the same `Example` shape regardless of layout, so
downstream code calls `dataset.examples()` / `dataset.examples(ExampleKind.EVAL)`
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
  `layout`, `schema`, …). The set grows over time; unknown keys here are preserved
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
    "schema": { "input": { "scan": { /* json-schema */ } } } // forward-looking, opaque today
  },
  "data": {
    "owner": "you@example.com"                      // free — surfaced under record metadata.data
  }
}
```

Computed fields you **do not** write — the indexer fills them in:
`num_examples`, `kind_counts`, `num_annotated`, `num_multi_output`,
`num_binary_inputs`.

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

Each example becomes an `Example` (`flow_sdk/builtin/dataset.py`):

```python
class Example:
    id: str                 # deterministic uuid5(dataset_id : key)
    kind: ExampleKind       # train | eval | test  (from example.json metadata)
    metadata: dict          # example.json `metadata` section (+ CSV leftover columns)
    data: dict              # example.json `data` section (free, use-case-owned)
    datum: Datum | None     # the row's content — see below
    layout: str | None      # example.json metadata["layout"]
```

`datum` is a [`Datum`](datum.md) tree that **mirrors the recognized slots of the
example directory** — entries matching `input`/`output`/`ground_truth` (and the
legacy `expected` alias). An unrelated file such as `notes.md` is not indexed:

| On disk | In the tree |
|---|---|
| a file (`input.pdf`) | a **leaf**, `value` = its example-relative path, `kind` = `content.file` |
| a folder (`ground_truth/`) | a **branch** of its members, recursively |
| a numbered occurrence (`output-2.txt`) | a sibling key `output-2` |
| a sidecar (`ground_truth-2.json`) | a sibling **leaf** keyed by its full filename, `value` = its two sections |

```jsonc
// examples/0001/ from §3.5
{ "fields": {
    "input":               { "kind": "content.file", "value": "input.pdf" },
    "input.json":          { "value": {"metadata": {"pages": 3}, "data": {}} },
    "output-1":            { "kind": "content.file", "value": "output-1.txt" },
    "output-2":            { "kind": "content.file", "value": "output-2.txt" },
    "ground_truth":        { "fields": {"grade.json": {"kind": "content.file",
                                                       "value": "ground_truth/grade.json"}} },
    "ground_truth-2":      { "fields": {"grade.json": {"kind": "content.file",
                                                       "value": "ground_truth-2/grade.json"}} },
    "ground_truth.json":   { "value": {"metadata": {"rater": "A"}, "data": {}} } } }
```

Three rules make this readable without a slot model:

- **At the example root**, a data key never contains a dot and a sidecar key
  always does — a root data key is a filename *stem*. Inside a folder branch
  members are keyed by full filename, so the rule is root-level only.
- **Key order is canonical** — bare occurrence first, then numbered ascending.
  It is the only carrier of that ordering, so readers must not re-sort.
- **File vs folder is structural**, not a flag: a file is a leaf, a folder is a
  branch. A folder's contained paths are simply its leaf values.

Nothing is decoded. A leaf carries a *reference*; reading the bytes is the
consumer's job, lazily — which is what keeps a dataset of PDFs cheap to index.

A CSV row builds the same tree with the cell value in the leaf instead of a path
(`{"fields": {"input": {"value": "capital of France?"}}}`); the `content.file`
kind is what tells a reference from a literal.

---

## 5. Authoring checklist

- [ ] Every `*.json` is two-section — known keys under `metadata`, free under `data`
      (a flat JSON is ignored).
- [ ] Folder is at `agentic-assets/dataset/<slug>/` with a `dataset.json` at its root.
- [ ] `dataset.json` `metadata` sets `data_layout` (`csv` or `io_folder`); preserve
      `.flow/capsules/identity.json` when copying or moving the dataset.
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
