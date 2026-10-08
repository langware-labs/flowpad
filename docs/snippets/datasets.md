---
id: d6e8f077-4190-4650-8378-a5d491cc4b97
---
# Datasets — snippets

A dataset is a folder of examples: `input` + `context` → the right `ground_truth`, and what a run
produced as `output`. When its `spec` NAMES a kind, every slot is a typed value — and the schemas
those kinds name can be defined as `data_schema` folders — nested in the dataset itself, or
shipped. The example is the SmartNavigator eval set: its schemas ship
(`flowpad_assistant/agentic-assets/data_schema/navigat*`),
its rows do not — they live beside the checkout at `dev/dataset/smart-navigator/`
(`flow_sdk.core.navigation.DATASET`, overridable with `FLOW_NAVIGATOR_DATASET`), and the fences that read
them skip where it is absent.

Pinned by `tests/unit/test_datasets_snippets.py` (runs every Python fence). The mechanics are
pinned by `tests/unit/test_data_spec/test_declared_kinds.py`,
`tests/unit/test_data_spec/test_typed_dataset_rows.py` and `tests/api/test_dataset_editors.py`.

## 1. Define the row schemas as folders

```
flowpad_assistant/agentic-assets/data_schema/  # shipped, flat: the folder name is the kind
  navigation.map/ .place/ .subplace/           # the map (screens)
  navigation.here/ .ref/ .shown/ .outcome/     # you are here
  navigator.dataset/                           # {"examples": {"input": "navigator.request", ...}}
  navigator.request/ .context/ .candidate/ .decision/

dev/dataset/smart-navigator/                   # the rows -- not shipped
  dataset.json                          # metadata.spec: "navigator.dataset"
  map.json                              # reference: the navigation map, for browsing
  examples/0001/
    input/request.json  context/candidates/  ground_truth/decision.json  example.json
```

```json
{"type": "data_schema", "fields": {
  "route":  {"shape": "enum:quick|agentic", "description": "quick: open now; agentic: ask"},
  "target": {"shape": "?navigator.target",  "description": "what to open; absent when agentic"},
  "verb":   {"shape": "?enum:show|navigate"}}}
```

The folder name is the kind. Indexing registers the schema under it, in the project's namespace (ours when
shipped); `?` may be absent, `enum:` is a closed set, a field naming another kind nests it.

## 2. Read a dataset

```python
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.core.navigation import DATASET

nav = Dataset.at(DATASET)                 # the entity from disk alone -- no index needed
summary = (nav.spec, nav.num_examples, nav.kind_counts)   # ('navigator.dataset', 252, {'eval': 250, 'test': 2})
rows = nav.read_rows()
first = rows[0].input.utterance           # 'open data sources'
where = rows[0].input.here.view           # 'home' -- the navigation.here it was typed on
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

A dataset is evaluated by an **eval** -- `eval.json` (`EvalSpec`) + `eval.py` -- nested in it, or
shipped for its kind. The navigator's ships at `flowpad_assistant/agentic-assets/eval/navigator/`:
it runs each example through the public `flow_sdk.navigation.decide` on the example's OWN recorded
`here` and candidates, and answers a standard `ExampleEval` per row. The runner writes
`evals/<run>/run.json`, `examples.jsonl` and a navigable `report.html`.

```python
from flow_sdk import evals

run, folder = await evals.run(nav, out_dir=runs)   # `runs`: where to write (default: <dataset>/evals)
benchmark = run.slices["data.suite"]["benchmark"]   # the 52 original cases; "ux-surface" = the 200 UX sentences
scores = tuple(benchmark[k] for k in ("precision", "coverage", "agentic_recall", "confident_wrong"))
report = folder / "report.html"
```

The same from a shell: `python -m flow_sdk.evals <dataset folder> [--eval NAME] [--kinds eval]`.

Live, with Jev as the hub's decision API: precision 1.0, coverage 0.92, agentic recall 1.0,
confident-wrong 0. Without a decision API every row is `agentic` (the navigator is off).

## 5. Open it in an editor

A dataset opens in the app that edits it — its own nested editor, else one whose `webapp.json`
`edits` names its kind, else the generic dataset editor (`GET /api/v1/editors/dataset-<id>`). The
editor builds its forms from the kinds (`GET /api/v1/kinds/navigator.decision`).

## 6. Log real decisions into a training set (SmartNavigationLog)

With **Preferences → Advanced → Smart navigation log** on (off by default), every decision the
magic line makes is appended to the user's own **SmartNavigationLog** dataset
(`<FLOWPAD_TEMP_DIR>/<instance>/agentic-assets/dataset/smart-navigation-log/` — Flowpad's temp
folder, which the OS clears now and then, so copy rows worth keeping into a kept dataset; spec `navigator.dataset` —
the same row kind as the SmartNavigator eval set). A row is `train`, carries what was typed and where,
what was offered and decided, and what was done (`data.address` or `data.prompt`) — and no gold
until someone reviews it.

```python
from flow_sdk import evals
from flow_sdk.core import navigation_log
from flow_sdk.core.navigation_decision import decide_run
from flow_sdk.preferences import PREF_SMART_NAVIGATION_LOG, write_instance_pref

write_instance_pref(PREF_SMART_NAVIGATION_LOG, True)
request = {"utterance": "summarize the README", "here": {"view": "home"}}
outcome, answer = await decide_run(request)      # what the navigation-decision action runs
await navigation_log.log(request, outcome, answer)  # ...and then, after answering, this

log = await navigation_log.dataset()               # SmartNavigationLog
row = log.read_rows()[-1]
logged = (row.input.utterance, row.output.route, row.data["prompt"])  # (..., 'agentic', ...)
await log.annotate(row.id, {"route": "agentic"})   # reviewed: asking was right
run, _ = await evals.run(log, kinds=["train"], out_dir=runs)   # only labelled rows are judged
write_instance_pref(PREF_SMART_NAVIGATION_LOG, False)
```

In the dataset editor the same review is one click: **Correct** labels a row with what the run
did, and the **needs label** filter lists what is left.

## 7. Keep records by key

A row's **key** is its example folder's name. Give one on `append`, then address the row by it —
never re-compute an example id: it is derived from the key, so `read_rows()` hands both back.

```python
from flow_sdk.builtin.dataset import Dataset

mine = Dataset.at(folder)
await mine.append([{"key": "open-sources", "input": {"utterance": "open data sources"}}])
await mine.put("open-sources", {"input": {"utterance": "open my data sources"}})  # replace; gold kept
problems = mine.check({"input": {"utterance": 7}})        # what is wrong -- nothing is written
new_id = mine.rename_row("open-sources", "sources")       # the id follows the key
keys = [row.key for row in mine.read_rows()]              # ['sources']
mine.delete_row("sources")
```

`put` creates or replaces one row and checks it first; slots it leaves out (gold, output, context)
and the row's metadata are kept. Over HTTP: `POST dataset/<id>/put-row {key, row}`,
`POST delete-row {key}`, `POST rename-row {key, new_key}`, `POST check-row {row}`; one value
against a kind, outside any dataset: `POST /api/v1/kinds/<kind>/check {value}` (an unknown kind is a
404, never "fits"). TypeScript: `dataset.put / deleteRow / rename / check` and `checkKind(kind, value)`.
