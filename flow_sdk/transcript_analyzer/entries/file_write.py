"""``FileWriteEntry`` — agent created or replaced a file.

Semantic entry kind. Both Claude (``Write``) and Codex (``apply_patch ***
Add File``) produce this. Replaces the worker-specific sniffing the
renderer used to do (``input.file_path`` vs. ``input.input``).
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class FileWriteEntry(TranscriptEntry):
    kind = EntryKind.FILE_WRITE

    def __init__(
        self,
        *,
        path: str,
        content: str | None = None,
        bytes_count: int | None = None,
        line_count: int | None = None,
        is_new: bool = True,
        tool_name: str = "",
        tool_use_id: str = "",
        is_error: bool = False,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.path = path
        self.content = content
        self.bytes_count = bytes_count
        self.line_count = line_count
        self.is_new = is_new
        # Worker-side tool name preserved for debugging / catch-all parity.
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id
        # Set when the paired tool result reported failure (folded in by
        # ``AgentTranscriptFile._fold_tool_results``). Declared so the error
        # state survives ``to_dict`` serialization.
        self.is_error = is_error

    def to_flow_data(self) -> list:
        return self._tool_flow_data(
            {"file_path": self.path, "content": self.content},
            default_name="Write",
        )

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "path": self.path,
            "content": self.content,
            "bytes_count": self.bytes_count,
            "line_count": self.line_count,
            "is_new": self.is_new,
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
            "is_error": self.is_error,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"path: {self.path}"]
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        if self.is_error:
            out.append("is_error: true")
        meta_parts: list[str] = []
        if self.line_count is not None:
            meta_parts.append(f"lines={self.line_count}")
        if self.bytes_count is not None:
            meta_parts.append(f"bytes={self.bytes_count}")
        if self.is_new:
            meta_parts.append("new=true")
        if meta_parts:
            out.append(" · ".join(meta_parts))
        if self.content:
            out.extend(render_block("content", self.content))
        return out
