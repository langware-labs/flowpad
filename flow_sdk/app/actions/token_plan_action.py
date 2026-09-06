"""``token_plan`` on the desk — a read-through to the hub's ``GET token_plan/me``.

The token plan (my / my team / my org budget) is hub state, composed on the
hub from ``llm_endpoint`` chains; the desk holds no rows to answer from. The
desk surfaces that read it — the harness modal's budget chip on a hub-managed
row, the hub-home card the desk also serves — call the same graph address the
hub serves (``/api/v1/graph/token_plan/me``), so the desk forwards it with the
box's hub login key. Status is PRESERVED (403 for a signed-out box, 0 for an
unreachable hub) so the UI can tell "no plan" from "broken".

Only ``me`` is proxied: the two ``setup`` POSTs are admin actions taken on the hub.
"""

from __future__ import annotations

import logging

from flow_sdk.cloud_client.transport.hub_http import HubError, hub_get_or_raise
from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

TOKEN_PLAN_TYPE = "token_plan"


@action.all(action_name=TOKEN_PLAN_TYPE, methods=["get"])
async def token_plan_action() -> ApiResponse:
    request_info = get_current_request_info()
    sub_path = (request_info.sub_path if request_info else "") or ""
    segments = [s for s in sub_path.strip("/").split("/") if s]
    if segments != ["me"]:
        return ApiFailResponse(message=f"unknown token_plan route: {sub_path or '/'}", status_code=404)
    return await token_plan_me()


async def token_plan_me() -> ApiResponse:
    """The signed-in hub user's plan, as the hub reports it."""
    try:
        plan = await hub_get_or_raise(TOKEN_PLAN_TYPE, action="me")
    except HubError as e:
        # 0 = no hub configured / transport failure; 401/403 = signed out or
        # not a human principal. Either way the plan cannot be read HERE.
        status = e.status_code if e.status_code else 503
        return ApiFailResponse(message=f"token plan unavailable: {e.reason}", status_code=status)
    return ApiSuccessResponse(data=plan)
