"""The JSON object body of the current action request — one reading, shared by
every entity action that takes a body (``AgenticProcess``, ``Dataset``, …)."""

from __future__ import annotations

from typing import Any

from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse


def current_user_id() -> str:
    """Who is acting — the repo's ``someone_typeid`` (a user OR a visitor), as a
    string; ``""`` outside a request."""
    request_info = get_current_request_info()
    someone = request_info.someone_typeid if request_info else None
    return str(someone) if someone else ""


async def read_json_body(request_info: Any) -> dict | ApiFailResponse:
    """The body as a dict, or an ``ApiFailResponse`` the action can return as-is.

    The caller passes the request info it resolved: every module that owns
    actions already imports ``get_current_request_info`` (and its tests patch
    that import), so taking the resolver's RESULT keeps this a pure reader and
    leaves each module's test seam where the repo already puts it.
    """
    if not request_info:
        return ApiFailResponse(message="No request info")
    body = await request_info.get_post_data()
    if not isinstance(body, dict):
        return ApiFailResponse(message="Expected JSON object body")
    return body
