"""AnnotationRecord -- filesystem record for Annotation entities."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class AnnotationRecord(Record):
    _record_type: ClassVar[str] = RecordType.ANNOTATION
    # Runtime-created via Record.save (not FS-scannable). Excluded from
    # the indexer's default set — entities still flow into the DB normally.
    _indexed_by_default: ClassVar[bool] = False
    _browseable: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["target_type", "labels"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.ANNOTATION)
        super().__init__(**kwargs)

    @property
    def display_name(self) -> str:
        content = getattr(self, "content", None)
        if content:
            first_line = str(content).strip().splitlines()[0][:100]
            if first_line:
                return first_line
        return self.name or ""

    @property
    def search_content(self) -> str | None:
        parts: list[str] = []
        if self.name:
            parts.append(self.name)
        content = getattr(self, "content", None)
        if content:
            parts.append(str(content))
        return "\n".join(parts) if parts else None
