"""``FileEditEntry`` — agent edited a file in place.

Both Claude (``Edit`` / ``MultiEdit`` / ``NotebookEdit``) and Codex
(``apply_patch *** Update File``) produce this.
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class FileEditEntry(TranscriptEntry):
    kind = EntryKind.FILE_EDIT

    def __init__(
        self,
        *,
        path: str,
        hunks: list[dict] | None = None,
        change_summary: str | None = None,
        tool_name: str = "",
        tool_use_id: str = "",
        is_error: bool = False,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.path = path
        self.hunks = hunks or []
        self.change_summary = change_summary
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id
        # Set when the paired tool result reported failure (folded in by
        # ``AgentTranscriptFile._fold_tool_results``). Declared so the error
        # state survives ``to_dict`` serialization.
        self.is_error = is_error

    def to_flow_data(self) -> list:
        return self._tool_flow_data(
            {"file_path": self.path, "edits": self.hunks},
            default_name="Edit",
            extra={"change_summary": self.change_summary},
        )

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "path": self.path,
            "hunks": self.hunks,
            "change_summary": self.change_summary,
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
        if self.hunks:
            out.append(f"hunks: {len(self.hunks)}")
            out.extend(render_block("hunk_data", self.hunks))
        if self.change_summary:
            out.extend(render_block("change_summary", self.change_summary))
        return out
