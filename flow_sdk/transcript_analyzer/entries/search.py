"""``SearchEntry`` — agent searched files (Glob / Grep / Find).

Claude ``Glob`` and ``Grep`` produce this. ``search_kind`` discriminates.
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class SearchEntry(TranscriptEntry):
    kind = EntryKind.SEARCH

    def __init__(
        self,
        *,
        search_kind: str,  # 'glob' | 'grep' | 'find'
        query: str,
        path: str | None = None,
        match_count: int | None = None,
        results_preview: str | None = None,
        tool_name: str = "",
        tool_use_id: str = "",
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.search_kind = search_kind
        self.query = query
        self.path = path
        self.match_count = match_count
        self.results_preview = results_preview
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id

    def to_flow_data(self) -> list:
        return self._tool_flow_data(
            {"query": self.query, "path": self.path},
            default_name="Search",
            extra={"results": self.results_preview},
        )

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "search_kind": self.search_kind,
            "query": self.query,
            "path": self.path,
            "match_count": self.match_count,
            "results_preview": self.results_preview,
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"search_kind: {self.search_kind}", f"query: {self.query}"]
        if self.path:
            out.append(f"path: {self.path}")
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        if self.match_count is not None:
            out.append(f"matches: {self.match_count}")
        if self.results_preview:
            out.extend(render_block("results", self.results_preview))
        return out
