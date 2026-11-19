"""``/api/v1/agent-steer/*`` — the hub's door to steering a ticket's agent on this machine.

- ``POST run {agent_id, conversation_id, message_id, text}`` -> ``{status: ran|busy|failed|capped, detail}``; 409 when
  zero or more than one deployment here answers that ticket; 404 when the agent is unknown.

Only the hub's hop may call it (the box's gate secret as the machine header, as ``it_session`` requires). The answer is
a status: what the agent wrote never comes back this way.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from flow_sdk.builtin.agent_steer import SteerRefused, steer
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.steer_run_spec import SteerRun
from flow_sdk.server.routes.it_session import from_hub

router = APIRouter(prefix="/api/v1/agent-steer")


def _fail(status_code: int, message: str) -> JSONResponse:
    body = ApiFailResponse(message=message, status_code=status_code).model_dump(mode="json")
    return JSONResponse(status_code=status_code, content=body)


@router.post("/run")
async def run(request: Request):
    if not from_hub(request):
        return _fail(403, "the hub's hop only")
    try:
        body = await request.json()
        steer_run = SteerRun.model_validate(body if isinstance(body, dict) else {})
    except (ValueError, ValidationError):
        return _fail(400, "agent_id, conversation_id, message_id and text are required")
    if not steer_run.text.strip():
        return _fail(400, "text is required")
    try:
        outcome = await steer(steer_run)
    except SteerRefused as refused:
        return _fail(refused.status_code, str(refused))
    return JSONResponse(
        status_code=200, content=ApiSuccessResponse(data=outcome.model_dump(mode="json")).model_dump(mode="json")
    )
