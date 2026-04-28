from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class Conversation(Entity):
    """A conversation composed into a Task (or other parent entity).

    message_ids is a JSON-encoded list of FlowMessage pointers:
      [{"message_id": uuid, "timestamp": "ISO"}, ...]

    Message content lives in individual FlowMessage records (fetched by id).
    The source of truth on disk is conversation.jsonl (pointer-index format).
    """

    type: str = APIField(default="conversation")
    task_id: Optional[str] = APIField(None)
    project_id: Optional[str] = APIField(None, description="ID of the parent project, or None when unscoped")
    data_path: Optional[str] = APIField(None)
    message_count: int = APIField(0)
    message_ids: Optional[str] = APIField(None)  # JSON-encoded [{"message_id": uuid, "timestamp": ISO}]
    _api_visible: ClassVar[bool] = True
