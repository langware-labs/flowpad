"""APU — compatibility factory endpoint for agentic_processor creation."""

from __future__ import annotations

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiSuccessResponse

from flow_sdk.builtin.agentic_process.agentic_processor import AgenticProcessor


class APU(Entity):
    """Compatibility factory endpoint used by API tests.

    POST /graph/apu creates an `agentic_processor` and returns `{type:'apu', id}`.
    """

    _api_visible = True
    type: str = APIField(default="apu")

    @action.post(action_name="create")
    async def create(cls):
        request_info = get_current_request_info()
        owner = request_info.someone_typeid if request_info else None

        processor = AgenticProcessor()
        await processor.save(owner)
        return ApiSuccessResponse(data={"type": "apu", "id": processor.id})
