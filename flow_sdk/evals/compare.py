"""Two runs of one eval on one dataset, row by row: what a change fixed and what it broke.

A metric moves with the model's own noise; the rows that changed verdict are the evidence. Runs
are paired by row id, so only the rows both runs judged count.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.eval_spec import EvalRun, RowEval, Verdict


@dataclass
class Comparison:
    """``before`` → ``after``: the rows whose verdict changed, and each metric's delta."""

    fixed: list[RowEval] = field(default_factory=list)  # not correct before, correct now
    broken: list[RowEval] = field(default_factory=list)  # correct before, not now
    still_wrong: int = 0
    paired: int = 0
    unjudged: int = 0  # an error on either side: nothing was judged, so it neither fixed nor broke
    deltas: dict[str, Optional[float]] = field(default_factory=dict)


def compare(before: tuple[EvalRun, list[RowEval]], after: tuple[EvalRun, list[RowEval]]) -> Comparison:
    (run_a, rows_a), (run_b, rows_b) = before, after
    was = {e.row_id: e.verdict for e in rows_a}
    out = Comparison()
    for e in rows_b:
        if e.row_id not in was:
            continue
        if Verdict.ERROR in (was[e.row_id], e.verdict):
            out.unjudged += 1
            continue
        out.paired += 1
        right_before, right_now = was[e.row_id] == Verdict.CORRECT, e.verdict == Verdict.CORRECT
        if right_now and not right_before:
            out.fixed.append(e)
        elif right_before and not right_now:
            out.broken.append(e)
        elif not right_now:
            out.still_wrong += 1
    for name, value in run_b.metrics.items():
        old = run_a.metrics.get(name)
        out.deltas[name] = None if value is None or old is None else round(value - old, 4)
    return out


def previous(folder: Path, run: EvalRun) -> Optional[EvalRun]:
    """The last run before ``run`` of the same eval over the same row roles."""
    from flow_sdk.evals.store import runs  # noqa: PLC0415

    return next(
        (
            r
            for r in runs(folder)
            if r.run_id != run.run_id
            and r.eval_name == run.eval_name
            and r.kinds == run.kinds
            and r.started_at <= run.started_at
        ),
        None,
    )


__all__ = ["Comparison", "compare", "previous"]
