"""Evaluate a dataset with its own eval -- ``eval.json`` + ``eval.py`` -- and report the run.

    from flow_sdk.evals import run
    result, folder = await run(Dataset.at(path))        # folder/run.json, examples.jsonl, report.html

    python -m flow_sdk.evals <dataset folder> [--eval NAME] [--kinds eval,train] [--limit N]

An eval is a folder: ``eval.json`` (``EvalSpec``) and the module it names, which defines

    async def evaluate_example(row) -> ExampleEval       # required: one example, run and judged
    def aggregate(results: list[ExampleEval]) -> dict    # optional: the dataset's own metrics
    def versions() -> dict[str, str | DataSpec]          # optional: what else decides the result; a
                                                         #   value of a schema is kept once in the
                                                         #   dataset and recorded as its reference

A dataset uses the eval nested in it (``<dataset>/agentic-assets/eval/<name>/``), else any eval
shipped in the Flowpad Assistant project whose ``dataset_kind`` is the dataset's spec -- the rule an
editor follows. ``verdict_of`` is the standard judgement: a prediction matching any gold is correct.
"""

from flow_sdk.datasets.score import golds, matches
from flow_sdk.evals import store
from flow_sdk.evals.runner import EvalError, find_evals, run, verdict_of
from flow_sdk.schema.data_spec.eval_spec import EvalRun, EvalSpec, EvalTrace, ExampleEval, Verdict

__all__ = [
    "EvalError", "EvalRun", "EvalSpec", "EvalTrace", "ExampleEval", "Verdict", "find_evals", "golds", "matches", "run", "store", "verdict_of",
]
