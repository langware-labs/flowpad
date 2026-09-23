"""Asking a person for a value, and waiting for the answer.

One pending question at a time per id, held in memory with an
``asyncio.Future``. The answer arrives through an HTTP action and resolves the
future; nothing is persisted, because a restart ends the wait either way — the
future, and whatever awaits it, both live in this process and die with it.

**The wait is USUALLY bounded, and that is the difference from a wizard.** A
wizard's ask does not block — it returns ``pending`` and releases its caller,
and a parked run waits for as long as the person likes. An op cannot normally
do that: a caller holding a `ReturnedValue` needs an answer or a reason, so
the question gets a deadline and the op answers ``NOT_YET`` when it passes.
The one exception is an op declared ``until_answered`` (`compute_op_spec.py`)
— install-time infrastructure the app cannot proceed without — which waits
with NO deadline, on the same terms a wizard's own parked run does: forever,
until answered, cancelled, or the process restarts.

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

#: Defined beside the op's other timeouts; re-exported here where the waiter lives.
from flow_sdk.schema.data_spec.compute_op_spec import ASK_TIMEOUT_SECONDS  # noqa: E402


class Cancelled(Exception):
    """The person declined to answer. Not a failure of the machine."""


@dataclass
class Question:
    """One value being asked for, and the shape it must satisfy."""

    id: str
    op_name: str
    prompt: str
    #: A plain-language paragraph shown under the prompt (`AskOp.detail`).
    detail: str = ""
    #: The op's ``output_spec_kind`` — the kind the answer is held to. There is
    #: exactly one declaration; this is it.
    shape: Any = None
    #: That kind opened one level — what a form draws. Computed once, when the
    #: question is raised: it cannot change while the question is open.
    fields: Any = None
    _future: "asyncio.Future" = field(repr=False, default=None)  # type: ignore[assignment]

    def to_payload(self) -> dict:
        """What a UI needs to draw the field. Never the future."""
        return {
            "id": self.id,
            "op": self.op_name,
            "prompt": self.prompt,
            "detail": self.detail,
            # The declared kind by NAME, when it is one. The window decides its
            # buttons from this — "confirm" is answered Yes / No — rather than
            # guessing from "there happen to be no fields".
            "kind": self.shape if isinstance(self.shape, str) else None,
            "fields": self.fields,
        }


#: Questions waiting for an answer, by id. Empty between asks: a question is
#: removed the moment it is answered, cancelled or times out, so a stale id can
#: never be answered twice or resolve a future nobody is awaiting.
_PENDING: "dict[str, Question]" = {}


def open_question(op_name: str, prompt: str, shape: Any, detail: str = "") -> Question:
    """Register a question and return it. The caller then awaits ``wait_for``."""
    from flow_sdk.schema.data_spec.compute_op_spec import fields_of_kind  # noqa: PLC0415

    question = Question(
        id=str(uuid.uuid4()),
        op_name=op_name,
        prompt=prompt,
        detail=detail,
        shape=shape,
        # A kind string alone would render as one unnamed box.
        fields=fields_of_kind(shape) if isinstance(shape, str) else shape,
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


def _settle(question_id: str, resolve) -> bool:
    """Hand one question its ending. False when nothing is waiting under that id.

    Both endings are the same three steps — take it out of the registry, refuse
    a second ending, resolve the future — and differ only in what they resolve
    it WITH. Keeping that in one place is why a settled question can never be
    settled twice by one path and not the other.
    """
    question = _PENDING.pop(question_id, None)
    if question is None or question._future.done():
        return False
    resolve(question._future)
    return True


def answer(question_id: str, value: Any) -> bool:
    """Deliver an answer.

    The value is NOT validated here: validation belongs to the action, so a
    person who typed the wrong thing gets a correctable error instead of an op
    that failed on their behalf.
    """
    return _settle(question_id, lambda future: future.set_result(value))


def cancel(question_id: str) -> bool:
    """Decline to answer. The op hears "no value", not "something broke"."""
    return _settle(question_id, lambda future: future.set_exception(Cancelled()))


def forget(question_id: str) -> None:
    """Drop a question nobody will wait for — one that was never shown."""
    _PENDING.pop(question_id, None)


async def wait_for(question: Question, *, timeout: Optional[float] = ASK_TIMEOUT_SECONDS) -> Any:
    """The answer, or ``TimeoutError``/``Cancelled``. ``timeout=None`` waits
    until the person answers or cancels.

    The question is forgotten on every exit, so a late answer to a question
    nobody is waiting for is refused rather than silently dropped into a future
    that has already been abandoned.
    """
    try:
        return await asyncio.wait_for(asyncio.shield(question._future), timeout)
    finally:
        _PENDING.pop(question.id, None)
