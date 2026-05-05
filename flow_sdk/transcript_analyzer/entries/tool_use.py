"""``ToolUseEntry`` — an assistant invoking a tool."""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

from ..entry import EntryKind, TranscriptEntry


class ToolUseEntry(TranscriptEntry):
    kind = EntryKind.TOOL_USE

    def __init__(
        self,
        *,
        tool_name: str,
        tool_use_id: str,
        tool_input: dict,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id
        self.tool_input = tool_input or {}

    def to_flow_data(self) -> list[FlowData]:
        return [FlowData(
            flow_value={
                "tool_name": self.tool_name,
                "tool_use_id": self.tool_use_id,
                "input": self.tool_input,
            },
            created_time=self.timestamp,
            attributes={
                "element-type": FlowElementType.TOOL_CALL,
                "data-type": FlowDataType.OBJECT,
                "tool-name": self.tool_name,
            },
        )]

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
            "tool_input": self.tool_input,
        }
