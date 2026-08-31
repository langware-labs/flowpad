"""Common AssetCapsule interface and path-based factory."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from .data import CapsuleData
from .errors import UnsupportedCapsuleFormatError


class AssetCapsule(ABC):
    def __init__(self, path: Path):
        self.path = path

    @classmethod
    def from_path(cls, path: str | Path) -> "AssetCapsule":
        supplied = Path(path)
        resolved = supplied.resolve(strict=True)
        if resolved.is_dir():
            from .folder import FolderCapsule
            return FolderCapsule(resolved)
        if resolved.is_file() and resolved.suffix.casefold() in {".md", ".markdown"}:
            from .code_comment import CodeCommentCapsule
            return CodeCommentCapsule(resolved)
        if resolved.is_file():
            from .line_comment import COMMENT_LEADERS, LineCommentCapsule
            if resolved.suffix.casefold() in COMMENT_LEADERS:
                return LineCommentCapsule(resolved)
        raise UnsupportedCapsuleFormatError(f"unsupported capsule path: {supplied}")

    @abstractmethod
    def read(self, name: str) -> CapsuleData | None: ...

    @abstractmethod
    def write(self, name: str, data: CapsuleData) -> CapsuleData: ...

    @abstractmethod
    def write_if_absent(self, name: str, data: CapsuleData) -> CapsuleData: ...

    @abstractmethod
    def remove(self, name: str) -> bool: ...

    @abstractmethod
    def names(self) -> tuple[str, ...]: ...


class FileCapsule(AssetCapsule, ABC):
    """A capsule stored as marker-delimited blocks INSIDE one text file.

    The two implementations (``<!-- flowpad:capsule -->`` in markdown,
    ``# flowpad:capsule`` line comments in source) differ only in how a block is
    recognised, parsed and rendered. Reading the file, finding a block by name
    and the write/write_if_absent pair over ``_replace`` are the same work, so
    they live here.

    ``remove`` and ``names`` are deliberately NOT shared: a line-comment name is
    repeatable, so those two have genuinely different semantics per format.
    """

    def _read_text(self) -> tuple[str, bytes]:
        """``(text, bom)`` for the whole file. An unreadable file is malformed."""
        from .code_comment import _decode  # noqa: PLC0415 — avoid an import cycle
        from .errors import MalformedCapsuleError  # noqa: PLC0415

        try:
            return _decode(self.path.read_bytes())
        except OSError as exc:
            raise MalformedCapsuleError(str(exc)) from exc

    def _find(self, text: str, name: str):
        """The first block named *name*, or None."""
        return next((item for item in self._scan(text) if item.name == name), None)

    def read(self, name: str) -> CapsuleData | None:
        from .data import validate_capsule_name  # noqa: PLC0415

        validate_capsule_name(name)
        text, _bom = self._read_text()
        block = self._find(text, name)
        return self._parse_block(text, block) if block is not None else None

    def write(self, name: str, data: CapsuleData) -> CapsuleData:
        return self._replace(name, data, only_if_absent=False)

    def write_if_absent(self, name: str, data: CapsuleData) -> CapsuleData:
        return self._replace(name, data, only_if_absent=True)

    @abstractmethod
    def _scan(self, text: str) -> tuple: ...

    @abstractmethod
    def _parse_block(self, text: str, block) -> CapsuleData: ...

    @abstractmethod
    def _replace(self, name: str, data: CapsuleData, *, only_if_absent: bool) -> CapsuleData: ...
