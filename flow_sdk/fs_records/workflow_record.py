"""WorkflowRecord — a Record wrapping a markdown workflow file.

Files live at /<project>/workflows/<name>.md — human-readable names,
not UUIDs. The record's name is bootstrapped from the filename stem.
Content is indexed for full-text search.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class WorkflowRecord(Record):
    """A record backed by a markdown workflow file."""

    _record_type: ClassVar[str] = RecordType.WORKFLOW
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["name", "description"]

    def __init__(self, file_path: Path | str, **kwargs: Any):
        file_path = Path(file_path)
        kwargs.setdefault("type", RecordType.WORKFLOW)
        kwargs.setdefault("name", file_path.stem)
        super().__init__(**kwargs)
        # Use asset_ref instead of _file_path instance attr
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef(file_path))

    @property
    def file_path(self) -> Path:
        ar = self.asset_ref
        if ar is not None:
            return ar._path
        raise AttributeError("WorkflowRecord has no file_path set")

    @property
    def search_content(self) -> str | None:
        """Markdown content for FTS indexing."""
        ar = self.asset_ref
        if ar is not None and ar.exists():
            return ar.read()
        return None

    @classmethod
    def from_path(cls, path: Path | str) -> WorkflowRecord:
        """Load a WorkflowRecord from a .md file path."""
        return cls(file_path=path)
