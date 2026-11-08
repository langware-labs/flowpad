"""``/api/v1/it-session/*`` — the hub's door to IT Sessions on this box (``core/compute/it_session``).

- ``GET  status``  -> ``{on, signed_in}``
- ``POST setting {on}`` -> ``{on}`` (writes the IT Sessions preference)
- ``POST run {call_id, text, attachments, answer_shape, timeout_s}`` -> ``{answer, value}``; 409 ``{reason}``
  when IT Sessions is off or a person is signed in.

Only the hub's hop may call these: the request must carry the box's gate SECRET as the machine header, exactly
as ``/auth/revoke`` requires. A browser that passed the door holds a ticket or a grant cookie, never the raw
secret, so the box's own UI (and anyone who reached its public URL) is refused. A box with no gate armed (a
desktop) refuses everyone.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from flow_sdk.core.compute import it_session
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter(prefix="/api/v1/it-session")


def _ok(data: dict) -> JSONResponse:
    return JSONResponse(status_code=200, content=ApiSuccessResponse(data=data).model_dump(mode="json"))


def _fail(status_code: int, message: str, data: dict | None = None) -> JSONResponse:
    body = ApiFailResponse(message=message, status_code=status_code, data=data).model_dump(mode="json")
    return JSONResponse(status_code=status_code, content=body)


def from_hub(request: Request) -> bool:
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate  # noqa: PLC0415
    from flow_sdk.server.routes.auth import _carries_gate_secret  # noqa: PLC0415

    return _carries_gate_secret(request, get_cookie_gate())


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


@router.get("/status")
async def status(request: Request):
    if not from_hub(request):
        return _fail(403, "the hub's hop only")
    return _ok(it_session.status())


@router.post("/setting")
async def setting(request: Request):
    if not from_hub(request):
        return _fail(403, "the hub's hop only")
    on = (await _body(request)).get("on")
    if not isinstance(on, bool):
        return _fail(400, "on: true or false")
    return _ok({"on": it_session.set_it_sessions(on)})


@router.post("/run")
async def run(request: Request):
    if not from_hub(request):
        return _fail(403, "the hub's hop only")
    body = await _body(request)
    call_id, text = str(body.get("call_id") or ""), str(body.get("text") or "")
    if not call_id or not text.strip():
        return _fail(400, "call_id and text are required")
    shape = body.get("answer_shape")
    if shape is not None and not isinstance(shape, dict):
        return _fail(400, "answer_shape: an object or null")
    attachments = body.get("attachments") or []
    if not isinstance(attachments, list):
        return _fail(400, "attachments: a list of {name, content_b64}")
    reason = it_session.refusal()
    if reason is not None:
        return _fail(409, f"IT session refused: {reason}", {"reason": reason})
    try:
        timeout_s = float(body.get("timeout_s") or it_session.DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        return _fail(400, "timeout_s: a number of seconds")
    answer = await it_session.run_it_session(
        call_id=call_id, text=text, attachments=attachments, answer_shape=shape, timeout_s=timeout_s
    )
    return _ok(answer.as_data())
