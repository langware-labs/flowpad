"""FSRef base class — universal file/folder reference primitive."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.schema.layout import Layout


def _read_existing_frontmatter(path: Path) -> dict:
    """Read and parse existing YAML frontmatter from a .md file. Returns {} on error."""
    try:
        from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load

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
        scope: str | None = None,
        type_id: str = "compute_node-@local",
        project_id: str | None = None,
        json_path: str | None = None,
        layout: "Layout | None" = None,
    ) -> None:
        self._path = Path(path).resolve()
        self._read_only_flag: bool = read_only
        self._parent: "FSRef | None" = parent
        self._record_type: "RecordType | None" = record_type
        self._scope: str | None = scope
        self._type_id: str = type_id
        self._project_id: str | None = project_id
        # RFC 6901 JSON Pointer into ``_path`` for file-internal references.
        # When set, this FSRef points at a *fragment* of the file, not the
        # whole file (e.g. one hook inside settings.json). Enables recursive
        # walkers that descend into file content. None for regular file/dir refs.
        self._json_path: str | None = json_path
        # The layout a WALKER already verified, so the id seam
        # (``TypeInfo.layout_for``) need not stat this path again. Never part
        # of identity: two refs are the same ref when their paths are.
        self._layout: "Layout | None" = layout

    @property
    def layout(self) -> "Layout | None":
        """The walker-verified layout, when this ref came from a walk."""
        return self._layout

    @property
    def json_path(self) -> str | None:
        """RFC 6901 JSON Pointer if this ref points at a fragment of a file."""
        return self._json_path

    @property
    def record_type(self) -> "RecordType | None":
        return self._record_type

    @property
    def scope(self) -> str | None:
        """Ambient scope inherited from the parent chain.

        If this ref has an explicit scope, returns it. Otherwise walks up
        `.parent` until it finds a scoped ancestor, or None if none exists.
        Scope is a property of position in the tree, not of the leaf.
        """
        if self._scope is not None:
            return self._scope
        return self._parent.scope if self._parent is not None else None

    @property
    def project_id(self) -> str | None:
        """Project id stamped at the root, inherited via the parent chain.

        Mirrors `scope` semantics: walk up until an ancestor has an explicit
        `project_id`, or None if none does. Set at the project-scoped root
        FSRef by the index handler so descendants pick it up implicitly.
        """
        if self._project_id is not None:
            return self._project_id
        return self._parent.project_id if self._parent is not None else None

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
        from flow_sdk.fs_store.indexer._frontmatter import _render_frontmatter

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

    def to_dict(self, type_id: str | None = None) -> dict:
        return {
            "path": self.path,
            "ref_type": self._ref_type(),
            "read_only": self.read_only,
            "type_id": type_id if type_id is not None else self._type_id,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FSRef":
        ref_type = d.get("ref_type", "file")
        path = d["path"]
        read_only = d.get("read_only", False)
        type_id = d.get("type_id") or "compute_node-@local"
        if ref_type == "json":
            from flow_sdk.fs_store.fs_ref.json_ref import JSONFsRef

            return JSONFsRef(path, read_only=read_only, type_id=type_id)
        if ref_type == "text":
            from flow_sdk.fs_store.fs_ref.text_ref import TextFsRef

            return TextFsRef(path, read_only=read_only, type_id=type_id)
        if ref_type == "binary":
            from flow_sdk.fs_store.fs_ref.binary_ref import BinaryFsRef

            return BinaryFsRef(path, read_only=read_only, type_id=type_id)
        if ref_type == "frontmatter_md":
            from flow_sdk.fs_store.fs_ref.frontmatter_ref import FrontMatterFsRef

            return FrontMatterFsRef(path, read_only=read_only, type_id=type_id)
        return cls(path, read_only=read_only, type_id=type_id)

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

    # Pydantic v2 compatibility — accept dict on deserialization, emit dict on
    # serialization. Mirrors the TypeId pattern so FSRef can be a field type
    # directly on Pydantic entities (wire shape stays `{path, ref_type, …}`).
    @classmethod
    def __get_pydantic_core_schema__(cls, source_type, handler):
        from pydantic_core import core_schema

        return core_schema.no_info_plain_validator_function(
            cls._pydantic_validate,
            serialization=core_schema.plain_serializer_function_ser_schema(
                cls._pydantic_serialize,
                return_schema=core_schema.dict_schema(),
            ),
        )

    @classmethod
    def __get_pydantic_json_schema__(cls, _core_schema, _handler):
        return {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "ref_type": {"type": "string"},
                "read_only": {"type": "boolean"},
                "type_id": {"type": "string"},
            },
            "required": ["path"],
        }

    @classmethod
    def _pydantic_validate(cls, value):
        if isinstance(value, FSRef):
            return value
        if isinstance(value, dict):
            return cls.from_dict(value)
        if isinstance(value, (str, Path)):
            return cls(value)
        raise ValueError(f"Cannot convert {type(value).__name__} to FSRef")

    @staticmethod
    def _pydantic_serialize(ref: "FSRef") -> dict:
        return ref.to_dict()
