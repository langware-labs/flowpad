"""GitOrigin — git provenance + placement for a shared asset (value object, NOT an entity).

Git here is *purely provenance + placement*: a ``GitOrigin`` records which upstream repo + branch a
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
from typing import Literal, Optional

from flow_sdk.builtin.fs_origin import FSOrigin
from flow_sdk.builtin.fs_origin import is_safe_rel_path as is_safe_rel_path  # canonical home; re-exported
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.utils.git import _run_git, find_project_root, git_current_branch, git_remote_url
from flow_sdk.utils.git_identity import canonical_git_origin_repo_key, git_origin_clone_url, parse_git_origin_url


def _head_commit(repo_path: str) -> Optional[str]:
    try:
        r = _run_git(["git", "rev-parse", "HEAD"], repo_path, timeout=5)
        return (r.stdout.strip() or None) if r.returncode == 0 else None
    except Exception:
        return None


class GitOrigin(FSOrigin):
    """Provenance + repo-relative position of a shared file-backed asset.

    The ``kind="git"`` member of ``FSOrigin``. ``rel_path`` is inherited from the
    base (the universal placement contract); ``provider/owner/name/branch/
    head_commit`` are the git locator. ``key``/``from_url``/``clone_url`` are
    kept byte-for-byte from the pre-FSOrigin implementation — ``key()`` is the
    cross-machine dedup handle and MUST NOT change, or already-shared assets
    stop reconciling.
    """

    kind: Literal["git"] = "git"
    provider: str = "github"
    owner: str = ""
    name: str = ""
    branch: str = ""
    head_commit: Optional[str] = None
    # ``rel_path`` inherited from FSOrigin — the asset ROOT relative to the repo
    # root (a FOLDER for folder-layout types, a FILE for file-layout types).

    @classmethod
    def from_url(cls, url: str, *, branch: str = "", rel_path: str = ".") -> Optional["GitOrigin"]:
        """Build a ``GitOrigin`` from a clone/origin URL.

        ``rel_path='.'`` represents the repository root, used by task-receive
        and project-setup flows that reference a whole repo instead of one
        file-backed asset inside it.
        """
        parsed = parse_git_origin_url(url)
        if not parsed or not is_safe_rel_path(rel_path):
            return None
        provider, owner, name = parsed
        return cls(provider=provider, owner=owner, name=name, branch=branch or "", rel_path=rel_path)

    def clone_url(self) -> str:
        """Canonical HTTPS clone URL for this origin's repository."""
        return git_origin_clone_url(self.provider, self.owner, self.name)

    def key(self) -> str:
        """Deterministic, branch-independent dedup handle.

        ``uuid5`` over ``<canonical-remote-key>:<rel_path>`` — the same asset
        position in the same repo always yields the same key across machines and
        across shares, so "received now" and "cloned later" reconcile by value.
        """
        remote_key = canonical_git_origin_repo_key(self.provider, self.owner, self.name)
        rel = PurePosixPath(self.rel_path.strip().replace("\\", "/")).as_posix()
        return mint_uuid(key=f"{remote_key}:{rel}", namespace=uuid.NAMESPACE_URL)

    def matches_repo(self, repo_path, *, require_branch: bool = False) -> tuple[bool, Optional[str]]:
        """Whether an on-disk checkout at ``repo_path`` is this origin.

        Compares the checkout's ``origin`` remote (as a ``GitOrigin.key()``) and,
        when ``require_branch`` is set, its current branch. Returns
        ``(matches, reason)`` where ``reason`` is a human-readable mismatch
        explanation (``None`` on a match). Runs blocking git subprocesses.
        """
        try:
            remote = git_remote_url(str(repo_path))
            candidate = GitOrigin.from_url(remote, rel_path=self.rel_path or ".") if remote else None
            if not candidate or candidate.key() != self.key():
                return False, "Repository origin does not match"
            if require_branch and self.branch:
                branch = git_current_branch(str(repo_path))
                if branch != self.branch:
                    return False, f"Repository is on branch {branch or 'HEAD'}, expected {self.branch}"
            return True, None
        except Exception:
            return False, "Repository origin does not match"

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
            parsed = parse_git_origin_url(git_remote_url(root))
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
