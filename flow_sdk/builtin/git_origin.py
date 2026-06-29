"""GitOrigin — git provenance + placement for a shared asset (value object, NOT an entity).

Replaces the former ``GitRemote`` / ``GitBranch`` entities. Git here is *purely
provenance + placement*: a ``GitOrigin`` records which upstream repo + branch a
shared asset came from and its path **relative to the repo root**, so a receiver
can mirror the sender's layout instead of dumping everything at the canonical
type subdir. It is immutable, fully derivable, and never a DB/graph node — it
rides in the message bundle (``git_origins.json``) and stamps received entities'
backend record metadata.

``key()`` is a deterministic, branch-independent dedup handle (the same asset
position in the same repo yields the same key on every machine) — it is NOT an
entity id. Reuses the canonical git-identity helpers in ``utils/git_identity`` and
the per-repo git readers in ``utils/git``.
"""
from __future__ import annotations

import os
import uuid
from pathlib import PurePosixPath
from typing import Optional

from pydantic import BaseModel

from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.utils.git import _run_git, find_project_root, git_current_branch, git_remote_url
from flow_sdk.utils.git_identity import canonical_git_remote_key, parse_git_remote_url


def is_safe_rel_path(rel_path: str) -> bool:
    """A repo-relative path is safe iff it stays inside the repo root.

    ``rel_path`` is sender-controlled and gets joined onto the receiver's project
    root, so reject anything that could escape: empty, absolute, a Windows drive
    (``C:``), or any ``..`` segment. Path-traversal guard — callers MUST gate on
    this before placement.
    """
    if not rel_path or not rel_path.strip():
        return False
    p = rel_path.strip().replace("\\", "/")
    if p.startswith("/"):
        return False
    if len(p) >= 2 and p[1] == ":":  # windows drive letter, e.g. "C:/..."
        return False
    return ".." not in PurePosixPath(p).parts


def _head_commit(repo_path: str) -> Optional[str]:
    try:
        r = _run_git(["git", "rev-parse", "HEAD"], repo_path, timeout=5)
        return (r.stdout.strip() or None) if r.returncode == 0 else None
    except Exception:
        return None


class GitOrigin(BaseModel):
    """Provenance + repo-relative position of a shared file-backed asset."""

    provider: str = "github"
    owner: str = ""
    name: str = ""
    branch: str = ""
    head_commit: Optional[str] = None
    # The asset ROOT's path relative to the repo root — a FOLDER for folder-layout
    # types (skill, workflow), a FILE for file-layout types (markdown). The unit is
    # the asset root, never "a file".
    rel_path: str = ""

    def key(self) -> str:
        """Deterministic, branch-independent dedup handle.

        ``uuid5`` over ``<canonical-remote-key>:<rel_path>`` — the same asset
        position in the same repo always yields the same key across machines and
        across shares, so "received now" and "cloned later" reconcile by value.
        """
        remote_key = canonical_git_remote_key(self.provider, self.owner, self.name)
        rel = PurePosixPath(self.rel_path.strip().replace("\\", "/")).as_posix()
        return mint_uuid(key=f"{remote_key}:{rel}", namespace=uuid.NAMESPACE_URL)

    @classmethod
    def for_asset_path(cls, asset_root: str, repo_cache: Optional[dict] = None) -> Optional["GitOrigin"]:
        """Build a ``GitOrigin`` for an on-disk asset root (folder or file).

        Returns None when the asset is not inside a git repo, the repo has no
        usable ``origin`` remote, or the computed rel_path would be unsafe — the
        caller then falls back to git-blind canonical placement.

        Runs blocking git subprocesses — call via ``asyncio.to_thread`` on an
        async path. ``repo_cache`` (optional) memoizes the per-repo coordinates
        (provider/owner/name/branch/head_commit, plus a ``False`` sentinel for a
        repo with no usable remote) keyed by repo root, so sharing several assets
        from one checkout runs those reads once instead of once per asset.
        """
        root = find_project_root(asset_root)
        if not root:
            return None
        meta = repo_cache.get(root) if repo_cache is not None else None
        if meta is None:
            parsed = parse_git_remote_url(git_remote_url(root))
            meta = (
                (*parsed, git_current_branch(root), _head_commit(root)) if parsed else False
            )
            if repo_cache is not None:
                repo_cache[root] = meta
        if not meta:  # not a usable repo (no origin remote)
            return None
        provider, owner, name, branch, head = meta
        try:
            rel = os.path.relpath(os.path.realpath(asset_root), os.path.realpath(root))
        except Exception:
            return None
        rel = rel.replace(os.sep, "/")
        if not is_safe_rel_path(rel):
            return None
        return cls(provider=provider, owner=owner, name=name, branch=branch, head_commit=head, rel_path=rel)
