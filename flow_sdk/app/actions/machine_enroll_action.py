"""Local relay for the hub's ``machine-enroll`` action (``flow connect`` code approval).

The hub UI runs inside the desktop app, whose graph router only forwards
entity-bound calls to the hub. Approving a machine code has no local entity —
the enrollment lives on the hub — so this typeless action forwards
``lookup`` / ``approve`` / ``deny`` verbatim to the hub with the desktop's own
hub credentials and hands the hub's answer back untouched.
"""

from __future__ import annotations

from flow_sdk.actions import action
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.cloud_client.transport.hub_http import hub_base_url, hub_post
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

ALLOWED_OPS = ("lookup", "approve", "deny")


@action.post(action_name="machine-enroll", types=None)
async def machine_enroll():
    request_info = get_current_request_info()
    op = (request_info.sub_path or "").strip("/") if request_info else ""
    if op not in ALLOWED_OPS:
        return ApiFailResponse(message=f"unknown machine-enroll operation {op!r}", status_code=404)
    body = await request_info.get_post_data() if request_info else None
    if not isinstance(body, dict):
        return ApiFailResponse(message="Invalid body", status_code=400)
    if not hub_base_url():
        return ApiFailResponse(message="Sign in to the hub to approve machines", status_code=409)
    try:
        # ``hub_post`` owns the envelope, auth header and error translation — this
        # action exists only because the graph router reflects entity-bound calls
        # and an enrollment has no local entity to hang off.
        return ApiSuccessResponse(data=await hub_post("machine-enroll", body, action=op))
    except HubError as exc:
        return ApiFailResponse(message=exc.reason, status_code=exc.status_code or 502)
