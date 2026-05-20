"""GET /api/v1/graph/conversation/<id>/open — deep-link handler.

Hit by the hub's ConversationLanding page when the user clicks "Open in
FlowPad". The conversation typically isn't on the recipient's local DB yet
(they just accepted the invitation seconds ago), so this handler doesn't
require the local row to exist — the request-transaction middleware lets
``open`` through with ``target_entity=None`` and we redirect into the UI
deep-link, which then triggers the normal hub-sync path.
"""
from __future__ import annotations

import logging

from flow_sdk.actions import action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse

logger = logging.getLogger(__name__)


@action.get(action_name="open", types=[BuiltinEntityType.CONVERSATION.value])
async def open_conversation() -> ApiResponse:
    """Redirect into the UI's HomeLanding with ``action=open&conversation_id=<id>``."""
    from flow_sdk.server.routes.notify import handle_notification_deep_link

    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        conv_id = str(request_info.target_entity_typeid.id)
        return await handle_notification_deep_link(fm_id="", conversation_id=conv_id)
    except Exception as e:
        logger.error("[conversation_action] open error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Open failed: {str(e)}")
