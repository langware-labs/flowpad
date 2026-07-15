"""Desktop-notification action.

A generic ``desktop-notify`` action that fans a ``desktop_notify`` ``ui_command``
frame to every connected desktop window. The renderer turns that frame into an
OS-level notification (banner + badge + dock-bounce / taskbar-flash) via the
Electron shell bridge.

The same broadcast helper (``broadcast_ui_command``) is used by the inbound
FlowMessage trigger in ``flow_sdk/cloud_client/hub_bridge.py`` — so the automatic
message notification and any explicit frontend/agent call converge on one emit
path. New notification kinds only add a ``notify_type`` + ``info`` payload; no new
transport is needed.
"""

from starlette.requests import Request

from flow_sdk.actions import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse
from flow_sdk.server.routes.websocket import broadcast_ui_command


@action.all(action_name="desktop-notify", methods=["post"], types="all")
async def desktop_notify(request: Request) -> ApiResponse:
    """Broadcast a ``desktop_notify`` ui_command to all desktop windows.

    Body: ``{"type": <str>, "info": <payload>}`` where ``info`` is the GENERIC
    notification payload (see ``websocket.notify_desktop``):
    ``{title, body, icon?, click_target?, attention?}``. ``type`` is a tag
    ("message" | "process_complete" | …), never a rendering dispatch — the
    renderer draws every payload the same way.
    """
    request_info = get_current_request_info()
    body = (await request_info.get_post_data()) or {}
    notify_type = body.get("type") or "message"
    info = body.get("info") or {}

    await broadcast_ui_command("desktop_notify", notify_type=notify_type, info=info)
    return ApiSuccessResponse(data={"ok": True})
