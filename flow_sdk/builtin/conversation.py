from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class Conversation(Entity):
    """A conversation composed into a Task (or other parent entity).

    messages is a JSON-encoded array of message objects:
      [{"role": "sender"|"recipient"|"bot", "content": "...", "sender_id": "...", "timestamp": "ISO"}, ...]

    The source of truth is conversation.jsonl on disk (pointed to by data_path).
    The messages field is kept in sync and is the API-visible copy.
    """

    type: str = APIField(default="conversation")
    task_id: Optional[str] = APIField(None)
    data_path: Optional[str] = APIField(None)
    message_count: int = APIField(0)
    messages: Optional[str] = APIField(None, blob=True)
    _api_visible: ClassVar[bool] = True
