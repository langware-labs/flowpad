"""Local relay for the hub's ``llm_endpoint/<id>/models`` action.

The hub UI runs inside the desktop app, whose graph router only forwards
entity-bound calls to the hub for an entity it holds a row for. A hub
``LLMEndpoint`` is a projection of hub state (``builtin/llm_endpoint.py``) — the
desk never stores one — so this action forwards the ``models`` read verbatim to
the hub with the desktop's own hub credentials and hands the hub's answer back
untouched. Same shape as ``machine_enroll_action``; entity-addressed rather than
typeless so the desk and the hub serve the read at one graph address.

Only ``models`` is relayed: every other endpoint action stays on the hub.
"""

from __future__ import annotations

from flow_sdk.actions import action
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.cloud_client.transport.hub_http import hub_base_url, hub_get_or_raise
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

LLM_ENDPOINT_TYPE = "llm_endpoint"


# ``allow_missing_target``: there is no local row to load, by design.
@action.get(action_name="models", types=[LLM_ENDPOINT_TYPE], allow_missing_target=True)
async def llm_endpoint_models():
    request_info = get_current_request_info()
    target = request_info.target_entity_typeid if request_info else None
    if target is None or not target.id:
        return ApiFailResponse(message="models requires an llm_endpoint id", status_code=400)
    if (request_info.method or "").upper() != "GET":
        return ApiFailResponse(message="models is read-only", status_code=405)
    if not hub_base_url():
        return ApiFailResponse(message="Sign in to the hub to list an endpoint's models", status_code=409)
    try:
        # ``hub_get_or_raise`` owns the envelope, auth header and error translation —
        # this action exists only because the endpoint has no local entity to reflect.
        return ApiSuccessResponse(data=await hub_get_or_raise(LLM_ENDPOINT_TYPE, str(target.id), action="models"))
    except HubError as exc:
        return ApiFailResponse(message=exc.reason, status_code=exc.status_code or 502)
