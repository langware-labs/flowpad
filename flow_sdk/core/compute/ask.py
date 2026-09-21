"""Asking a person for a value, and waiting a bounded time for the answer.

One pending question at a time per id, held in memory with an
``asyncio.Future``. The answer arrives through an HTTP action and resolves the
future; nothing is persisted, because the whole wait is bounded and a restart
ends it either way.

**The wait is bounded, and that is the difference from a wizard.** A wizard's
ask does not block — it returns ``pending`` and releases its caller, and a
parked run waits for as long as the person likes. An op cannot do that: a
caller holding a `ReturnedValue` needs an answer or a reason, so the question
gets a deadline and the op answers ``NOT_YET`` when it passes.

**Same process, on purpose.** The future lives where ``run_op`` is running, so
the answer must reach that process — which means the backend, the one that
serves the action. An ask op invoked from a spawned worker has nowhere to
deliver the answer; that is a limitation of this design, not an oversight, and
it is stated here rather than discovered at three in the morning.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

#: How long a person gets to answer. A PRODUCT decision — the span someone is
#: given before an op stops waiting — not a budget widened to ride out a flake.
#: Callers take it as a default and may pass a shorter one; nothing raises it.
ASK_TIMEOUT_SECONDS = 60.0


class Cancelled(Exception):
    """The person declined to answer. Not a failure of the machine."""


@dataclass
class Question:
    """One value being asked for, and the shape it must satisfy."""

    id: str
    op_name: str
    prompt: str
    #: The op's declared ``output`` — the form a UI draws, and the shape the
    #: answer is held to. There is exactly one declaration; this is it.
    shape: Any = None
    _future: "asyncio.Future" = field(repr=False, default=None)  # type: ignore[assignment]

    def to_payload(self) -> dict:
        """What a UI needs to draw the field. Never the future."""
        return {"id": self.id, "op": self.op_name, "prompt": self.prompt, "shape": self.shape}


#: Questions waiting for an answer, by id. Empty between asks: a question is
#: removed the moment it is answered, cancelled or times out, so a stale id can
#: never be answered twice or resolve a future nobody is awaiting.
_PENDING: "dict[str, Question]" = {}


def open_question(op_name: str, prompt: str, shape: Any) -> Question:
    """Register a question and return it. The caller then awaits ``wait_for``."""
    question = Question(
        id=str(uuid.uuid4()), op_name=op_name, prompt=prompt, shape=shape,
        _future=asyncio.get_event_loop().create_future(),
    )
    _PENDING[question.id] = question
    return question


def pending(question_id: str) -> Optional[Question]:
    """The question with this id, or None once it is settled."""
    return _PENDING.get(question_id)


def open_questions() -> "list[Question]":
    """Every question currently waiting. The UI's list; also what a test reads."""
    return list(_PENDING.values())


def answer(question_id: str, value: Any) -> bool:
    """Deliver an answer. False when nothing is waiting under that id.

    The value is NOT validated here: validation belongs to the action, so a
    person who typed the wrong thing gets a correctable error instead of an op
    that failed on their behalf.
    """
    question = _PENDING.pop(question_id, None)
    if question is None or question._future.done():
        return False
    question._future.set_result(value)
    return True


def cancel(question_id: str) -> bool:
    """Decline to answer. False when nothing is waiting under that id."""
    question = _PENDING.pop(question_id, None)
    if question is None or question._future.done():
        return False
    question._future.set_exception(Cancelled())
    return True


async def wait_for(question: Question, *, timeout: float = ASK_TIMEOUT_SECONDS) -> Any:
    """The answer, or ``TimeoutError``/``Cancelled``.

    The question is forgotten on every exit, so a late answer to a question
    nobody is waiting for is refused rather than silently dropped into a future
    that has already been abandoned.
    """
    try:
        return await asyncio.wait_for(asyncio.shield(question._future), timeout)
    finally:
        _PENDING.pop(question.id, None)
