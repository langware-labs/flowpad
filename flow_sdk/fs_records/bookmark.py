"""Bookmark record type for session bookmarks, notes, and context snapshots."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class BookmarkRecord(Record):
    """A bookmark record backed by Record."""

    _record_type: ClassVar[str] = RecordType.BOOKMARK
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["tags", "summary"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.BOOKMARK)
        kwargs.setdefault("status", "open")
        super().__init__(**kwargs)

    @property
    def search_content(self) -> str | None:
        parts: list[str] = []
        if self.name:
            parts.append(self.name)
        body = getattr(self, "body", None) or getattr(self, "content", None)
        if body:
            parts.append(str(body))
        return "\n".join(parts) if parts else None
