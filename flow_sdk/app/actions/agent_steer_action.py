"""``POST /api/v1/graph/conversation/<ticket id>/steer {agent_id, text, message_id?}`` — steer an agent's ticket from the
desktop (the same function the hub's box route runs). Answers ``{status, detail}``, never the agent's words."""

from __future__ import annotations

from fastapi import HTTPException

from flow_sdk.actions.action_registry import action
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent_steer import SteerRefused, steer
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.steer_run_spec import SteerRun


@action.post(action_name="steer", types=["conversation"])
async def steer_ticket(self: Entity):
    info = get_current_request_info()
    body = (await info.get_post_data() or {}) if info else {}
    agent_id = str(body.get("agent_id") or "").strip()
    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    try:
        outcome = await steer(
            SteerRun(
                agent_id=agent_id,
                conversation_id=str(self.id),
                message_id=str(body.get("message_id") or "") or mint_uuid(),
                text=text,
            )
        )
    except SteerRefused as refused:
        raise HTTPException(status_code=refused.status_code, detail=str(refused)) from refused
    return ApiSuccessResponse(data=outcome.model_dump(mode="json"))
