---
id: d6e8f077-4190-4650-8378-a5d491cc4b97
---
# Datasets — snippets

A dataset is a folder of examples: `input` + `context` → the right `ground_truth`, and what a run
produced as `output`. When its `spec` NAMES a kind, every slot is a typed value — and the kinds
can be defined as `data_spec` folders nested in the dataset itself, so the dataset carries its
own definitions. The shipped example is the SmartNavigator eval set
(`flowpad_assistant/agentic-assets/dataset/smart-navigator/`).

Pinned by `tests/unit/test_datasets_snippets.py` (runs every Python fence). The mechanics are
pinned by `tests/unit/test_data_spec/test_declared_kinds.py`,
`tests/unit/test_data_spec/test_typed_dataset_rows.py` and `tests/api/test_dataset_editors.py`.

## 1. Define the row kinds as folders

```
dataset/smart-navigator/
  dataset.json                          # metadata.spec: "navigator.dataset"
  agentic-assets/
    data_spec/navigator.dataset/        # {"examples": {"input": "navigator.request", ...}}
      agentic-assets/data_spec/
        navigator.request/  navigator.context/  navigator.decision/
    webapp/editor/                      # optional: the dataset's own editor
  examples/0001/
    input/request.json  context/context.json  ground_truth/decision.json  example.json
```

```json
{"type": "data_spec", "fields": {
  "route":  {"shape": "enum:quick|agentic", "description": "quick: open now; agentic: ask"},
  "target": {"shape": "?navigator.target",  "description": "what to open; absent when agentic"},
  "verb":   {"shape": "?enum:show|navigate"}}}
```

The folder name is the kind. Indexing registers it under the project's namespace (ours when
shipped); `?` may be absent, `enum:` is a closed set, a field naming another kind nests it.

## 2. Read a dataset

```python
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.core.navigator_eval import SHIPPED

nav = Dataset.at(SHIPPED)                 # the entity from disk alone -- no index needed
summary = (nav.spec, nav.num_examples, nav.kind_counts)   # ('navigator.dataset', 52, {'eval': 50, 'test': 2})
rows = nav.read_rows()
first = rows[0].input.utterance           # 'open data sources'
problems = nav.validate_rows()            # [] -- every row fits navigator.dataset
```

## 3. Write rows and labels

```python
from flow_sdk.builtin.dataset import Dataset

mine = Dataset.at(folder)                 # a dataset.json whose spec is "navigator.dataset"
ids = await mine.append([
    {"kind": "eval", "input": {"utterance": "open data sources"}, "context": {"candidates": []},
     "ground_truth": {"route": "quick", "target": {"kind": "view", "value": "data-sources"}}},
])
await mine.annotate(ids[0], [
    {"route": "quick", "target": {"kind": "view", "value": "data-sources"}},
    {"route": "quick", "target": {"kind": "view", "value": "connectors"}},
])
gold = mine.example(ids[0])["ground_truth"]   # both answers -- any one is right
```

`append` checks every row before writing anything; `annotate` replaces the gold. Over HTTP the
same verbs are `POST dataset/<id>/append`, `GET dataset/<id>/example/<eid>`,
`POST annotate`, `POST validate`, `POST score`.

## 4. Evaluate the navigator on it

```python
from flow_sdk.core import navigator_eval

report = await navigator_eval.evaluate(nav)     # every eval row, on its OWN recorded context
scores = (report["precision"], report["coverage"], report["agentic_recall"], report["confident_wrong"])
```

Live, with Jev as the hub's decision API: precision 1.0, coverage 0.92, agentic recall 1.0,
confident-wrong 0. Without a decision API every row is `agentic` (the navigator is off).

## 5. Open it in an editor

A dataset opens in the app that edits it — its own nested editor, else one whose `webapp.json`
`edits` names its kind, else the generic dataset editor (`GET /api/v1/editors/dataset-<id>`). The
editor builds its forms from the kinds (`GET /api/v1/kinds/navigator.decision`).
