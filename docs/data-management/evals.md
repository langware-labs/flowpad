---
id: 800726e1-a568-4a3f-a4f2-d777fe14ac80
---
# Evals — a dataset's own eval, standard results, one report

A dataset is evaluated by an **eval**: a folder with `eval.json` (an `EvalSpec`) and the module it
names (`eval.py` by default). The eval is the dataset's own code; everything around it is generic
(`flow_sdk/evals/`), so every run records and reports the same way.

## The pieces (`flow_sdk/schema/data_spec/eval_spec.py`)

| kind | what it is |
|---|---|
| `eval.spec` (`EvalSpec`) | `eval.json`: `name`, `dataset_kind` (the dataset spec it reads), `kinds` (example roles to run, default `eval`), `entry`, `metrics`, `slices` (row paths to group by — `data.group`, `labels.feasible`) |
| `eval.example` (`ExampleEval`) | one example, evaluated: `prediction`, `golds`, `verdict` (`correct` / `wrong` / `abstained` / `error`), `score`, `latency_ms`, `error`, `labels`, `slice`, `title` |
| `eval.run` (`EvalRun`) | one run: dataset, eval name + digest, `versions`, timestamps, verdict `counts` (+ `unlabelled`), `metrics`, per-slice counts and metrics |

## The contract (`eval.py`)

```python
async def evaluate_example(row) -> ExampleEval     # required: run the official inference on row.input, judge it
def aggregate(results) -> dict[str, float]         # optional: the dataset's own metrics
def versions() -> dict[str, str | DataSpec]       # optional: what else decides the result (endpoint, map)
```

A version that is a **value of a schema** (the navigator's `navigation.map`) is kept once in the
dataset — `<dataset>/agentic-assets/value/<name>/value.json` plus its identity capsule
(`flow_sdk.values.save_value`; a new folder only when the content changed) — and the run records
its reference `navigation.map.id.<uuid>`, so every run names the exact version it used.
`GET /api/v1/values/<ref>?within=dataset-<id>` reads it back, and a viewer given the reference
draws the value it names.

`verdict_of(prediction, row)` is the standard judgement: correct when the prediction matches any of
the row's golds (`flow_sdk.datasets.score.matches` — a gold field left empty is free).

## Running

```
python -m flow_sdk.evals <dataset folder> [--eval NAME] [--kinds eval,train] [--limit N]
```

or `await flow_sdk.evals.run(dataset, out_dir=...)`. The runner:

* resolves the eval — one **nested** in the dataset (`<dataset>/agentic-assets/eval/<name>/`), else
  one **shipped** in the Flowpad Assistant project whose `dataset_kind` is the dataset's spec;
* runs every **labelled** example of the eval's roles (unlabelled ones are counted, not judged); an
  example that raises is `verdict: error` and the run carries on;
* writes `<dataset>/evals/<run_id>/`: `run.json`, `examples.jsonl`, and `report.html` — one
  self-contained page: headline metrics, the verdict bar, a table per slice (click a value to
  filter), and every example (failures first; click one for its gold, prediction and labels).

## The SmartNavigator eval

`flowpad_assistant/agentic-assets/eval/navigator/` runs each example through the public
`flow_sdk.navigation.decide` on the example's own recorded `here` and search candidates. A target
is right when it is a gold or opens the same address as one (`flow_sdk.navigation.address_of`: a
session as an entity and as its screen), and it counts as **correct only if it also opens** — a
right target nothing can address is handed to the assistant in the app, so it is wrong here too
(`labels.opens`). Metrics: precision, coverage, agentic recall, confident-wrong, and
`feasible_accuracy` (over examples one step can answer — a right answer was among the options
offered, or a rule names it; `labels.feasible`).

Its dataset holds two suites: `benchmark` (the 52 original cases) and `ux-surface` (the 200
sentences of `docs/navigation/navigation-sentences.md`, imported by
`scripts/import_navigation_sentences.py` with fixtures and context recorded in each example).
