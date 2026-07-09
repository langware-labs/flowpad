"""Local origin driver — ``kind="local"`` behavior. Materialize is a no-op fetch.

The whole point of this driver is to exercise the FSOrigin seam with a backend
whose ``materialize`` is shaped nothing like git's clone/pull: the bytes are
already on disk under ``origin.base``, so materialize just resolves
``base/rel_path`` (path-traversal-guarded) and returns it. No network, no clone.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from flow_sdk.builtin.fs_origin import FSOrigin, is_safe_rel_path
from flow_sdk.builtin.local_origin import local_origin_key


class LocalOriginDriver:
    kind = "local"

    def key(self, origin: FSOrigin) -> str:
        base = getattr(origin, "base", "") or ""
        return local_origin_key(base, origin.rel_path)

    async def materialize(
        self,
        origin: FSOrigin,
        *,
        preferred_root: Optional[Path] = None,
        preferred_project_id: Optional[str] = None,
    ) -> tuple[Path, Optional[str]]:
        local_root = _resolve_local_path(origin)  # base+rel, guarded
        if not local_root.exists():
            raise FileNotFoundError(f"local origin not present on this machine: {local_root}")
        return local_root, preferred_project_id

    def matches(self, origin: FSOrigin, local_path: Path) -> bool:
        try:
            target = _resolve_local_path(origin)
        except Exception:
            return False
        try:
            return target.resolve() == Path(local_path).resolve()
        except OSError:
            return str(target) == str(local_path)

    async def detect(self, asset_root: Path) -> Optional[FSOrigin]:
        # A bare local path carries no discoverable "origin" — the mount base is
        # not recoverable from the path alone. Explicit declaration only.
        return None


def _resolve_local_path(origin: FSOrigin) -> Path:
    """Resolve an origin's base + rel_path to a local path (traversal-guarded).

    The single place the local base/rel join lives — shared by materialize and
    matches so the guard can't drift out of one of them."""
    base = getattr(origin, "base", "") or ""
    if not base:
        raise ValueError("LocalOrigin.base is required")
    rel = origin.rel_path or ""
    if not rel:
        return Path(base)
    if not is_safe_rel_path(rel):
        raise ValueError(f"unsafe local origin rel_path: {rel!r}")
    return Path(base) / rel.replace("\\", "/")
