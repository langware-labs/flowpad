"""``POST /api/v1/graph/conversation/<ticket or team conversation id>/steer {agent_id, text}`` — the hub's action,
answered here (``flow agent steer``, the desktop). Steering goes through the hub, never straight into a process on this
machine: the hub checks that the caller holds ``admin`` on the agent and is on the ticket's team conversation, writes
the steer message there (the source of the delivery, with its status) and relays it to the agent's machine, where the
box route (``server/routes/agent_steer.py``) runs the turn. Answers ``{message_id, status: sending}``, never the
agent's words. The id comes from the URL: the conversation need not be on this machine."""

from __future__ import annotations

from flow_sdk.actions.action_registry import action
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


@action.post(action_name="steer", types=["conversation"])
async def steer_ticket() -> ApiResponse:
    info = get_current_request_info()
    target = info.target_entity_typeid if info else None
    body = (await info.get_post_data() or {}) if info else {}
    agent_id = str(body.get("agent_id") or "").strip().removeprefix("agent-")
    text = str(body.get("text") or "").strip()
    if target is None or not agent_id or not text:
        return ApiFailResponse(message="steer: a conversation, agent_id and text are required", status_code=400)
    try:
        data = await HubProxy.call(
            "POST",
            BuiltinEntityType.CONVERSATION,
            str(target.id),
            "steer",
            payload={"agent_id": agent_id, "text": text},
            strict=True,
        )
    except HubError as e:
        return e.fail_response("The hub refused the steer")
    return ApiSuccessResponse(data=data)
