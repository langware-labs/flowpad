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
from flow_sdk.utils.git_ignore import protect_env_local

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
        from flow_sdk.builtin.faas.git_repo import GitRepo  # noqa: PLC0415
        from flow_sdk.utils.git import find_project_root, git_clone  # noqa: PLC0415

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
                    pulled = await (await GitRepo.local(str(candidate))).pull(branch=origin.branch)
                    if not pulled.ok:
                        logger.info("[git] pull %s for %s: %s", pulled.kind, candidate, pulled.message)
                asset_root = safe_join(candidate, origin.rel_path or ".")
                if asset_root is not None and asset_root.exists():
                    return await resolved(candidate)

        clone_target = preferred_root if clone_here else await asyncio.to_thread(origin.next_clone_target)
        if has_content(clone_target) and origin.matches_checkout(clone_target):
            return await resolved(clone_target)
        cloned = await git_clone(origin.clone_url(), str(clone_target), branch=origin.branch or None, token=token)
        if not cloned.ok:
            raise RuntimeError(cloned.detail)
        await asyncio.to_thread(protect_env_local, clone_target)
        return await resolved(clone_target)

    async def materialize_pinned(
        self,
        origin: FSOrigin,
        *,
        preferred_root: Optional[Path] = None,
        preferred_project_id: Optional[str] = None,
        token: Optional[str] = None,
    ) -> tuple[Path, Optional[str]]:
        """A checkout of EXACTLY ``origin.head_commit`` that never touches the
        receiver's own working copy — the policy for a received git share.

        The receiver's clone of the remote (the repo at ``preferred_root`` — the
        project the share is opened from — on ANY branch) is used directly only when
        it already sits at the commit with the shared path clean. Otherwise the
        commit is fetched into that clone and opened as a detached worktree
        under ``<workspace>/.shared/<leaf>@<commit>`` (reused per commit). With
        no clone at all, the remote is cloned once and the same rule applies.
        No pull, no checkout, no stash on anything the receiver owns.

        An origin without a commit (an older bundle) falls back to
        :meth:`materialize`. Failures raise :class:`GitShareError` with a code.
        """
        commit = getattr(origin, "head_commit", None)
        if not commit:
            return await self.materialize(
                origin, preferred_root=preferred_root, preferred_project_id=preferred_project_id, token=token
            )
        from flow_sdk.utils.git import find_project_root, git_clone  # noqa: PLC0415

        rel = origin.rel_path or "."
        repo: Path | None = None
        if preferred_root is not None and has_content(preferred_root):
            found = await asyncio.to_thread(find_project_root, str(preferred_root))
            if found and origin.matches_checkout(Path(found)):
                repo = Path(found)

        owned_by_receiver = repo is not None
        if repo is None:
            # No project clone to open from: Flowpad keeps ONE clone per remote for
            # shares (never a machine-wide search for one — that walks every
            # project on disk, ~1.2s per miss), kept
            # out of the receiver's projects (a hidden ``.shared/repos`` slot), and
            # the asset opens in a worktree of it like any other share.
            target = await asyncio.to_thread(_shared_clone_slot, origin)
            if not (has_content(target) and origin.matches_checkout(target)):
                cloned = await git_clone(origin.clone_url(), str(target), branch=origin.branch or None, token=token)
                if not cloned.ok:
                    code = _clone_failure_code(cloned.detail)
                    raise GitShareError(code, _HUMAN.get(code) or cloned.detail)
                await asyncio.to_thread(protect_env_local, target)
            repo = target

        if owned_by_receiver and await asyncio.to_thread(_at_commit_and_clean, repo, commit, rel):
            return repo, await _project_id_for_checkout(repo, preferred_root, preferred_project_id)

        await asyncio.to_thread(_ensure_commit, repo, commit, origin.branch)
        slot = await asyncio.to_thread(_worktree_at, repo, commit)
        # A share slot is Flowpad's, never a project of its own: it belongs to the
        # receiver's project when it was opened from that project's clone, else
        # to none (recovering one would MINT a project for a hidden slot).
        return slot, (preferred_project_id if owned_by_receiver else None)

    def matches(self, origin: FSOrigin, local_path: Path) -> bool:
        matched, _reason = origin.matches_repo(local_path, require_branch=True)  # type: ignore[attr-defined]
        return matched

    async def detect(self, asset_root: Path) -> Optional[FSOrigin]:
        from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

        return GitOrigin.for_asset_path(str(asset_root))


