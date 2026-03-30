"""AnnotationRecord -- filesystem record for Annotation entities."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class AnnotationRecord(Record):
    _record_type: ClassVar[str] = RecordType.ANNOTATION
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["target_type", "labels"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.ANNOTATION)
        super().__init__(**kwargs)

    @property
    def search_content(self) -> str | None:
        parts: list[str] = []
        if self.name:
            parts.append(self.name)
        content = getattr(self, "content", None)
        if content:
            parts.append(str(content))
        return "\n".join(parts) if parts else None
