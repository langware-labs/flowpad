"""A dataset's eval runs, read back: the one reader the actions, the CLI and a browser share.

Runs live in ``<dataset>/evals/<run_id>/`` (``run.json`` + ``examples.jsonl``), written by
``flow_sdk.evals.run``. A run folder that does not read as ``eval.run`` is skipped with a warning --
one broken run never hides the others.
"""

from __future__ import annotations

import logging
from pathlib import Path

from pydantic import ValidationError

from flow_sdk.evals.runner import RUNS_DIR
from flow_sdk.schema.data_spec.eval_spec import EvalRun, ExampleEval

logger = logging.getLogger(__name__)


def explanations(folder: Path, spec: str) -> dict[str, dict[str, str]]:
    """``{eval name: {metric: plain-words meaning}}`` for the evals of this dataset -- read from each
    eval's own ``eval.json``, so a browser explains a metric without knowing any eval."""
    from flow_sdk.evals.runner import find_evals  # noqa: PLC0415

    return {e.name: e.explain for _, e in find_evals(Path(folder), spec)}


def runs(folder: Path) -> list[EvalRun]:
    """Every run of every eval on the dataset at ``folder``, newest first."""
    out = []
    for doc in (Path(folder) / RUNS_DIR).glob("*/run.json"):
        try:
            out.append(EvalRun.model_validate_json(doc.read_text(encoding="utf-8")))
        except (OSError, ValidationError) as exc:
            logger.warning("eval run %s skipped: %s", doc.parent.name, exc)
    return sorted(out, key=lambda r: r.started_at, reverse=True)


def load(folder: Path, run_id: str) -> tuple[EvalRun, list[ExampleEval]]:
    """One run and its examples. ``LookupError`` for a run that is not a folder of ``evals/``."""
    root = (Path(folder) / RUNS_DIR).resolve()
    run_dir = (root / run_id).resolve()
    if run_dir.parent != root or not (run_dir / "run.json").is_file():
        raise LookupError(f"no eval run {run_id!r}")
    run = EvalRun.model_validate_json((run_dir / "run.json").read_text(encoding="utf-8"))
    examples_file = run_dir / "examples.jsonl"
    lines = examples_file.read_text(encoding="utf-8").splitlines() if examples_file.is_file() else []
    return run, [ExampleEval.model_validate_json(line) for line in lines if line.strip()]


__all__ = ["explanations", "load", "runs"]
