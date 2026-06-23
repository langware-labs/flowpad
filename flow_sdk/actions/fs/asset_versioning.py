"""Auto-versioning of asset files on save (local instances).

Hooked from the ``fs`` ``write`` action — the client file-write seam — so a save
that actually changes an asset's content bumps the frontmatter ``version`` and
records a file-scoped git commit. Indexer/system writes go straight to disk
(never through the ``write`` action), so this path is not re-entered by indexing.

Local-first: only ``LocalStorageDriver`` resolves to a real on-disk path that git
can operate on; on remote/sandbox storage this is a no-op. Everything here is
best-effort — a failure must never break the underlying save.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from flow_sdk.fs_store.fs_record import write_text_if_changed
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_frontmatter,
    _yaml_load,
    merge_frontmatter,
)
from flow_sdk.utils.git import _run_git, find_project_root, git_commit_file

logger = logging.getLogger(__name__)


def _real_path(storage, vfs_abs_path: str) -> str | None:
    """Resolve the real on-disk path for a local storage driver, else None."""
    resolver = getattr(storage, "_local_full_path", None)
    if not callable(resolver):
        return None
    try:
        return resolver(vfs_abs_path)
    except Exception:  # noqa: BLE001
        return None


async def _is_changed_vs_head(repo_root: str, rel_file: str) -> bool:
    """True when the working-tree file is new (untracked) or differs from HEAD."""
    tracked = await asyncio.to_thread(
        _run_git, ["git", "ls-files", "--error-unmatch", "--", rel_file], repo_root
    )
    if tracked.returncode != 0:
        return True  # untracked → a freshly-created asset, version it
    diff = await asyncio.to_thread(
        _run_git, ["git", "diff", "--quiet", "HEAD", "--", rel_file], repo_root
    )
    return diff.returncode != 0


async def _bump_version_and_commit(real_path: str, content: str) -> dict | None:
    """Core of asset versioning: given an on-disk asset path and its source-of-truth
    ``content``, bump the frontmatter ``version`` and record a file-scoped commit
    iff the file is a frontmatter-bearing asset in a git repo that differs from
    HEAD. Returns ``{"hash", "version"}`` of the new revision, else ``None``.

    Shared by the ``fs.write`` autosave hook and the explicit UI-triggered commit
    so the version-bump rule and commit-message format live in exactly one place.
    """
    if _extract_frontmatter(content) is None:
        return None  # only assets (files carrying YAML frontmatter)
    repo_root = find_project_root(real_path)
    if not repo_root:
        return None
    rel_file = os.path.relpath(real_path, repo_root)
    if not await _is_changed_vs_head(repo_root, rel_file):
        return None  # no-op save (content identical to HEAD) — don't flood history
    fields = _yaml_load(_extract_frontmatter(content) or "") or {}
    try:
        current = int(fields.get("version", 1))
    except (TypeError, ValueError):
        current = 1
    new_version = current + 1
    name = fields.get("name") or Path(rel_file).stem
    write_text_if_changed(Path(real_path), merge_frontmatter(content, {"version": new_version}))
    await git_commit_file(repo_root, rel_file, f"Flowpad: {name} v{new_version}")
    head = await asyncio.to_thread(
        _run_git, ["git", "log", "-1", "--format=%H", "--", rel_file], repo_root
    )
    return {"hash": (head.stdout or "").strip(), "version": new_version}


async def commit_asset_change(real_path: str) -> dict | None:
    """Bump + commit a single asset already edited on disk (the "commit" step of
    the improvement cycle). The autoversion hook fires on the ``fs.write`` action,
    but an agent (a skill-fixer worker) edits via its ``Edit`` tool — a raw disk
    write that bypasses that seam — so this reads the on-disk content and commits
    it explicitly. Returns ``{"hash", "version"}`` or ``None`` if nothing changed.
    """
    if not os.path.isfile(real_path):
        return None
    # Resolve symlinks (e.g. macOS /tmp → /private/tmp) so the path agrees with
    # find_project_root's realpath output — else relpath lands "outside repo".
    real_path = os.path.realpath(real_path)
    return await _bump_version_and_commit(real_path, Path(real_path).read_text(encoding="utf-8"))


async def autoversion_commit_local(storage, vfs_abs_path: str, content: str) -> None:
    """Bump frontmatter ``version`` and commit on save, for frontmatter-bearing
    files in a git repo on local storage. The bump is written directly to the real
    path (not back through the ``write`` action), so it never re-enters this hook.
    """
    try:
        if not isinstance(content, str):
            return
        real = _real_path(storage, vfs_abs_path)
        if not real:
            return  # remote/sandbox storage — no local git tree
        await _bump_version_and_commit(real, content)
    except Exception as e:  # noqa: BLE001 — auto-versioning must never break a save
        logger.warning("[asset-version] auto-commit skipped (non-fatal): %s", e)