class GitShareError(RuntimeError):
    """A received git share could not be opened. ``code`` is one of
    ``no-git`` / ``no-access`` / ``commit-gone`` / ``git-failed``."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


def run_git(repo: Path, *args: str):
    """One blocking git call through the guarded funnel (never wakes macOS's
    developer-tools stub); a missing or unusable git is ``no-git``."""
    from flow_sdk.utils.git import EXIT_NOT_FOUND, _run_git  # noqa: PLC0415

    try:
        result = _run_git(["git", *args], str(repo), timeout=120)
    except FileNotFoundError as exc:
        raise GitShareError("no-git", "git is not installed on this machine") from exc
    if result.returncode == EXIT_NOT_FOUND:
        raise GitShareError("no-git", result.stderr or "git is not usable on this machine")
    return result


#: What the receiver is told, per code (the raw git text stays in the log).
_HUMAN = {
    "no-access": "The repository this was shared from can't be reached from here — it may be private, moved, or offline.",
}


def _clone_failure_code(detail: str) -> str:
    d = (detail or "").lower()
    if "not found" in d and "git" in d and "command" in d:
        return "no-git"
    if any(s in d for s in ("does not exist", "not found", "permission denied", "authentication", "could not read")):
        return "no-access"
    return "git-failed"


def path_is_clean(repo: Path, rel: str) -> bool:
    """No uncommitted or untracked change under ``rel`` in ``repo``."""
    status = run_git(repo, "status", "--porcelain", "-uall", "--", rel)
    return status.returncode == 0 and not status.stdout.strip()


def _at_commit_and_clean(repo: Path, commit: str, rel: str) -> bool:
    from flow_sdk.fs_store.origin.git_origin import _head_commit  # noqa: PLC0415

    return _head_commit(str(repo)) == commit and path_is_clean(repo, rel)


def _ensure_commit(repo: Path, commit: str, branch: str | None) -> None:
    """Make ``commit`` present in ``repo`` — fetch the branch, then the commit
    itself — without moving any ref the receiver works on."""
    if run_git(repo, "cat-file", "-e", f"{commit}^{{commit}}").returncode == 0:
        return
    fetched = run_git(repo, "fetch", "-q", "origin", *([branch] if branch else []))
    if fetched.returncode != 0:
        code = _clone_failure_code(fetched.stderr)
        raise GitShareError(code, _HUMAN.get(code) or fetched.stderr.strip())
    if run_git(repo, "cat-file", "-e", f"{commit}^{{commit}}").returncode == 0:
        return
    run_git(repo, "fetch", "-q", "origin", commit)
    if run_git(repo, "cat-file", "-e", f"{commit}^{{commit}}").returncode != 0:
        raise GitShareError(
            "commit-gone",
            f"The shared version {commit[:12]} is no longer on the remote — ask the sender to share it again.",
        )


def _shared_clone_slot(origin) -> Path:
    """Where Flowpad keeps its own clone of a shared remote: one per remote,
    under the hidden ``<workspace>/.shared/repos`` (never a project)."""
    from flow_sdk.fs_store.origin.git_origin import _slot, _workspace  # noqa: PLC0415
    from flow_sdk.utils.git import derive_repo_leaf_from_url  # noqa: PLC0415

    leaf = derive_repo_leaf_from_url(origin.clone_url()) or origin.name or "repo"
    return _slot(leaf, "repo", accept=lambda p: not has_content(p) or origin.matches_checkout(p),
                 base=_workspace() / ".shared" / "repos")


def remove_share_slot(slot: Path) -> None:
    """Drop a Flowpad-managed share worktree (a ``.shared/<repo>@<commit>``
    slot) — never anything else."""
    if slot.parent.name != ".shared" or not slot.exists():
        return
    run_git(slot, "worktree", "remove", "--force", str(slot))


def _worktree_at(repo: Path, commit: str) -> Path:
    """The detached worktree of ``repo`` at ``commit``, created once and reused."""
    from flow_sdk.fs_store.origin.git_origin import _workspace  # noqa: PLC0415

    common = run_git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
    main_repo = Path(common).parent if common else repo  # a worktree's slot is named after its main repo
    slot = _workspace() / ".shared" / f"{main_repo.name}@{commit[:12]}"
    if slot.exists():
        head = run_git(slot, "rev-parse", "HEAD")
        if head.returncode == 0 and head.stdout.strip() == commit:
            return slot
        run_git(repo, "worktree", "remove", "--force", str(slot))
    slot.parent.mkdir(parents=True, exist_ok=True)
    added = run_git(repo, "worktree", "add", "-q", "--detach", str(slot), commit)
    if added.returncode != 0:
        # A slot deleted by hand stays registered until pruned: prune, try once more.
        run_git(repo, "worktree", "prune")
        added = run_git(repo, "worktree", "add", "-q", "--detach", str(slot), commit)
    if added.returncode != 0:
        raise GitShareError("git-failed", added.stderr.strip())
    return slot


async def _project_id_for_checkout(root: Path, preferred_root: Path | None, preferred_project_id: str | None) -> str | None:
    """The local project a checkout maps to — the caller's own when it named the
    project (and either let the driver place it, or named this very root), else
    the row at that path (or its derived id).

    The caller's id must win BEFORE ``recover_by_path``: that recovery MINTS a row
    for an unknown folder, so a shared project materializing its fresh clone would
    otherwise get a second row at its own path — and lose the id it was shared
    with, which an agent's ``auto_open`` names literally."""
    try:
        if preferred_project_id and (preferred_root is None or root.resolve() == preferred_root.resolve()):
            return preferred_project_id
    except OSError:
        pass
    try:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.recover_by_path(str(root))
        return project.id if project else Project.derive_id_for_path(str(root))
    except Exception:
        return None
