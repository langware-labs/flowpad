"""Activity progress over HTTP — the same sentence as the CLI: path, then verb.

``POST /api/v1/activity/{path}/{verb}`` is how TypeScript, an agent and any other
process report into the one mechanism that Python producers reach through
``Activity.get(...)``. There is deliberately no separate create call: a verb on an
address that nobody has touched creates it, because find-or-create is the whole
addressing model and a two-step start would let a producer forget the first step.

Verbs are accepted in either spelling — ``inc_success`` from Python and the API's own
conventions, ``incSuccess`` from the TypeScript side, ``inc-success`` from a shell. One
vocabulary, spelled the way each caller's language spells things.

Every response is the resulting snapshot in the standard ``ApiResponse`` envelope, so
``apiClient`` can call it and no frontend ever needs ``fetch`` or a hand-built URL.

Refusals come back as HTTP 200 carrying an ``error_code``, the convention
``routes/display.py`` spells out: ``ApiFailResponse.status_code`` is a BODY field, so a
bare return serialises as 200 anyway, and a caller mapping exit codes off the transport
status would collapse every distinct refusal into one.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from fastapi import APIRouter, Body, Query
from pydantic import BaseModel

from flow_sdk.activity import Activity, canonical_verb, monitor
from flow_sdk.responses import ApiFailResponse, ApiResponse

logger = logging.getLogger(__name__)
router = APIRouter()


def _fail(error_code: str, message: str) -> ApiFailResponse:
    """A refusal the CLI and the TS client can branch on by ``error_code``."""
    return ApiFailResponse(message=message, data={"error_code": error_code})


def _scope(raw: Optional[str]) -> Optional[str]:
    """Empty is absent. A query string cannot carry ``None``, so a caller that always
    serialises the parameter sends ``scope=`` — which must mean the instance-wide scope,
    not an activity in a scope literally named ""."""
    return raw or None


class VerbBody(BaseModel):
    """Arguments for any verb. Every field is optional because one body shape serves
    every verb — the verb in the URL says which fields it reads, and a field it does not
    read is ignored rather than rejected, so a caller can send a uniform payload."""

    model_config = {"extra": "ignore"}

    value: Any = None
    n: int = 1
    message: Optional[str] = None
    ref: Optional[str] = None
    code: Optional[str] = None
    counter: Optional[str] = None
    scope: Optional[str] = None


def _message(body: VerbBody) -> "Optional[str]":
    """The human sentence a lifecycle verb carries, however the caller spelled it."""
    if body.message is not None:
        return body.message
    return None if body.value is None else str(body.value)


#: verb -> what it does to a node. Built once at import: a table rebuilt per request
#: allocates sixteen closures to call one of them. It is also the ONLY list of verbs —
#: a separate tuple of names beside it is a second thing to keep in step.
VERB_TABLE: "dict[str, Callable[[Activity, VerbBody], None]]" = {
    "label": lambda act, body: act.label(_message(body)),
    "icon": lambda act, body: act.icon(body.value),
    "total": lambda act, body: act.total(None if body.value is None else int(body.value)),
    "current": lambda act, body: act.current(None if body.value is None else str(body.value)),
    "message": lambda act, body: act.message(_message(body)),
    "inc_success": lambda act, body: act.inc_success(int(body.value) if body.value is not None else body.n),
    "inc_skipped": lambda act, body: act.inc_skipped(int(body.value) if body.value is not None else body.n),
    "inc_error": lambda act, body: act.inc_error(
        _message(body) or "error", ref=body.ref, code=body.code, n=body.n
    ),
    "inc": lambda act, body: act.inc(str(body.counter or body.value), body.n),
    "set_counter": lambda act, body: act.set_counter(str(body.counter or ""), int(body.value or 0)),
    "block": lambda act, body: act.block(_message(body)),
    "pause": lambda act, body: act.pause(_message(body)),
    "resume": lambda act, _body: act.resume(),
    "done": lambda act, body: act.done(_message(body)),
    "fail": lambda act, body: act.fail(_message(body)),
    "cancel": lambda act, body: act.cancel(_message(body)),
    "reset": lambda act, _body: act.reset(),
}


@router.get("/api/v1/activity")
async def list_activities(
    scope: Optional[str] = Query(default=None),
    all_scopes: bool = Query(default=False, alias="all"),
):
    """Live roots. This is the replay a client uses on connect and after a WS gap.

    Only live work is here: a completed root is gone, which is the monitor being honest
    about what it tracks rather than a hole in the API.

    Specs are dumped explicitly: ``ApiResponse.success`` unwraps a single ``BaseModel``
    but leaves a LIST of them alone, and the envelope's unparametrised ``data: T`` then
    validates the whole list away to ``null``.
    """
    rows = monitor.list(scope=_scope(scope), all_scopes=all_scopes)
    return ApiResponse.success([spec.model_dump(mode="json") for spec in rows])


@router.get("/api/v1/activity/{path:path}")
async def get_activity(path: str, scope: Optional[str] = Query(default=None)):
    """One tree, children included, or a ``NOT_LIVE`` refusal once it is gone."""
    spec = monitor.get(path, scope=_scope(scope))
    if spec is None:
        return _fail("NOT_LIVE", f"no live activity at {path!r}")
    return ApiResponse.success(spec.model_dump(mode="json"))


@router.post("/api/v1/activity/{path:path}/{verb}")
async def report(path: str, verb: str, body: VerbBody = Body(default=VerbBody())):
    """Apply one verb to the node at ``path``, creating it if this is its first touch."""
    apply = VERB_TABLE.get(canonical_verb(verb))
    if apply is None:
        return _fail(
            "UNKNOWN_VERB", f"unknown activity verb {verb!r}; expected one of {', '.join(VERB_TABLE)}"
        )
    try:
        act = Activity.get(path, scope=_scope(body.scope))
    except ValueError as exc:  # empty path, or past the depth cap
        return _fail("BAD_PATH", str(exc))

    try:
        apply(act, body)
    except (TypeError, ValueError) as exc:
        return _fail("BAD_ARGUMENT", f"bad argument for {verb!r}: {exc}")

    return ApiResponse.success(act.spec().model_dump(mode="json"))
