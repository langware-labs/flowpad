"""TextFsRef — plain-text file reference."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref.base import FSRef


class TextFsRef(FSRef):
    """Plain-text file reference with optional read-only enforcement."""

    def _ref_type(self) -> str:
        return "text"

    def __init__(self, path: str | Path, read_only: bool = False, parent: "FSRef | None" = None) -> None:
        super().__init__(path, read_only=read_only, parent=parent)

    def write(self, content: str) -> None:
        if self.read_only:
            raise IOError(f"TextFsRef at {self.path!r} is read-only")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(content, encoding="utf-8")
