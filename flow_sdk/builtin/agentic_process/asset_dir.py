"""Process-local asset directory helpers."""

from __future__ import annotations

import shutil
from pathlib import Path


class AssetDir:
    """Safe loader for files materialized under one process asset root."""

    def __init__(self, os_path: str | Path) -> None:
        self.os_path = Path(os_path)

    def _relative_target(self, relative_path: str | Path) -> Path:
        rel = Path(relative_path)
        if not rel.parts or rel.is_absolute() or ".." in rel.parts:
            raise ValueError(f"asset path must be relative and stay inside asset dir: {relative_path}")
        return self.os_path / rel

    def _target(self, relative_path: str | Path) -> Path:
        target = self._relative_target(relative_path)
        root = self.os_path.resolve()
        parent = target.parent
        resolved_parent = parent.resolve()
        if resolved_parent != root and root not in resolved_parent.parents:
            raise ValueError(f"asset path escapes asset dir: {relative_path}")
        parent.mkdir(parents=True, exist_ok=True)
        return target

    def subdir(self, relative_path: str | Path) -> "AssetDir":
        """Create and return one contained, process-owned subdirectory."""
        target = self._target(relative_path)
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            raise ValueError(f"asset subdir must be a real directory: {relative_path}")
        target.mkdir(parents=True, exist_ok=True)
        resolved = target.resolve()
        root = self.os_path.resolve()
        if resolved != root and root not in resolved.parents:
            raise ValueError(f"asset path escapes asset dir: {relative_path}")
        return AssetDir(target)

    def remove(self, relative_path: str | Path) -> None:
        """Remove one contained file/subtree without ever deleting the root."""
        target = self._relative_target(relative_path)
        root = self.os_path.resolve()
        resolved_parent = target.parent.resolve()
        if resolved_parent != root and root not in resolved_parent.parents:
            raise ValueError(f"asset path escapes asset dir: {relative_path}")
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)

    def load_asset(
        self,
        relative_path: str | Path,
        *,
        content: str | bytes | None = None,
        source: str | Path | None = None,
        symlink: bool = False,
    ) -> Path:
        """Load content or a filesystem source into ``relative_path``.

        Exactly one of ``content`` or ``source`` must be supplied.
        """
        if (content is None) == (source is None):
            raise ValueError("provide exactly one of content or source")

        target = self._target(relative_path)
        if target.exists() or target.is_symlink():
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()

        if content is not None:
            if isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content, encoding="utf-8")
            return target

        src = Path(source or "").resolve()
        if not src.exists():
            raise FileNotFoundError(src)
        if symlink:
            target.symlink_to(src, target_is_directory=src.is_dir())
        elif src.is_dir():
            shutil.copytree(
                src,
                target,
                ignore=shutil.ignore_patterns(".flow_record", "record.json"),
            )
        else:
            shutil.copy2(src, target)
        return target
