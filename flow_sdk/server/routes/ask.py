"""The question an op put to a person, and the answer coming back.

A pending question is not an entity — it lives for at most the span of one
bounded wait and is never written down — so it gets its own three routes rather
than actions on a row that would have to be addressed alongside it. The window
opens knowing one thing, the question id, and these routes are what it can do
with it.

The answer is validated HERE, against the shape the op declared, so a person who
typed the wrong thing gets a correctable 422 instead of an op that failed on
their behalf. Only a value that satisfies the declaration ever reaches the
waiting rung.
"""

from typing import Any, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from flow_sdk.core.compute.ask import answer as deliver_answer
from flow_sdk.core.compute.ask import cancel as decline
from flow_sdk.core.compute.ask import open_questions, pending
from flow_sdk.core.compute.declared_value import DeclaredShapeError, to_declared
from flow_sdk.responses.response import ApiSuccessResponse

router = APIRouter(prefix="/api/v1/ask")


def _fail(message: str, status_code: int) -> JSONResponse:
    """A failure that is a real HTTP status, carrying the standard envelope.

    ``ApiFailResponse`` is a pydantic MODEL: returned from a plain router it
    serializes as 200 with a FAIL body, because only the entity-action
    dispatcher reads its ``status_code``. A 422 arriving as a 200 is a 422 the
    browser never handles.
    """
    return JSONResponse(status_code=status_code,
                        content={"status": "FAIL", "message": message, "data": None})


class AnswerRequest(BaseModel):
    """What the person typed. ``value`` may be any JSON the shape accepts."""

    value: Any = None


@router.get("")
async def list_questions():
    """Every question waiting right now. Usually none, at most a handful."""
    return ApiSuccessResponse(data={"questions": [q.to_payload() for q in open_questions()]})


@router.get("/{question_id}")
async def read_question(question_id: str):
    """One question, or 404 once it is settled.

    A 404 is the normal end state, not an error: the op timed out, or somebody
    else answered. The window shows that rather than a spinner nobody will
    resolve.
    """
    question = pending(question_id)
    if question is None:
        return _fail("that question is no longer waiting", 404)
    return ApiSuccessResponse(data=question.to_payload())


@router.post("/{question_id}/answer")
async def answer_question(question_id: str, body: AnswerRequest):
    """Deliver an answer, once it satisfies the shape the op declared."""
    question = pending(question_id)
    if question is None:
        return _fail("that question is no longer waiting", 404)

    value: Optional[Any] = body.value
    if question.shape is not None:
        try:
            value = to_declared(value, question.shape)
        except DeclaredShapeError as mismatch:
            # 422, not 400: the request is well formed, the VALUE is not what
            # was asked for — and the person can fix it without reloading.
            return _fail(str(mismatch), 422)

    if not deliver_answer(question_id, value):
        return _fail("that question is no longer waiting", 404)
    return ApiSuccessResponse(data={"answered": question_id})


@router.post("/{question_id}/cancel")
async def cancel_question(question_id: str):
    """Decline. The op hears "no value", not "something broke"."""
    if not decline(question_id):
        return _fail("that question is no longer waiting", 404)
    return ApiSuccessResponse(data={"cancelled": question_id})
