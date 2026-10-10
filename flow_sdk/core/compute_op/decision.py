"""A ``decision`` op, asked: one Decision API call, judged against the op's requirements.

The op says WHAT must be true of a value (``DecisionOp.questions`` / ``require``); this module
puts the questions to the API once and reads the answers back into a ``DecisionVerdict``.
It knows nothing about what the value is — a message, a task, a line of text — and nothing
about who asked.

A verdict is an answer, never a raise: an API that could not be reached is ``met=False`` with
``unavailable`` naming the closed reason, so a sequence treats it as "not now", not a crash.
"""

from __future__ import annotations

from typing import Any, Optional

from flow_sdk.schema.data_spec.compute_op_spec import DecisionOp, Require
from flow_sdk.schema.data_spec.decision_spec import (
    ChoiceAnswer,
    ChoiceQuestion,
    DecisionResult,
    DecisionSpec,
    ScoreAnswer,
    ScoreQuestion,
    YesNoAnswer,
)
from flow_sdk.schema.data_spec.returned_value_spec import DecisionVerdict


async def decide_op(op: DecisionOp, state: Any, *, endpoint: Optional[str] = None) -> DecisionVerdict:
    """Ask every question of ``state`` in one call and judge the answers. Never raises."""
    from flow_sdk.decision import DecisionError, decide  # noqa: PLC0415 — the hub client, behind the schema

    try:
        result = await decide(DecisionSpec(state=_plain(state), questions=op.questions), endpoint=endpoint)
    except DecisionError as exc:
        return DecisionVerdict.not_yet(
            f"could not decide: {exc.message}", ran=False, unavailable=exc.reason, confidence=0.0
        )
    return judge(op, result)


def judge(op: DecisionOp, result: DecisionResult) -> DecisionVerdict:
    """The verdict of answers already in hand: met iff EVERY requirement holds."""
    met = True
    confidence = 1.0
    reason = ""
    for name, req in op.require.items():
        answer = result.answers.get(name)
        if answer is None:
            return DecisionVerdict.not_yet(f"no answer came back for {name!r}", answers=_answers(result), confidence=0.0)
        held, sure, why = _holds(name, req, answer, op)
        confidence = min(confidence, sure)
        if not held:
            met = False
            reason = reason or why
    if met:
        reason = op.sentence or "every requirement held"
    make = DecisionVerdict.satisfied if met else DecisionVerdict.not_yet
    return make(
        reason,
        met=met,
        confidence=round(confidence, 4),
        reason=reason,
        answers=_answers(result),
        value=_value(op, result),
        endpoint=result.endpoint,
        latency_ms=result.latency_ms,
    )


def _holds(name: str, req: Require, answer: Any, op: DecisionOp) -> tuple[bool, float, str]:
    """Does one requirement hold, how sure is the answer of it, and if not, why not."""
    if req.choice is not None:
        if not isinstance(answer, ChoiceAnswer):
            return False, 0.0, f"{name} did not answer a choice"
        sure = answer.probabilities.get(req.choice, answer.confidence if answer.choice == req.choice else 0.0)
        if answer.choice != req.choice:
            return False, sure, f"{name} was {answer.choice!r}, needed {req.choice!r}"
        if answer.confidence < req.min:
            return False, sure, f"{name} was {answer.choice!r} at {answer.confidence:.2f}, needed {req.min:.2f}"
        return True, sure, ""
    if req.yes is not None or req.no is not None:
        if not isinstance(answer, YesNoAnswer):
            return False, 0.0, f"{name} did not answer yes or no"
        if req.yes is not None:
            return answer.probability >= req.yes, answer.probability, (
                "" if answer.probability >= req.yes else f"{name} was {answer.probability:.2f}, needed yes ≥ {req.yes:.2f}"
            )
        prob_no = 1.0 - answer.probability
        return prob_no >= req.no, prob_no, ("" if prob_no >= req.no else f"{name} was {prob_no:.2f}, needed no ≥ {req.no:.2f}")
    # at_least
    question = op.questions[name]
    if not isinstance(answer, ScoreAnswer) or not isinstance(question, ScoreQuestion):
        return False, 0.0, f"{name} did not answer a score"
    floor = question.levels.index(req.at_least)
    held = answer.score >= floor
    reached = question.levels[min(len(question.levels) - 1, max(0, int(round(answer.score))))]
    return held, answer.confidence, ("" if held else f"{name} was {reached!r}, needed at least {req.at_least!r}")


def _value(op: DecisionOp, result: DecisionResult) -> Any:
    """The plain answer(s) a later step binds: a choice's option, a score's level, yes/no as a bool."""
    plain: dict[str, Any] = {}
    for name, question in op.questions.items():
        answer = result.answers.get(name)
        if isinstance(answer, ChoiceAnswer) and isinstance(question, ChoiceQuestion):
            plain[name] = answer.choice
        elif isinstance(answer, ScoreAnswer) and isinstance(question, ScoreQuestion):
            plain[name] = question.levels[min(len(question.levels) - 1, max(0, int(round(answer.score))))]
        elif isinstance(answer, YesNoAnswer):
            plain[name] = answer.probability >= 0.5
    if len(plain) == 1:
        return next(iter(plain.values()))
    return plain or None


def _answers(result: DecisionResult) -> dict[str, Any]:
    return {name: answer.model_dump(mode="json") for name, answer in result.answers.items()}


def _plain(state: Any) -> Any:
    dump = getattr(state, "model_dump", None)
    return dump(mode="json", exclude_none=True) if callable(dump) else state
