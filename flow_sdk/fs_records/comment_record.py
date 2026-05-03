"""CommentRecord -- filesystem record for Comment entities."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class CommentRecord(Record):
    _record_type: ClassVar[str] = RecordType.COMMENT
    # Runtime-created via Record.save (not FS-scannable). Excluded from
    # the indexer's default set — entities still flow into the DB normally.
    _indexed_by_default: ClassVar[bool] = False
    index_fields: ClassVar[list[str]] = []

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.COMMENT)
        super().__init__(**kwargs)

    @property
    def search_content(self) -> str | None:
        content = getattr(self, "raw_content", None)
        if content:
            return str(content)
        return self.name or None
