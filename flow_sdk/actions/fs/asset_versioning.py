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


async def autoversion_commit_local(storage, vfs_abs_path: str, content: str) -> None:
    """Bump frontmatter ``version`` and commit the file if its content changed.

    Gated to frontmatter-bearing files inside a git repo on local storage. The
    version bump is written directly to the real path (not back through the
    ``write`` action), so it never re-enters this hook.
    """
    try:
        if not isinstance(content, str) or _extract_frontmatter(content) is None:
            return  # only assets (files carrying YAML frontmatter)
        real = _real_path(storage, vfs_abs_path)
        if not real:
            return  # remote/sandbox storage — no local git tree
        repo_root = find_project_root(real)
        if not repo_root:
            return
        rel_file = os.path.relpath(real, repo_root)

        if not await _is_changed_vs_head(repo_root, rel_file):
            return  # no-op save (content identical to HEAD) — don't flood history

        fields = _yaml_load(_extract_frontmatter(content) or "") or {}
        try:
            current = int(fields.get("version", 1))
        except (TypeError, ValueError):
            current = 1
        new_version = current + 1
        name = fields.get("name") or Path(rel_file).stem

        write_text_if_changed(Path(real), merge_frontmatter(content, {"version": new_version}))
        await git_commit_file(repo_root, rel_file, f"Flowpad: {name} v{new_version}")
    except Exception as e:  # noqa: BLE001 — auto-versioning must never break a save
        logger.warning("[asset-version] auto-commit skipped (non-fatal): %s", e)
