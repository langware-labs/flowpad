"""Process-local asset directory helpers."""

from __future__ import annotations

import shutil
from pathlib import Path


class AssetDir:
    """Safe loader for files materialized under one process asset root."""

    def __init__(self, os_path: str | Path) -> None:
        self.os_path = Path(os_path)

    def _target(self, relative_path: str | Path) -> Path:
        rel = Path(relative_path)
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError(f"asset path must be relative and stay inside asset dir: {relative_path}")
        target = self.os_path / rel
        root = self.os_path.resolve()
        parent = target.parent
        parent.mkdir(parents=True, exist_ok=True)
        resolved_parent = parent.resolve()
        if resolved_parent != root and root not in resolved_parent.parents:
            raise ValueError(f"asset path escapes asset dir: {relative_path}")
        return target

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
