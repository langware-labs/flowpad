"""``ToolResultEntry`` — a user line carrying a tool result."""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class ToolResultEntry(TranscriptEntry):
    kind = EntryKind.TOOL_RESULT

    def __init__(
        self,
        *,
        tool_use_id: str,
        tool_output: str,
        is_error: bool = False,
        file_path: str | None = None,
        tool_name: str | None = None,
        duration_ms: int | None = None,
        exit_code: int | None = None,
        output_token_count: int | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.tool_use_id = tool_use_id
        self.tool_output = tool_output or ""
        self.is_error = is_error
        self.file_path = file_path
        # ``tool_name`` is set when known (codex synthesizes "shell" for
        # command_execution items; claude tool_results don't carry it inline
        # so it's None until cross-referenced with a preceding ToolUseEntry).
        self.tool_name = tool_name
        # Optional execution metadata — populated when the worker carries it
        # (codex preamble / event_msg.exec_command_end, claude
        # ``toolUseResult.durationMs``). Older transcripts leave these None.
        self.duration_ms = duration_ms
        self.exit_code = exit_code
        self.output_token_count = output_token_count

    def to_flow_data(self) -> list[FlowData]:
        attrs = {
            "element-type": FlowElementType.TOOL_RESULT,
            "data-type": FlowDataType.TEXT,
        }
        if self.tool_use_id:
            attrs["tool-use-id"] = self.tool_use_id
        if self.tool_name:
            attrs["tool-name"] = self.tool_name
        if self.is_error:
            attrs["is_error"] = "true"
        return [FlowData(
            flow_value=self.tool_output,
            created_time=self.timestamp,
            attributes=attrs,
        )]

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "tool_use_id": self.tool_use_id,
            "tool_output": self.tool_output,
            "is_error": self.is_error,
            "file_path": self.file_path,
            "tool_name": self.tool_name,
            "duration_ms": self.duration_ms,
            "exit_code": self.exit_code,
            "output_token_count": self.output_token_count,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"tool_use_id: {self.tool_use_id}"]
        if self.tool_name:
            out.append(f"tool_name: {self.tool_name}")
        if self.is_error:
            out.append("is_error: true")
        if self.file_path:
            out.append(f"file_path: {self.file_path}")
        meta_parts: list[str] = []
        if self.duration_ms is not None:
            secs = self.duration_ms / 1000.0
            meta_parts.append(f"duration: {secs:.1f}s")
        if self.exit_code is not None:
            meta_parts.append(f"exit: {self.exit_code}")
        if self.output_token_count is not None:
            meta_parts.append(f"tokens: {self.output_token_count}")
        if meta_parts:
            out.append(" · ".join(meta_parts))
        out.extend(render_block("tool_output", self.tool_output))
        return out
