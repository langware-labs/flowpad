"""``DecisionSpec`` / ``DecisionResult`` — a closed question asked of some state, as a value.

A decision does not generate text. It reads ``state`` and answers each named question from
the answers the question itself lists, with calibrated probabilities. That is what lets
code -- not a prompt -- own the control flow: route a ticket, gate an action, pick the
screen a typed request means.

**The words are ours, matched across the vendors.** Jev (TypeSafe) is the one public
contract; OpenAI's Decisions API announced "context", "pre-defined answers" and a
"confidence score" without a schema. So each term is the clearest of the three:

========================  ==============  =====================  =======================
ours                      Jev wire        OpenAI (announced)     why
========================  ==============  =====================  =======================
``state``                 ``state``       "context"              ``context`` is taken here
``choice`` + ``options``  ``criteria``    "options"              a list of answers
``score`` + ``levels``    ``criteria``    --                     an ordered scale's steps
``yes_no``                ``noul``        "yes/no"               plain English
``probability`` (of yes)  ``noul``        --                     the field says what it is
========================  ==============  =====================  =======================

The vendor's own words live only in its dialect (``external_apis/decision``); nothing above
that layer spells them.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, ClassVar, Literal, Optional, Union

from pydantic import Field, field_validator

from flow_sdk.schema.data_spec.spec import DataSpec

#: A question's name is an identifier: it is the key the answer comes back under.
_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_QUESTIONS = 6
MIN_LEVELS, MAX_LEVELS = 2, 10


# ── questions ────────────────────────────────────────────────────────────────


class ChoiceQuestion(DataSpec):
    """Pick ONE of ``options`` (key -> what it means). The key is what comes back."""

    spec_kind: ClassVar[str] = "decision.question.choice"

    type: Literal["choice"] = "choice"
    instructions: str
    options: dict[str, str]

    @field_validator("options")
    @classmethod
    def _two_or_more(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) < 2:
            raise ValueError("a choice needs at least 2 options")
        return v


class ScoreQuestion(DataSpec):
    """Place the state on an ordered scale: ``levels`` lowest first."""

    spec_kind: ClassVar[str] = "decision.question.score"

    type: Literal["score"] = "score"
    instructions: str
    levels: list[str]

    @field_validator("levels")
    @classmethod
    def _level_count(cls, v: list[str]) -> list[str]:
        if not MIN_LEVELS <= len(v) <= MAX_LEVELS:
            raise ValueError(f"a score needs {MIN_LEVELS}-{MAX_LEVELS} levels, got {len(v)}")
        return v


class YesNoQuestion(DataSpec):
    """A yes/no judgment; the answer is the probability of yes."""

    spec_kind: ClassVar[str] = "decision.question.yes_no"

    type: Literal["yes_no"] = "yes_no"
    instructions: str


Question = Annotated[Union[ChoiceQuestion, ScoreQuestion, YesNoQuestion], Field(discriminator="type")]


class DecisionSpec(DataSpec):
    """What to decide: ``state`` plus up to six named questions, asked in ONE request.

    ``state`` is a string, an object or a list -- a question refers to its fields by name
    in backticks (``"Is `ticket` about billing?"``). ``model`` pins a model version when the
    endpoint's default must not drift under a threshold you tuned.
    """

    spec_kind: ClassVar[str] = "decision.spec"

    state: Any
    questions: dict[str, Question]
    model: Optional[str] = None

    @field_validator("questions")
    @classmethod
    def _names_and_count(cls, v: dict[str, Any]) -> dict[str, Any]:
        if not 1 <= len(v) <= MAX_QUESTIONS:
            raise ValueError(f"a decision asks 1-{MAX_QUESTIONS} questions, got {len(v)}")
        bad = [name for name in v if not _NAME.match(name)]
        if bad:
            raise ValueError(f"question names must be lower-case identifiers: {bad}")
        return v


# ── answers ──────────────────────────────────────────────────────────────────


class ChoiceAnswer(DataSpec):
    spec_kind: ClassVar[str] = "decision.answer.choice"

    type: Literal["choice"] = "choice"
    choice: str
    confidence: float
    probabilities: dict[str, float] = {}


class ScoreAnswer(DataSpec):
    """``score`` is a fractional position on the scale (0 = first level);
    ``probabilities`` is keyed by the level's own text."""

    spec_kind: ClassVar[str] = "decision.answer.score"

    type: Literal["score"] = "score"
    score: float
    confidence: float
    probabilities: dict[str, float] = {}


class YesNoAnswer(DataSpec):
    spec_kind: ClassVar[str] = "decision.answer.yes_no"

    type: Literal["yes_no"] = "yes_no"
    probability: float


Answer = Annotated[Union[ChoiceAnswer, ScoreAnswer, YesNoAnswer], Field(discriminator="type")]


class DecisionUsage(DataSpec):
    input_tokens: int = 0
    output_tokens: int = 0


class DecisionResult(DataSpec):
    """One answer per question, plus what it cost and how long it took end to end."""

    spec_kind: ClassVar[str] = "decision.result"

    answers: dict[str, Answer]
    model: str = ""
    usage: DecisionUsage = DecisionUsage()
    latency_ms: float = 0.0
    #: The APIEndpoint that answered, as ``api_endpoint-<id>``.
    endpoint: str = ""

    def pick(self, name: str, *, min: float = 0.0) -> Optional[str]:  # noqa: A002 -- the snippet's word
        """The chosen option of choice question ``name`` when its confidence is at least
        ``min``; ``None`` when it is missing, unsure, or not a choice. Not being sure is an
        answer: the caller falls back, it does not act."""
        answer = self.answers.get(name)
        if not isinstance(answer, ChoiceAnswer) or answer.confidence < min:
            return None
        return answer.choice


class DecisionRun(DataSpec):
    """One decision as it happened -- what was asked, what came back, and what the caller needed in
    order to act -- so it can be read back and debugged as a whole, by anyone who decides."""

    spec_kind: ClassVar[str] = "decision.run"

    request: DecisionSpec
    #: Absent when the decision API failed.
    response: Optional[DecisionResult] = None
    #: Per question, the confidence its pick had to reach for the caller to act on it.
    act_at: dict[str, float] = {}
    #: What each part of ``request.state`` is (``context`` -> ``navigation.here``), so a viewer
    #: draws it by its kind instead of as raw JSON.
    state_kinds: dict[str, Any] = {}


__all__ = [
    "Answer",
    "ChoiceAnswer",
    "ChoiceQuestion",
    "DecisionResult",
    "DecisionRun",
    "DecisionSpec",
    "DecisionUsage",
    "Question",
    "ScoreAnswer",
    "ScoreQuestion",
    "YesNoAnswer",
    "YesNoQuestion",
]
