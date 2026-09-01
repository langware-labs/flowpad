"""Git origin driver — the ``kind="git"`` behavior for the FSOrigin registry:
materialize (reuse a matching local checkout, pull it, else clone), matches,
detect, and the byte-stable dedup ``key``. ``matches`` / ``detect`` / ``key``
delegate to ``GitOrigin`` (which stays in ``git_origin.py`` for the
git-as-a-feature call sites).

``materialize`` is THE clone/reuse/pull policy — the share bundle, a shared
project, a bootstrap template, a context folder and create-project-from-git
all route through it and differ only in what they pass: a ``preferred_root``
and an optional ``token``.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from flow_sdk.fs_store.origin.fs_origin import FSOrigin, safe_join
from flow_sdk.fs_store.origin.git_origin import has_content

logger = logging.getLogger(__name__)


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
        token: Optional[str] = None,
    ) -> tuple[Path, Optional[str]]:
        """Reuse a matching local checkout (pulled on its pinned branch), else clone.

        A ``preferred_root`` that does not exist yet — or is an empty directory
        — means *clone here* (a data source's ``reflect_into``, a project's
        reserved workspace slot, a template's fresh slot): no checkout is
        searched for, because those callers must not adopt a foreign clone.
        Otherwise the candidates are the repo containing ``preferred_root``
        when it matches (remote + branch), then ``GitOrigin.local_checkout``;
        a match is pulled and returned, else ``GitOrigin.next_clone_target``
        picks the slot. ``token`` is the caller's credential (anonymous by
        default — the driver never looks one up).
        """
        from flow_sdk.utils.git import find_project_root, git_clone, git_pull  # noqa: PLC0415

        async def resolved(root: Path) -> tuple[Path, Optional[str]]:
            return root, await _project_id_for_checkout(root, preferred_root, preferred_project_id)

        clone_here = preferred_root is not None and not has_content(preferred_root)
        if not clone_here:
            candidates: list[Path] = []
            if preferred_root is not None:
                preferred_repo = await asyncio.to_thread(find_project_root, str(preferred_root))
                if preferred_repo and origin.matches_checkout(Path(preferred_repo), require_branch=True):
                    candidates.append(Path(preferred_repo))
            local = await asyncio.to_thread(origin.local_checkout)
            if local is not None and local not in candidates:
                candidates.append(local)
            for candidate in candidates:
                if origin.branch:
                    ok, msg = await git_pull(str(candidate), branch=origin.branch)
                    if not ok:
                        logger.info("[git] pull failed for %s: %s", candidate, msg)
                asset_root = safe_join(candidate, origin.rel_path or ".")
                if asset_root is not None and asset_root.exists():
                    return await resolved(candidate)

        clone_target = preferred_root if clone_here else await asyncio.to_thread(origin.next_clone_target)
        if has_content(clone_target) and origin.matches_checkout(clone_target):
            return await resolved(clone_target)
        ok, msg = await git_clone(origin.clone_url(), str(clone_target), branch=origin.branch or None, token=token)
        if not ok:
            raise RuntimeError(msg)
        return await resolved(clone_target)

    def matches(self, origin: FSOrigin, local_path: Path) -> bool:
        matched, _reason = origin.matches_repo(local_path, require_branch=True)  # type: ignore[attr-defined]
        return matched

    async def detect(self, asset_root: Path) -> Optional[FSOrigin]:
        from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

        return GitOrigin.for_asset_path(str(asset_root))


async def _project_id_for_checkout(root: Path, preferred_root: Path | None, preferred_project_id: str | None) -> str | None:
    """The local project a checkout maps to — the caller's own when the root is
    the one it named, else the row at that path (or its derived id)."""
    try:
        if preferred_root is not None and preferred_project_id and root.resolve() == preferred_root.resolve():
            return preferred_project_id
    except OSError:
        pass
    try:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.recover_by_path(str(root))
        return project.id if project else Project.derive_id_for_path(str(root))
    except Exception:
        return None
