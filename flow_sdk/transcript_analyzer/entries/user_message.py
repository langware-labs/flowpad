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

    def __init__(self, *, text: str, **base: Any) -> None:
        super().__init__(**base)
        self.text = text

    def to_flow_data(self) -> list[FlowData]:
        if not self.text:
            return []
        return [FlowData(
            flow_value=self.text,
            created_time=self.timestamp,
            attributes={
                "element-type": FlowElementType.USER_MESSAGE,
                "data-type": FlowDataType.TEXT,
                "role": "user",
            },
        )]

    def to_dict(self) -> dict:
        return {**super().to_dict(), "text": self.text}

    def _body_lines(self) -> list[str]:
        return render_block("text", self.text)
