"""``UserMessageEntry`` — a user prompt line."""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class UserMessageEntry(TranscriptEntry):
    kind = EntryKind.USER_MESSAGE

    def __init__(self, *, text: str, role: str = "user", is_meta: bool = False, **base: Any) -> None:
        super().__init__(**base)
        self.text = text
        # Always ``"user"`` for user-typed messages. Developer / system
        # role messages are routed to ``SystemEntry`` upstream — they do
        # not arrive here.
        self.role = role
        # ``isMeta`` user lines are framework-injected (skill bodies, command
        # expansions, system reminders) — not human text. The UI collapses
        # them to a chip instead of rendering them as a chat turn.
        self.is_meta = is_meta

    def to_flow_data(self) -> list[FlowData]:
        if not self.text:
            return []
        attributes = {
            "element-type": FlowElementType.USER_MESSAGE,
            "data-type": FlowDataType.TEXT,
            "role": self.role,
        }
        if self.is_meta:
            attributes["is-meta"] = "true"
        return [FlowData(
            flow_value=self.text,
            created_time=self.timestamp,
            attributes=attributes,
        )]

    def to_dict(self) -> dict:
        return {**super().to_dict(), "text": self.text, "role": self.role, "is_meta": self.is_meta}

    def _body_lines(self) -> list[str]:
        out: list[str] = []
        if self.role and self.role != "user":
            out.append(f"role: {self.role}")
        out.extend(render_block("text", self.text))
        return out
