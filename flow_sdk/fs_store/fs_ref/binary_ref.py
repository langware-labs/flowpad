"""BinaryFsRef — raw binary file reference."""

from __future__ import annotations

from flow_sdk.fs_store.fs_ref.base import FSRef


class BinaryFsRef(FSRef):
    """Binary file reference.

    ref_type = "binary"

    Provides read_bytes/write_bytes for raw binary file access.
    """

    def _ref_type(self) -> str:
        return "binary"

    def read_bytes(self) -> bytes:
        return self._path.read_bytes()

    def write_bytes(self, data: bytes) -> None:
        if self.read_only:
            raise IOError(f"BinaryFsRef at {self.path!r} is read-only")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_bytes(data)
