"""Evaluate the navigator on a ``navigator.dataset``: run each row, score it, report the metrics.

The metrics are the ones the routing benchmark settled the design with:

* **precision** -- of the rows routed ``quick``, the share that opened a right target;
* **coverage** -- of the rows whose gold is ``quick``, the share fully right (target AND verb);
* **agentic recall** -- of the rows whose gold is ``agentic``, the share sent to the assistant;
* **confident-wrong** -- quick answers at >= ``MIN_CONFIDENCE`` that open the wrong thing: the
  failure the design exists to avoid.

Each row is run on ITS OWN recorded ``here`` and search candidates, so a run is judged on the
options the row was labelled against, not on whatever this machine's search finds today.
"""

from __future__ import annotations

import statistics
import time
from pathlib import Path
from typing import Any, Optional

from flow_sdk.core.navigator import MIN_CONFIDENCE, NavigatorRoute, route
from flow_sdk.datasets.score import golds, is_correct, matches, score

SHIPPED = Path(__file__).resolve().parents[1] / (
    "system_projects/flowpad_assistant/agentic-assets/dataset/smart-navigator"
)


def decision_of(answer: NavigatorRoute) -> dict:
    """A run's answer as a ``navigator.decision`` (its confidence kept; the reason is run detail)."""
    out: dict[str, Any] = {"route": answer.route, "confidence": answer.confidence}
    if answer.route == "quick" and answer.target is not None:
        out["target"] = answer.target.model_dump(mode="json")
        out["verb"] = answer.verb
    return out


def _expected_route(row: Any) -> Optional[str]:
    answers = golds(row)
    return answers[0].route if answers else None


def _target_ok(row: Any) -> bool:
    """The output opened a right target (its verb aside -- coverage is where the verb counts)."""
    opened = {"route": row.output.route, "target": row.output.target}
    return any(matches(opened, {"route": g.route, "target": g.target}) for g in golds(row))


def _pct(n: int, d: int) -> Optional[float]:
    return round(n / d, 4) if d else None


def metrics(rows: list) -> dict:
    """The routing metrics over rows that carry both a gold and an output."""
    scored = [r for r in rows if r.output is not None and golds(r)]
    quick_out = [r for r in scored if r.output.route == "quick"]
    quick_gold = [r for r in scored if _expected_route(r) == "quick"]
    agentic_gold = [r for r in scored if _expected_route(r) == "agentic"]
    totals = score(scored)
    return {
        "scored": totals["scored"],
        "correct": totals["correct"],
        "wrong": totals["wrong"],
        "precision": _pct(sum(1 for r in quick_out if _target_ok(r)), len(quick_out)),
        "coverage": _pct(sum(1 for r in quick_gold if is_correct(r)), len(quick_gold)),
        "agentic_recall": _pct(sum(1 for r in agentic_gold if r.output.route == "agentic"), len(agentic_gold)),
        "confident_wrong": sum(
            1 for r in quick_out if (r.output.confidence or 0) >= MIN_CONFIDENCE and not _target_ok(r)
        ),
    }


async def evaluate(dataset: Any) -> dict:
    """Run every ``eval`` row, score it, and return the metrics plus each row's output.

    Nothing is written: a shipped dataset is read-only, and a run's outputs are a report, not a
    label. ``latency_ms`` is end to end per row (a rule hit costs ~0, a decision a round trip).
    """
    rows = [r for r in dataset.read_rows() if r.kind.value == "eval"]
    out_type = dataset.output_shape
    timed, ran = [], []
    for row in rows:
        ctx = row.context.model_dump(mode="json") if row.context is not None else {}
        candidates = [c for c in (ctx.get("candidates") or []) if c.get("typeid")]
        started = time.perf_counter()
        here = row.input.here.model_dump(mode="json", exclude_none=True) if row.input.here else None
        answer = await route(row.input.utterance, here=here, candidates=candidates)
        timed.append((time.perf_counter() - started) * 1000)
        ran.append(row.model_copy(update={"output": out_type.model_validate(decision_of(answer))}))
    report = metrics(ran)
    report["latency_ms"] = {
        "p50": round(statistics.median(timed), 1) if timed else None,
        "p95": round(statistics.quantiles(timed, n=20)[-1], 1)
        if len(timed) > 1
        else (round(timed[0], 1) if timed else None),
    }
    report["outputs"] = {r.id: r.output.model_dump(mode="json") for r in ran}
    return report


__all__ = ["SHIPPED", "decision_of", "evaluate", "metrics"]
