"""FSRef — universal file/folder reference primitive.

Replaces the ad-hoc path tracking scattered across Record subclasses.
Every external-backed Record exposes:
  - record_folder_ref → FSRef pointing to its own metadata folder (persisted)
  - asset_ref → FSRef pointing to primary external content (persisted)
"""

from __future__ import annotations

from pathlib import Path


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

    def __init__(self, path: str | Path, read_only: bool = False, parent: "FSRef | None" = None) -> None:
        self._path = Path(path).resolve()
        self._read_only_flag: bool = read_only
        self._parent: "FSRef | None" = parent

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
            return JSONFsRef(path, read_only=read_only)
        if ref_type == "text":
            return TextFsRef(path, read_only=read_only)
        if ref_type == "binary":
            return BinaryFsRef(path, read_only=read_only)
        if ref_type == "frontmatter_md":
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


class JSONFsRef(FSRef):
    """Write-through JSON file reference.

    ref_type = "json"

    Keeps _json_data: dict in memory. First access loads from disk.
    set()/update() write through to the file immediately.
    File is stored in wrapped {"data": {...}} format matching _save_split_format.
    """

    def _ref_type(self) -> str:
        return "json"

    def __init__(self, path: str | Path, read_only: bool = False, parent: "FSRef | None" = None) -> None:
        super().__init__(path, read_only=read_only, parent=parent)
        self._json_data: dict | None = None

    def _ensure_loaded(self) -> None:
        if self._json_data is None:
            import json

            if Path(self.path).exists():
                raw = json.loads(Path(self.path).read_text(encoding="utf-8"))
                self._json_data = raw.get("data", raw) if isinstance(raw, dict) else {}
            else:
                self._json_data = {}

    def _flush(self) -> None:
        if self.read_only:
            raise IOError(f"JSONFsRef at {self.path!r} is read-only")
        import json

        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        Path(self.path).write_text(
            json.dumps({"data": self._json_data}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def get(self, key: str, default=None):
        self._ensure_loaded()
        return self._json_data.get(key, default)

    def set(self, key: str, value) -> None:
        self._ensure_loaded()
        self._json_data[key] = value
        self._flush()

    def update(self, data: dict) -> None:
        self._ensure_loaded()
        self._json_data.update(data)
        self._flush()

    def load(self) -> dict:
        self._json_data = None
        self._ensure_loaded()
        return dict(self._json_data)

    def as_dict(self) -> dict:
        self._ensure_loaded()
        return dict(self._json_data)

    def write(self, content: str) -> None:
        """Write raw text content (resets JSON cache)."""
        if self.read_only:
            raise IOError(f"JSONFsRef at {self.path!r} is read-only")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(content, encoding="utf-8")
        self._json_data = None  # invalidate cache

    @property
    def hash(self) -> str:
        """SHA256 of the file content."""
        import hashlib

        try:
            return hashlib.sha256(self._path.read_bytes()).hexdigest()
        except OSError:
            return ""


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


class FrontMatterFsRef(FSRef):
    """Markdown file reference with YAML frontmatter read/write support.

    ref_type = "frontmatter_md"

    Provides typed access to the frontmatter dict and body of a .md file.
    All write methods raise IOError when the ref is read-only.
    """

    def _ref_type(self) -> str:
        return "frontmatter_md"

    def read_frontmatter(self) -> dict:
        """Parse and return the YAML frontmatter dict. Returns {} if file absent or no frontmatter."""
        if not self._path.exists():
            return {}
        return _read_existing_frontmatter(self._path)

    def read_body(self) -> str:
        """Return the markdown body (text after the closing --- delimiter). Returns '' if file absent."""
        if not self._path.exists():
            return ""
        try:
            from flow_sdk.fs_records._frontmatter import _extract_body
            return _extract_body(self._path.read_text(encoding="utf-8"))
        except Exception:
            return ""

    def write_frontmatter(self, fields: dict) -> None:
        """Merge fields into the existing frontmatter, preserving the body."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.fs_records._frontmatter import _extract_body, _render_frontmatter
        existing_fm = _read_existing_frontmatter(self._path) if self._path.exists() else {}
        existing_fm.update(fields)
        body = ""
        if self._path.exists():
            body = _extract_body(self._path.read_text(encoding="utf-8"))
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(_render_frontmatter(existing_fm) + "\n" + body, encoding="utf-8")

    def write_body(self, body: str) -> None:
        """Replace the body while preserving the existing frontmatter."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.fs_records._frontmatter import _render_frontmatter
        existing_fm = _read_existing_frontmatter(self._path) if self._path.exists() else {}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(_render_frontmatter(existing_fm) + "\n" + body, encoding="utf-8")

    def write_doc(self, body: str, frontmatter: dict) -> None:
        """Atomically write frontmatter + body without reading the existing file first."""
        if self.read_only:
            raise IOError(f"FrontMatterFsRef at {self.path!r} is read-only")
        from flow_sdk.fs_records._frontmatter import _render_frontmatter
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(_render_frontmatter(frontmatter) + "\n" + body, encoding="utf-8")


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
