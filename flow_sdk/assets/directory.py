"""Contained asset directory operations."""

from __future__ import annotations

import tempfile
from pathlib import Path

from flow_sdk.assets.materialize import MaterializationMode, materialize_asset_sync, remove_path


class AssetDir:
    """Safe loader for files materialized under one asset root."""

    def __init__(self, os_path: str | Path) -> None:
        self.os_path = Path(os_path)

    def ensure(self) -> Path:
        self.os_path.mkdir(parents=True, exist_ok=True)
        return self.os_path

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
        remove_path(target)

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
        if source is not None:
            return materialize_asset_sync(
                Path(source), target,
                mode=MaterializationMode.LINK if symlink else MaterializationMode.COPY,
                overwrite=True,
                exclude=(".flow_record", "record.json"),
            )
        # Generate bytes before entering the shared replacement transaction.
        # A failed write must leave an existing owned projection and receipt intact.
        with tempfile.TemporaryDirectory(prefix=".asset-content-", dir=target.parent) as temporary:
            source_path = Path(temporary) / target.name
            if isinstance(content, bytes):
                source_path.write_bytes(content)
            else:
                source_path.write_text(content, encoding="utf-8")
            materialize_asset_sync(source_path, target, overwrite=True)
        return target
