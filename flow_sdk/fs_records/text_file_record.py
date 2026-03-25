"""TextFileRecord -- a Record wrapping an arbitrary text file on disk."""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class TextFileRecord(Record):
    """A record backed by a plain text file.

    ``content()`` is async so call-sites can ``await output.content()``.
    """

    _record_type: ClassVar[str] = RecordType.TEXT_FILE

    def __init__(self, file_path: Path | str, **kwargs: Any):
        kwargs.setdefault("type", RecordType.TEXT_FILE)
        kwargs.setdefault("name", Path(file_path).name)
        super().__init__(**kwargs)
        # Use asset_ref instead of _file_path instance attr
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef(file_path))

    async def content(self) -> str:
        """Read and return the file contents."""
        ar = self.asset_ref
        if ar is not None:
            return ar.read()
        raise FileNotFoundError("TextFileRecord has no file_path set")

    @property
    def file_path(self) -> Path:
        ar = self.asset_ref
        if ar is not None:
            return ar._path
        raise AttributeError("TextFileRecord has no file_path set")

    @property
    def search_content(self) -> str | None:
        """Sync variant used internally (e.g. FTS indexing)."""
        ar = self.asset_ref
        if ar is not None and ar.exists():
            return ar.read()
        return None
