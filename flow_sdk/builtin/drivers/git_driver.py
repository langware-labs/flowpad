"""Git origin driver — the ``kind="git"`` behavior for the FSOrigin registry.

Wraps the git-specific behavior that used to be called directly from the share
bundle: materialize (clone/pull/reuse-local), matches (is this checkout the
origin's repo?), detect (reverse-derive an origin from an on-disk path), and the
byte-stable dedup ``key``. The heavy clone/pull logic still physically lives in
``flow_message_bundle._resolve_git_checkout`` (it depends on a cluster of
bundle-local helpers); this driver lazy-calls it so the bundle can dispatch by
``origin.kind`` through the registry instead of hardcoding git. ``matches`` /
``detect`` / ``key`` delegate to the existing ``GitOrigin`` methods (which stay
in ``git_origin.py`` for the git-as-a-feature call sites).
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from flow_sdk.builtin.fs_origin import FSOrigin


class GitOriginDriver:
    kind = "git"

    def key(self, origin: FSOrigin) -> str:
        # GitOrigin overrides key() with its byte-stable legacy body.
        return origin.key()

    async def materialize(
        self,
        origin: FSOrigin,
        *,
        preferred_root: Optional[Path] = None,
        preferred_project_id: Optional[str] = None,
    ) -> tuple[Path, Optional[str]]:
        from flow_sdk.builtin.flow_message_bundle import _resolve_git_checkout  # noqa: PLC0415

        return await _resolve_git_checkout(
            origin,
            preferred_root=preferred_root,
            preferred_project_id=preferred_project_id,
        )

    def matches(self, origin: FSOrigin, local_path: Path) -> bool:
        matched, _reason = origin.matches_repo(local_path, require_branch=True)  # type: ignore[attr-defined]
        return matched

    async def detect(self, asset_root: Path) -> Optional[FSOrigin]:
        from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415

        return GitOrigin.for_asset_path(str(asset_root))
