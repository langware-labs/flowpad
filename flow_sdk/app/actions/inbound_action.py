"""``inbound`` action — the desktop's door to the hub's webhook chain (the Inbound screen).

The hub's ``webhook`` entity owns every claim (a number, a sender, a group) and decides everything about it; a
desktop holds no copy. The Inbound screen on the hub page calls the hub directly; on the desktop it calls these,
and each one forwards verbatim to the one hub verb it names — nothing else:

  GET    data_source/inbound/mine              → hub GET    webhook/mine
  POST   data_source/inbound/chain             → hub POST   webhook/chain
  POST   data_source/inbound/<id>/set_target   → hub POST   webhook/<id>/set_target
  POST   data_source/inbound/<id>/probe        → hub POST   webhook/<id>/probe
  DELETE data_source/inbound/<id>              → hub DELETE webhook/<id>

and one local fact the screen needs to point a claim at THIS computer:

  GET    data_source/inbound/here              → {instance_id}: what a ``desktop`` target names

The hub's refusal (403, 404, 409 …) comes back with its own status and message.
"""

from __future__ import annotations

from typing import NamedTuple, Optional

from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

#: The verbs on one claim the screen may forward (POST ``<id>/<verb>``).
CLAIM_VERBS = ("set_target", "probe")
#: Sub-paths that are verbs, never a claim id.
RESERVED = ("mine", "chain", "here")


class HubCall(NamedTuple):
    """The one hub request a local ``inbound`` call stands for (``LOCAL``: answered here, nothing sent)."""

    method: str
    entity_id: Optional[str]
    action: Optional[str]


def hub_call(method: str, sub_path: str) -> Optional[HubCall]:
    """The hub ``webhook`` request for a local ``inbound/<sub_path>`` call, or None when it names none."""
    method = method.upper()
    parts = [p for p in (sub_path or "").strip("/").split("/") if p]
    if method == "GET" and parts == ["here"]:
        return HubCall("LOCAL", None, "here")
    if method == "GET" and parts == ["mine"]:
        return HubCall("GET", None, "mine")
    if method == "POST" and parts == ["chain"]:
        return HubCall("POST", None, "chain")
    if method == "POST" and len(parts) == 2 and parts[1] in CLAIM_VERBS and parts[0] not in RESERVED:
        return HubCall("POST", parts[0], parts[1])
    if method == "DELETE" and len(parts) == 1 and parts[0] not in RESERVED:
        return HubCall("DELETE", parts[0], None)
    return None


@action.all(action_name="inbound", methods=["get", "post", "delete"], types=["data_source"])
async def inbound_action() -> ApiResponse:
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_request  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")
    call = hub_call(request_info.request.method, request_info.sub_path or "")
    if call is None:
        return ApiFailResponse(message="no such inbound call", status_code=404)
    if call.method == "LOCAL":
        from flow_sdk.instance_settings.runtime import instance_uid  # noqa: PLC0415

        return ApiSuccessResponse(data={"instance_id": instance_uid()})
    payload = (await request_info.get_post_data() or {}) if call.method == "POST" else None
    if payload is not None and not isinstance(payload, dict):
        return ApiFailResponse(message="expected a JSON object", status_code=400)
    try:
        data = await hub_request(call.method, "webhook", call.entity_id, call.action, payload=payload)
    except HubError as e:
        status = e.status_code if e.status_code >= 400 else 502
        return ApiFailResponse(message=e.reason, status_code=status)
    return ApiSuccessResponse(data=data)
