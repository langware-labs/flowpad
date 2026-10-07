"""Evaluating a dataset: what an eval declares, what it says about each example, what a run records.

A dataset is evaluated by an EVAL -- a folder with ``eval.json`` (an ``EvalSpec``) and ``eval.py``,
the dataset's own code. ``eval.py`` runs the official inference on each example's standard input
and answers an ``ExampleEval``; the generic runner (``flow_sdk.evals``) collects them into an
``EvalRun`` and renders the report. Same shapes for every dataset, so every report reads the same.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, ClassVar, Optional

from pydantic import Field

from flow_sdk.schema.data_spec.spec import DataSpec


class Verdict(StrEnum):
    """What one example's run came to."""

    CORRECT = "correct"  # matched a gold answer
    WRONG = "wrong"  # answered, and no gold matches
    ABSTAINED = "abstained"  # declined to answer (the navigator handing over to the assistant)
    ERROR = "error"  # the eval raised; the run carried on


class EvalSpec(DataSpec):
    """``eval.json`` -- an eval of datasets whose spec is ``dataset_kind``."""

    spec_kind: ClassVar[str] = "eval.spec"

    name: str
    #: The dataset spec this eval reads (``navigator.dataset``): a dataset's nested eval, else any
    #: eval declaring its kind, evaluates it.
    dataset_kind: str
    #: Which example roles a run covers by default.
    kinds: list[str] = Field(default_factory=lambda: ["eval"])
    #: The module beside ``eval.json`` that defines ``evaluate_example`` (and optionally ``aggregate``).
    entry: str = "eval.py"
    #: Names of the metrics ``aggregate()`` returns, in report order.
    metrics: list[str] = Field(default_factory=list)
    #: Row paths a report groups by (``data.group``, ``input.here.view``).
    slices: list[str] = Field(default_factory=list)
    #: Each metric in plain words, for someone who is not an engineer: what it counts, over which
    #: examples, and which way is good. A report or browser shows it as the metric's tooltip.
    explain: dict[str, str] = Field(default_factory=dict)
    description: str = ""


class ExampleEval(DataSpec):
    """One example, evaluated -- the standard row every eval answers."""

    spec_kind: ClassVar[str] = "eval.example"

    example_id: str = ""  # filled by the runner
    #: What the inference answered, as the dataset's output kind (JSON).
    prediction: Any = None
    golds: list[Any] = Field(default_factory=list)  # filled by the runner from the row
    verdict: Verdict
    score: Optional[float] = None
    latency_ms: float = 0.0  # filled by the runner
    error: Optional[str] = None
    #: Eval-defined tags a report can filter on (``feasible=no``, ``did=/dock/x``).
    labels: dict[str, str] = Field(default_factory=dict)
    #: The row's value at each of the eval's slice paths (filled by the runner).
    slice: dict[str, str] = Field(default_factory=dict)
    #: A one-line view of the input, for the report (filled by the runner when the eval leaves it).
    title: str = ""


class EvalRun(DataSpec):
    """One run of an eval over a dataset."""

    spec_kind: ClassVar[str] = "eval.run"

    run_id: str
    dataset_id: str
    dataset_title: str = ""
    dataset_spec: str
    eval_name: str
    #: Hash of the eval's own files: a changed eval is a different eval.
    eval_digest: str
    #: Whatever else decides the result (the endpoint used, a map hash) -- from ``versions()``.
    versions: dict[str, str] = Field(default_factory=dict)
    started_at: str
    finished_at: str = ""
    examples: int = 0
    counts: dict[str, int] = Field(default_factory=dict)  # per verdict
    #: A count stays an int (``confident_wrong``); a ratio is a float -- a report tells them apart by type.
    metrics: dict[str, Optional[int | float]] = Field(default_factory=dict)
    #: ``{path: {value: {"examples": n, "correct": n, ...counts, ...metrics}}}``.
    slices: dict[str, Any] = Field(default_factory=dict)

    def count_metrics(self) -> list[str]:
        """The metrics that are counts -- read from the type here, because JSON loses it (``1.0`` and
        ``1`` read the same to a browser), so a report or browser is TOLD rather than guessing."""
        return sorted(k for k, v in self.metrics.items() if isinstance(v, int) and not isinstance(v, bool))


__all__ = ["EvalRun", "EvalSpec", "ExampleEval", "Verdict"]
