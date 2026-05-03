"""``AssistantMessageEntry`` — an assistant text/thinking line (no tool_use)."""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

from ..entry import EntryKind, TranscriptEntry


class AssistantMessageEntry(TranscriptEntry):
    kind = EntryKind.ASSISTANT_MESSAGE

    def __init__(
        self,
        *,
        text: str,
        thinking: str | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.text = text
        self.thinking = thinking

    def to_flow_data(self) -> list[FlowData]:
        out: list[FlowData] = []
        if self.thinking:
            out.append(FlowData(
                flow_value=self.thinking,
                created_time=self.timestamp,
                attributes={
                    "element-type": FlowElementType.REASONING,
                    "data-type": FlowDataType.TEXT,
                    "role": "assistant",
                },
            ))
        if self.text:
            out.append(FlowData(
                flow_value=self.text,
                created_time=self.timestamp,
                attributes={
                    "element-type": FlowElementType.CHAT,
                    "data-type": FlowDataType.TEXT,
                    "role": "assistant",
                },
            ))
        return out
