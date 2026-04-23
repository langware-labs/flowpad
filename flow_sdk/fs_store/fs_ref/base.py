"""FSRef base class — universal file/folder reference primitive."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.fs_store.record_types import RecordType


def _read_existing_frontmatter(path: Path) -> dict:
    """Read and parse existing YAML frontmatter from a .md file. Returns {} on error."""
    try:
        from flow_sdk.fs_records._frontmatter import _extract_frontmatter, _yaml_load

        text = path.read_text(encoding="utf-8")
        fm = _extract_frontmatter(text)
        if fm:
            return _yaml_load(fm)
    except Exception:
        pass
    return {}


class FSRef:
    """Lightweight file/folder reference.

    Wraps a filesystem path with convenience methods for reading, writing,
    navigating, and serializing. No knowledge of Record, Entity, or HTTP.
    """

    def __init__(
        self,
        path: str | Path,
        read_only: bool = False,
        parent: "FSRef | None" = None,
        record_type: "RecordType | None" = None,
    ) -> None:
        self._path = Path(path).resolve()
        self._read_only_flag: bool = read_only
        self._parent: "FSRef | None" = parent
        self._record_type: "RecordType | None" = record_type

    @property
    def record_type(self) -> "RecordType | None":
        return self._record_type

    @property
    def read_only(self) -> bool:
        """Dynamic computed property: True if self or any ancestor is read-only."""
        parent_ro = self._parent.read_only if self._parent is not None else False
        return parent_ro or self._read_only_flag

    @property
    def path(self) -> str:
        return str(self._path)

    @property
    def name(self) -> str:
        return self._path.name

    @property
    def is_dir(self) -> bool:
        return self._path.is_dir()

    @property
    def is_file(self) -> bool:
        return self._path.is_file()

    def child(self, name: str) -> "FSRef":
        return FSRef(self._path / name, parent=self)

    @property
    def parent(self) -> "FSRef":
        return FSRef(self._path.parent)

    def exists(self) -> bool:
        return self._path.exists()

    def read(self) -> str:
        return self._path.read_text(encoding="utf-8")

    def write(self, content: str) -> None:
        if self.read_only:
            raise IOError(f"FSRef at {self.path!r} is read-only")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(content, encoding="utf-8")

    def write_md(self, body: str, frontmatter: dict) -> None:
        """Write markdown file preserving (or injecting) frontmatter fields."""
        if self.read_only:
            raise IOError(f"FSRef at {self.path!r} is read-only")
        from flow_sdk.fs_records._frontmatter import _render_frontmatter

        if self._path.exists():
            existing_fm = _read_existing_frontmatter(self._path)
            existing_fm.update(frontmatter)
            frontmatter = existing_fm
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(_render_frontmatter(frontmatter) + "\n" + body, encoding="utf-8")

    def delete(self) -> None:
        if self._path.is_dir():
            import shutil

            shutil.rmtree(self._path)
        elif self._path.exists():
            self._path.unlink()

    def mkdir(self) -> None:
        self._path.mkdir(parents=True, exist_ok=True)

    def children(self) -> list["FSRef"]:
        if not self._path.is_dir():
            return []
        return [FSRef(p) for p in sorted(self._path.iterdir())]

    def _ref_type(self) -> str:
        return "folder" if self.is_dir else "file"

    def to_dict(self, type_id: str = "") -> dict:
        return {
            "path": self.path,
            "ref_type": self._ref_type(),
            "read_only": self.read_only,
            "type_id": type_id,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FSRef":
        ref_type = d.get("ref_type", "file")
        path = d["path"]
        read_only = d.get("read_only", False)
        if ref_type == "json":
            from flow_sdk.fs_store.fs_ref.json_ref import JSONFsRef

            return JSONFsRef(path, read_only=read_only)
        if ref_type == "text":
            from flow_sdk.fs_store.fs_ref.text_ref import TextFsRef

            return TextFsRef(path, read_only=read_only)
        if ref_type == "binary":
            from flow_sdk.fs_store.fs_ref.binary_ref import BinaryFsRef

            return BinaryFsRef(path, read_only=read_only)
        if ref_type == "frontmatter_md":
            from flow_sdk.fs_store.fs_ref.frontmatter_ref import FrontMatterFsRef

            return FrontMatterFsRef(path, read_only=read_only)
        return cls(path, read_only=read_only)

    @property
    def fingerprint(self) -> str:
        """Lightweight mtime+size content token."""
        try:
            st = self._path.stat()
            return f"{st.st_mtime_ns}:{st.st_size}"
        except OSError:
            return ""

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, FSRef):
            return NotImplemented
        return self._path == other._path

    def __hash__(self) -> int:
        return hash(self._path)

    def __repr__(self) -> str:
        return f"FSRef({self.path!r})"
