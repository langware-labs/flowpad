"""Desktop-notification action — the explicit (frontend / agent) emit entry.

The thin HTTP wrapper over the desktop notification service
(:func:`flow_sdk.notifications.notify_desktop_raw`). The automatic message /
invitation triggers call the same service directly, so every emit path — implicit
and explicit — converges on one normalized payload contract.
"""

from starlette.requests import Request

from flow_sdk.actions import action
from flow_sdk.notifications import notify_desktop_raw
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse


@action.all(action_name="desktop-notify", methods=["post"], types="all")
async def desktop_notify(request: Request) -> ApiResponse:
    """Show a desktop notification on every connected window.

    Body: ``{"type": <str>, "info": <payload>}`` where ``info`` is the generic
    notification payload ``{title, body, icon?, click_target?, attention?}``.
    ``type`` is a tag ("message" | "process_complete" | …), never a rendering
    dispatch — the renderer draws every payload the same way.
    """
    request_info = get_current_request_info()
    body = (await request_info.get_post_data()) or {}

    await notify_desktop_raw(body.get("type") or "message", body.get("info") or {})
    return ApiSuccessResponse(data={"ok": True})
