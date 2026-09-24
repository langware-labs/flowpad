"""Asking a person for a value, and waiting a bounded time for the answer.

One pending question at a time per id, held in memory with an
``asyncio.Future``. The answer arrives through an HTTP action and resolves the
future; nothing is persisted, because the whole wait is bounded and a restart
ends it either way.

**The wait is bounded.** A caller holding a ``ReturnedValue`` needs an answer
or a reason, so the question gets a deadline — the op's, resolved by the role an
ask plays (``ASK_TIMEOUT_SECONDS`` in ``compute_op_spec``, beside the other four)
— and the op answers ``NOT_YET`` when it passes. Nothing here parks: there is no
form of this that waits for as long as a person likes.

**The question lives where answers arrive.** The future is held by the process
that serves the answer routes — the backend. ``run_op`` running there asks
directly (:func:`ask_person`). Anywhere else — a script, a spawned worker — it
hands the whole question to the backend (:func:`ask_through_backend`), which
raises it, waits the same bounded time and answers; the caller keeps its lease
on that backend for the length of the wait, so one it had to start is not
stopped under the person answering. Before this, an op asked from outside the
backend registered its question where no answer could reach it.
"""

from __future__ import annotations

import asyncio
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.returned_value_spec import AskResult


class Cancelled(Exception):
    """The person declined to answer. Not a failure of the machine."""


@dataclass
class Question:
    """One value being asked for, and the shape it must satisfy."""

    id: str
    op_name: str
    prompt: str
    #: The op's ``output_spec_kind`` — the kind the answer is held to. There is
    #: exactly one declaration; this is it.
    shape: Any = None
    #: That kind opened one level — what a form draws. Computed once, when the
    #: question is raised: it cannot change while the question is open.
    fields: Any = None
    #: The answer is a secret: whoever draws the field masks it, and nothing echoes it.
    secret: bool = False
    _future: "asyncio.Future" = field(repr=False, default=None)  # type: ignore[assignment]

    def to_payload(self) -> dict:
        """What a UI needs to draw the field. Never the future."""
        return {"id": self.id, "op": self.op_name, "prompt": self.prompt, "fields": self.fields, "secret": self.secret}


#: Whether THIS process serves the answer routes — set by the app that mounts
#: them. Only then can a future held here be resolved by an answer.
_SERVED_HERE = False


def serve_here() -> None:
    """Declare that answers arrive in this process (the backend mounting the routes)."""
    global _SERVED_HERE
    _SERVED_HERE = True


def served_here() -> bool:
    return _SERVED_HERE


@contextmanager
def answered_here():
    """For the length of the block, THIS process is where answers arrive — a CLI that answers its
    own questions on its terminal (``flow project setup``). Restored after, so nothing else run
    in the process later mistakes it for the backend."""
    global _SERVED_HERE
    prior, _SERVED_HERE = _SERVED_HERE, True
    try:
        yield
    finally:
        _SERVED_HERE = prior


#: Questions waiting for an answer, by id. Empty between asks: a question is
#: removed the moment it is answered, cancelled or times out, so a stale id can
#: never be answered twice or resolve a future nobody is awaiting.
_PENDING: "dict[str, Question]" = {}


def open_question(op_name: str, prompt: str, shape: Any, *, secret: bool = False) -> Question:
    """Register a question and return it. The caller then awaits ``wait_for``."""
    from flow_sdk.schema.data_spec.compute_op_spec import fields_of_kind  # noqa: PLC0415

    question = Question(
        id=str(uuid.uuid4()), op_name=op_name, prompt=prompt, shape=shape,
        # A kind string alone would render as one unnamed box.
        fields=fields_of_kind(shape) if isinstance(shape, str) else shape,
        secret=secret,
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


async def wait_for(question: Question, *, timeout: float) -> Any:
    """The answer, or ``TimeoutError``/``Cancelled``.

    ``timeout`` is required: the deadline is the OP's, resolved by its role and
    narrowed by its caller, and a default here would be a second opinion about
    how long a person gets.

    The question is forgotten on every exit, so a late answer to a question
    nobody is waiting for is refused rather than silently dropped into a future
    that has already been abandoned.
    """
    try:
        return await asyncio.wait_for(asyncio.shield(question._future), timeout)
    finally:
        _PENDING.pop(question.id, None)


async def ask_person(
    op_name: str, prompt: str, shape: Any, *, timeout: float, label: str, secret: bool = False
) -> "AskResult":
    """Raise one question here and answer with what the person did.

    A cancel and a timeout are both "no value" — ``NOT_YET`` — and differ in
    ``cancelled`` / ``timed_out``, which is what a caller branches on.
    """
    from flow_sdk.core.compute_op.ask_window import raise_question  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import AskResult  # noqa: PLC0415

    question = open_question(op_name, prompt, shape, secret=secret)
    await raise_question(question)
    try:
        value = await wait_for(question, timeout=timeout)
    except Cancelled:
        return AskResult.not_yet(f"{label}: cancelled.", cancelled=True)
    except TimeoutError:
        return AskResult.not_yet(f"{label}: no answer within {timeout:g}s.", timed_out=True)
    return AskResult.satisfied(f"{label}: answered.", value=value)


async def ask_through_backend(
    op_name: str, prompt: str, shape: Any, *, timeout: float, label: str, secret: bool = False
) -> "AskResult":
    """:func:`ask_person`, run by the backend for a process that is not it.

    One request for the whole wait: the backend's route owns the deadline (the
    same ``timeout``), so the client adds none of its own. The lease is held
    across it — a backend this call had to start stays up until the person has
    answered or the time is up.
    """
    from flow_sdk.core.connections.service import FlowServiceError, flow_service  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import AskResult  # noqa: PLC0415

    body = {"op": op_name, "prompt": prompt, "shape": shape, "timeout": timeout, "label": label, "secret": secret}
    try:
        async with flow_service() as lease:
            said = await lease.client.request("POST", "/api/v1/ask", json=body)
    except FlowServiceError as exc:
        return AskResult.not_yet(f"{label}: no Flowpad backend to ask through — {exc.detail}", ran=False)
    if not said.success or not isinstance(said.data, dict):
        return AskResult.not_yet(f"{label}: the backend did not ask — {said.message or said.status}", ran=False)
    return AskResult.model_validate(said.data)
