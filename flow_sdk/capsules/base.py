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
    pass
