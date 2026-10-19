"""Jev (TypeSafe) dialect: our ``DecisionSpec`` to its wire, its answers back to ours.

Jev's words (``criteria``, ``noul``) stop at this file. ``POST v1/systemone`` takes
``{model, state, questions}``; a score answer keys its probabilities by level INDEX and
ships a ``legend`` from index to level text, which we fold back so ours are keyed by the
level the caller wrote.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.decision.errors import DecisionError
from flow_sdk.schema.data_spec.decision_spec import (
    ChoiceAnswer,
    ChoiceQuestion,
    DecisionResult,
    DecisionSpec,
    DecisionUsage,
    ScoreAnswer,
    ScoreQuestion,
    YesNoAnswer,
)

PATH = "v1/systemone"
DEFAULT_MODEL = "jev-latest"
HOSTS = ("api.typesafe.ai",)


def to_wire(spec: DecisionSpec) -> dict[str, Any]:
    questions: dict[str, Any] = {}
    for name, q in spec.questions.items():
        if isinstance(q, ChoiceQuestion):
            questions[name] = {"type": "choice", "instructions": q.instructions, "criteria": dict(q.options)}
        elif isinstance(q, ScoreQuestion):
            questions[name] = {"type": "score", "instructions": q.instructions, "criteria": list(q.levels)}
        else:
            questions[name] = {"type": "noul", "instructions": q.instructions}
    return {"model": spec.model or DEFAULT_MODEL, "state": spec.state, "questions": questions}


def from_wire(spec: DecisionSpec, body: Any) -> DecisionResult:
    if not isinstance(body, dict) or not isinstance(body.get("answers"), dict):
        raise DecisionError("bad_response", f"Jev answered without `answers`: {str(body)[:200]}")
    answers: dict[str, Any] = {}
    for name, question in spec.questions.items():
        raw = body["answers"].get(name)
        if not isinstance(raw, dict):
            raise DecisionError("bad_response", f"Jev did not answer question {name!r}")
        try:
            if isinstance(question, ChoiceQuestion):
                answers[name] = ChoiceAnswer(
                    choice=raw["choice"],
                    confidence=float(raw.get("confidence", raw.get("probabilities", {}).get(raw["choice"], 0.0))),
                    probabilities={k: float(v) for k, v in (raw.get("probabilities") or {}).items()},
                )
            elif isinstance(question, ScoreQuestion):
                legend = raw.get("legend") or {str(i): level for i, level in enumerate(question.levels)}
                answers[name] = ScoreAnswer(
                    score=float(raw["score"]),
                    confidence=float(raw.get("confidence", 0.0)),
                    probabilities={legend.get(k, k): float(v) for k, v in (raw.get("probabilities") or {}).items()},
                )
            else:
                answers[name] = YesNoAnswer(probability=float(raw["noul"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise DecisionError("bad_response", f"Jev's answer to {name!r} is malformed: {exc}") from exc
    usage = body.get("usage") or {}
    return DecisionResult(
        answers=answers,
        model=str(body.get("model") or ""),
        usage=DecisionUsage(
            input_tokens=int(usage.get("input_tokens") or 0), output_tokens=int(usage.get("output_tokens") or 0)
        ),
    )
