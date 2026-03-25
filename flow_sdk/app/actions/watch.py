"""Watch action for real-time entity updates.

Simplified for minihub: uses in-memory tracking instead of database relationships.
"""

from starlette.requests import Request

from flow_sdk.actions import action
from flow_sdk.app.actions.watch_registry import create_watch, delete_watch, get_watches
from flow_sdk.request_context import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse


@action.all()
async def watch(request: Request):
    """Watch or list watches for an entity."""
    request_info = get_current_request_info()
    if request_info.target_entity_typeid is None:
        return ApiFailResponse(message="target not available")

    if request.method.lower() == "post":
        body = await request_info.get_post_data()
        if not isinstance(body, dict):
            return ApiFailResponse(message="connection_id is required, empty body provided")

        connection_id = body.get("connection_id")
        if not connection_id:
            return ApiFailResponse(message="connection_id is required")

        return await create_watch(connection_id, request_info.target_entity_typeid)

    if request.method.lower() == "get":
        return await get_watches(request_info.target_entity_typeid)

    return ApiFailResponse(message=f"method not supported:{request.method}")


@action.post()
async def unwatch(connection_id: str):
    """Stop watching an entity."""
    request_info = get_current_request_info()
    if request_info is None or request_info.target_entity_typeid is None:
        return ApiFailResponse(message="target not available")

    return await delete_watch(connection_id, request_info.target_entity_typeid)
