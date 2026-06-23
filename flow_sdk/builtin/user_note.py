from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class UserNote(Entity):
    type: str = APIField(default="user_note")
    content: str = APIField("")

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "StickyNote"

    @property
    def display_name(self) -> str:
        if self.content:
            first_line = str(self.content).strip().splitlines()[0][:100]
            if first_line:
                return first_line
        return self.name or ""
