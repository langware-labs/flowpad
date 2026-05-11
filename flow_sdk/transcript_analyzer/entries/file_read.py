"""``FileReadEntry`` — agent read a file.

Claude ``Read`` / ``NotebookRead`` produce this.
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class FileReadEntry(TranscriptEntry):
    kind = EntryKind.FILE_READ

    def __init__(
        self,
        *,
        path: str,
        start_line: int | None = None,
        end_line: int | None = None,
        bytes_count: int | None = None,
        content_preview: str | None = None,
        tool_name: str = "",
        tool_use_id: str = "",
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.path = path
        self.start_line = start_line
        self.end_line = end_line
        self.bytes_count = bytes_count
        self.content_preview = content_preview
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "path": self.path,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "bytes_count": self.bytes_count,
            "content_preview": self.content_preview,
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"path: {self.path}"]
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        meta_parts: list[str] = []
        if self.start_line is not None:
            meta_parts.append(f"start={self.start_line}")
        if self.end_line is not None:
            meta_parts.append(f"end={self.end_line}")
        if self.bytes_count is not None:
            meta_parts.append(f"bytes={self.bytes_count}")
        if meta_parts:
            out.append(" · ".join(meta_parts))
        if self.content_preview:
            out.extend(render_block("content", self.content_preview))
        return out
