# Dataset Layout (Authoring Guide)

How to lay out a **dataset** on disk so the Flowpad library discovers and parses
it. This is the user-facing contract — the folders and files *you* create. The
parser lives in `flow_sdk/fs_store/indexer/functions/dataset.py`; the entity and
row models in `flow_sdk/builtin/dataset.py`.

A dataset is a **folder** under `assets/datasets/<slug>/`, marked by a
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

## 1. The dataset manifest — `dataset.json`

Lives at the dataset root. It is both the **discovery marker** and the dataset's
configuration + metadata.

```jsonc
{
  "id": "f81d4fae-7dec-11d0-a765-00a0c91e6bf6", // optional but recommended (see Portability)
  "title": "Grader E2E",                         // display name
  "description": "End-to-end grading eval cases", // free text
  "data_layout": "io_folder",                    // "csv" | "io_folder"  (default: "csv")
  "field_spec": { "input": "question" },          // CSV column remap only (see §2)
  "delimiter": ","                                // CSV only

  // any other keys you add are preserved verbatim on the dataset record's metadata
  "owner": "you@example.com"
}
```

Computed fields you **do not** write — the indexer fills them in:
`num_examples`, `kind_counts`, `num_annotated`, `num_multi_output`,
`num_binary_inputs`.

### Portability

If you omit `id`, the dataset's id is derived from its **absolute folder path**,
so moving the folder to another machine/path changes its identity. **Pin a `id`
(UUID v4 or v5) in the manifest** to keep a stable identity across relocation —
that is what makes a dataset transferable.

---

## 2. `csv` layout

```
assets/datasets/<slug>/
  dataset.json        # { "data_layout": "csv" }
  data.csv            # one row per example
```

`data.csv` columns map onto the canonical example fields. By default the parser
looks for columns named `input`, `expected`, and `kind`. If your headers differ,
remap them with `field_spec` (canonical → your header):

```jsonc
// dataset.json
{ "data_layout": "csv", "field_spec": { "input": "question", "expected": "answer" } }
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
assets/datasets/<slug>/
  dataset.json        # { "data_layout": "io_folder" }
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

### 3.2 Metadata sidecars: `<slot>.json`

A `<slot>.json` (or `<slot>-<N>.json`) file is the **metadata sidecar** for that
artifact — **not** slot data. `.json` is *always* metadata in a slot position.

```
examples/0001/
  input.pdf            # input data
  input.json           # metadata about the input slot  (e.g. { "pages": 3 })
  ground_truth/grade.json   # gold data (structured → use the folder form)
  ground_truth.json    # metadata about the gold        (e.g. { "rater": "A" })
```

> **Structured gold goes in the folder form.** Because `<slot>.json` is reserved
> for metadata, put structured slot *data* inside the folder
> (`ground_truth/grade.json`), not at `ground_truth.json`.

### 3.3 Example & dataset metadata: `example.json`

Per-example metadata lives in `example.json` (the file `meta.json` is still
accepted as a back-compat alias; `example.json` wins on key conflict).

```jsonc
// examples/0001/example.json
{ "kind": "eval", "layout": "pages", "anything": "else" }
```

- Reserved keys `kind` and `layout` are lifted onto `Example.kind` /
  `Example.layout`, **and** every key (reserved or not) is preserved verbatim in
  `Example.metadata`.
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
assets/datasets/grader-e2e/
  dataset.json                     # { "id": "...", "data_layout": "io_folder", "title": "Grader E2E" }
  examples/0001/
    input.pdf                      # raw input (binary; referenced, not read)
    input.json                     # { "pages": 3 }              ← input slot metadata
    output-1.txt   output-2.txt    # two candidate outputs
    ground_truth/grade.json        # gold annotation #1 (structured → folder form)
    ground_truth.json              # { "rater": "A" }            ← gold metadata
    ground_truth-2/grade.json      # gold annotation #2 (consensus)
    ground_truth-2.json            # { "rater": "B" }
    example.json                   # { "kind": "eval", "layout": "pages" }
```

---

## 4. What the parser produces

Each example becomes an `Example` (`flow_sdk/builtin/dataset.py`):

```python
class Example:
    id: str                 # deterministic uuid5(dataset_id : key)
    kind: ExampleKind       # train | eval | test
    input: str              # back-compat scalar: input.txt/.md text, else ""
    expected: str | None    # back-compat scalar: ground_truth primary text, else None
    metadata: dict          # example.json / meta.json (+ CSV leftover columns)
    # structured slots (io_folder):
    input_slot: ExampleSlot | None
    output_slot: ExampleSlot | None         # candidate — never the gold
    ground_truth_slot: ExampleSlot | None   # gold; >1 artifact ⇒ consensus
    layout: str | None      # example.json["layout"]
```

A slot holds one or more **artifacts**, each with `kind` (`file`/`folder`),
`path` (relative), `files` (folder contents), `text` (decoded for `.txt`/`.md`
only), `index` (the `N` in `output-2`), and `metadata` (from its `.json`
sidecar). Read the structured slots for binary/folder/multi data; use
`input`/`expected` for the simple single-text case.

---

## 5. Authoring checklist

- [ ] Folder is at `assets/datasets/<slug>/` with a `dataset.json` at its root.
- [ ] `dataset.json` sets `data_layout` (`csv` or `io_folder`) and a pinned `id`.
- [ ] **csv**: `data.csv` present; non-standard headers remapped via `field_spec`.
- [ ] **io_folder**: every `examples/<name>/` has an `input` artifact (file/folder).
- [ ] Gold goes under `ground_truth` (structured gold → folder form, e.g.
      `ground_truth/grade.json`); multiple annotations use `ground_truth-1`, `-2`, …
- [ ] `<slot>.json` is used only for metadata; `example.json` carries `kind`/`layout`.
- [ ] Run the indexer (`flow record index`) to register the dataset and counts.

See also: [Folder Layout](folder-layout.md) (internal records-root layout) and
[Schema Registry](schema-registry.md) (how the `dataset` type is registered).
