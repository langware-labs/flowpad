"""Score a dataset's rows: does each produced ``output`` match one of its ``ground_truth`` answers?

Generic over every dataset shape, because the rule is about values, not about any one kind:

* **A gold field left empty constrains nothing.** A gold answer says what MUST be true; a run's
  output may carry more (a confidence, a reason) and a gold that leaves ``verb`` unset accepts
  any verb. So an output matches a gold when every field the gold sets is equal -- recursively.
* **Several golds mean any one is right** (``ground_truth-1/``, ``-2/``).
* A row with no gold, or no output, is counted but not scored.
"""

from __future__ import annotations

from typing import Any, Iterable

from flow_sdk.schema.data_spec.dataset_spec import ExampleSpec


def _plain(value: Any) -> Any:
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def matches(output: Any, gold: Any) -> bool:
    """Every field ``gold`` sets equals ``output``'s; a field the gold leaves None is free."""
    output, gold = _plain(output), _plain(gold)
    if isinstance(gold, dict):
        if not isinstance(output, dict):
            return False
        return all(v is None or matches(output.get(k), v) for k, v in gold.items())
    if isinstance(gold, list):
        return isinstance(output, list) and len(output) == len(gold) and all(map(matches, output, gold))
    return output == gold


def is_correct(row: ExampleSpec) -> bool | None:
    """True / False when the row has both an output and a gold; None when it cannot be scored."""
    if row.output is None or row.ground_truth is None:
        return None
    golds = row.ground_truth if isinstance(row.ground_truth, list) else [row.ground_truth]
    outputs = row.output if isinstance(row.output, list) else [row.output]
    return all(any(matches(out, gold) for gold in golds) for out in outputs)


def score(rows: Iterable[ExampleSpec]) -> dict:
    """``{rows, scored, correct, accuracy, wrong: [example ids]}``."""
    rows = list(rows)
    verdicts = [(row.id, is_correct(row)) for row in rows]
    scored = [(eid, ok) for eid, ok in verdicts if ok is not None]
    correct = sum(1 for _, ok in scored if ok)
    return {
        "rows": len(rows),
        "scored": len(scored),
        "correct": correct,
        "accuracy": round(correct / len(scored), 4) if scored else None,
        "wrong": [eid for eid, ok in scored if not ok],
    }


__all__ = ["is_correct", "matches", "score"]
