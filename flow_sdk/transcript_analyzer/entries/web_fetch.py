"""``WebFetchEntry`` — agent fetched a URL or ran a web search.

Claude ``WebFetch`` and ``WebSearch`` produce this. Codex's
``web_search_call`` response_item also folds here once the codex parser
dispatches it.
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class WebFetchEntry(TranscriptEntry):
    kind = EntryKind.WEB_FETCH

    def __init__(
        self,
        *,
        url: str | None = None,
        query: str | None = None,
        prompt: str | None = None,
        bytes_count: int | None = None,
        status_code: int | None = None,
        result_preview: str | None = None,
        tool_name: str = "",
        tool_use_id: str = "",
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.url = url
        self.query = query
        self.prompt = prompt
        self.bytes_count = bytes_count
        self.status_code = status_code
        self.result_preview = result_preview
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id

    def to_flow_data(self) -> list:
        return self._tool_flow_data(
            {"url": self.url, "query": self.query, "prompt": self.prompt},
            default_name="WebFetch",
            extra={"result": self.result_preview, "status_code": self.status_code},
        )

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "url": self.url,
            "query": self.query,
            "prompt": self.prompt,
            "bytes_count": self.bytes_count,
            "status_code": self.status_code,
            "result_preview": self.result_preview,
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = []
        if self.url:
            out.append(f"url: {self.url}")
        if self.query:
            out.append(f"query: {self.query}")
        if self.prompt:
            out.extend(render_block("prompt", self.prompt))
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        meta_parts: list[str] = []
        if self.status_code is not None:
            meta_parts.append(f"status={self.status_code}")
        if self.bytes_count is not None:
            meta_parts.append(f"bytes={self.bytes_count}")
        if meta_parts:
            out.append(" · ".join(meta_parts))
        if self.result_preview:
            out.extend(render_block("result", self.result_preview))
        return out
