"""``TodoUpdateEntry`` — agent updated its plan / todo list.

Claude ``TodoWrite`` produces this. Codex's ``update_plan`` event_msg can
fold here once the codex parser dispatches it.
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class TodoUpdateEntry(TranscriptEntry):
    kind = EntryKind.TODO_UPDATE

    def __init__(
        self,
        *,
        items: list[dict] | None = None,
        tool_name: str = "",
        tool_use_id: str = "",
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.items = items or []
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "items": self.items,
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"items: {len(self.items)}"]
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        if self.items:
            out.extend(render_block("todos", self.items))
        return out
