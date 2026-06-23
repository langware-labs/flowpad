from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class MessageSuggest(Entity):
    type: str = APIField(default="message_suggest")
    text: str = APIField("")
    message_text: str = APIField("")
    conversation_id: Optional[str] = APIField(None)
    flow_message_id: Optional[str] = APIField(None)
    # Discriminates the feed-card variant. "" = diagnosis card (Report/Forward);
    # "draft_reply" = an executed-prompt draft waiting to send (Send/Open).
    kind: str = APIField("")

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "MessageSquare"

    @property
    def display_name(self) -> str:
        if self.text:
            return self.text.strip()
        return self.name or ""
