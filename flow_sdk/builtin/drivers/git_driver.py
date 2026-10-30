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
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING, Iterator, Optional

from flow_sdk.fs_store.origin.fs_origin import FSOrigin, safe_join
from flow_sdk.fs_store.origin.git_origin import has_content
from flow_sdk.utils.git_ignore import protect_env_local

if TYPE_CHECKING:
    from flow_sdk.builtin.git_share_specs import ReceivePlan

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

    async def receive(
        self,
        origin: FSOrigin,
        *,
        preferred_root: Optional[Path] = None,
        preferred_project_id: Optional[str] = None,
        token: Optional[str] = None,
    ) -> tuple[Path, Optional[str]]:
        """Bring a received git share into the receiver's OWN checkout — the
        policy for a received git share. There is no second copy: the asset
        lives where a ``git pull`` would put it.

        The checkout is the repo at ``preferred_root`` (the project the share is
        opened in) when it is a clone of the shared remote, on any branch. The
        shared commit is fetched into it, then :func:`plan_receive` decides:
        ``have`` opens in place; ``pull`` / ``cherry_pick`` write the receiver's
        branch, so they run only with the receiver's consent
        (:func:`share_consent`) — without it :class:`NeedsApply` carries the plan
        back to ask. A conflict is left in place for the resolve flow
        (``GitShareError("conflict")``).

        An origin without a commit (an older bundle) falls back to
        :meth:`materialize`. No checkout of the remote: ``no-checkout``.
        """
        commit = getattr(origin, "head_commit", None)
        if not commit:
            return await self.materialize(
                origin, preferred_root=preferred_root, preferred_project_id=preferred_project_id, token=token
            )
        repo = await asyncio.to_thread(_receiver_checkout, origin, preferred_root)
        if repo is None:
            raise GitShareError("no-checkout", _HUMAN["no-checkout"])
        await asyncio.to_thread(_ensure_commit, repo, commit, origin.branch)
        plan = await asyncio.to_thread(plan_receive, repo, origin)
        if plan.action != "have":
            if not _CONSENT.get():
                raise NeedsApply(plan)
            await _apply(repo, plan, origin)
        return repo, await _project_id_for_checkout(repo, preferred_root, preferred_project_id)

    def matches(self, origin: FSOrigin, local_path: Path) -> bool:
        matched, _reason = origin.matches_repo(local_path, require_branch=True)  # type: ignore[attr-defined]
        return matched

    async def detect(self, asset_root: Path) -> Optional[FSOrigin]:
        from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

        return GitOrigin.for_asset_path(str(asset_root))


class GitShareError(RuntimeError):
    """A received git share could not be opened. ``code`` is one of
    ``no-git`` / ``no-access`` / ``commit-gone`` / ``no-checkout`` /
    ``conflict`` / ``git-failed``. ``data`` carries what the UI acts on (a
    conflict's ``conflicted`` paths, ``operation``, ``branch``, ``workdir``)."""

    def __init__(self, code: str, detail: str = "", data: Optional[dict] = None) -> None:
        super().__init__(detail or code)
        self.code = code
        self.data = data or {}


    @property
    def keeps_copy_out(self) -> bool:
        """The receiver's checkout is mid-merge: a ``both`` share must not lay
        its copy over it — the conflict is reported, never fallen back from."""
        return self.code == "conflict"


class NeedsApply(Exception):
    """Bringing the share in would write the receiver's branch (a pull or a
    cherry-pick): the plan goes back to ask first."""

    def __init__(self, plan: "ReceivePlan") -> None:
        super().__init__(plan.action)
        self.plan = plan

    def answer(self) -> dict:
        """The question every receive verb answers with: ``needs: "apply"`` and the plan."""
        return {"needs": "apply", "plan": self.plan.model_dump(mode="json")}


#: The receiver said yes to bringing the share into their checkout — set for
#: one request by :func:`share_consent`, read by :meth:`GitOriginDriver.receive`
#: wherever in the install the receive happens.
_CONSENT: ContextVar[bool] = ContextVar("git_share_consent", default=False)


@contextmanager
def share_consent(apply: bool) -> Iterator[None]:
    token = _CONSENT.set(bool(apply))
    try:
        yield
    finally:
        _CONSENT.reset(token)


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
    "no-checkout": "You don't have this repository in a project here — clone it as a project to open what was shared.",
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


def _receiver_checkout(origin, preferred_root: Path | None) -> Path | None:
    """The receiver's own clone of the shared remote: the repo holding
    ``preferred_root``, on any branch. Never a machine-wide search, never a
    clone of Flowpad's own."""
    from flow_sdk.utils.git import find_project_root  # noqa: PLC0415

    if preferred_root is None or not has_content(preferred_root):
        return None
    found = find_project_root(str(preferred_root))
    return Path(found) if found and origin.matches_checkout(Path(found)) else None


def _out(repo: Path, *args: str) -> str | None:
    r = run_git(repo, *args)
    return r.stdout.strip() if r.returncode == 0 else None


def missing_commits(repo: Path, rev: str, rel: str) -> list[str]:
    """Commits up to ``rev`` that touch ``rel`` and are not on HEAD yet, oldest
    first — one already cherry-picked here (the same patch) counts as there.
    The cheap ancestry walk answers first; patch ids are computed only when it
    finds something."""
    if not _out(repo, "rev-list", "-1", f"HEAD..{rev}", "--", rel):
        return []
    listed = _out(repo, "rev-list", "--reverse", "--right-only", "--cherry-pick", f"HEAD...{rev}", "--", rel)
    return (listed or "").split()


def plan_receive(repo: Path, origin) -> "ReceivePlan":
    """How the shared commit comes into ``repo`` (see ``ReceivePlan``). Read-only."""
    from flow_sdk.builtin.git_share_specs import ReceivePlan  # noqa: PLC0415

    from flow_sdk.utils.git import git_current_branch  # noqa: PLC0415

    commit, rel = origin.head_commit, origin.rel_path or "."
    branch = git_current_branch(str(repo)) or "HEAD"

    def plan(action: str, **kw) -> ReceivePlan:
        return ReceivePlan(action=action, commit=commit, branch=branch, workdir=str(repo), **kw)

    def obj(rev: str) -> str | None:
        return _out(repo, "rev-parse", "-q", "--verify", f"{rev}:{rel}" if rel != "." else f"{rev}^{{tree}}")

    held = obj("HEAD")
    if held is not None and held == obj(commit):
        return plan("have")
    if origin.branch and branch == origin.branch and _out(repo, "rev-parse", "--abbrev-ref", "@{u}"):
        on_upstream = lambda: run_git(repo, "merge-base", "--is-ancestor", commit, "@{u}").returncode == 0  # noqa: E731
        # The local upstream usually has it already; fetch only when it does not.
        if on_upstream() or (run_git(repo, "fetch", "-q", "origin", origin.branch).returncode == 0 and on_upstream()):
            return plan("pull")
    commits = missing_commits(repo, commit, rel)
    if not commits:
        # Every change the shared line made to the asset is already on this
        # branch (the receiver edited it since): what they have is theirs.
        return plan("have")
    prefix = "" if rel == "." else rel.rstrip("/") + "/"
    touched = _out(repo, "log", "--no-walk=unsorted", "--name-only", "--format=", *commits) or ""
    other = {f for f in touched.splitlines() if f and prefix and f != rel and not f.startswith(prefix)}
    return plan("cherry_pick", commits=commits, other_files=sorted(other))


async def _apply(repo: Path, plan: "ReceivePlan", origin) -> None:
    """Run the plan's git verb on the receiver's checkout; a refusal or a
    conflict is a ``GitShareError`` carrying what the resolve flow needs."""
    from flow_sdk.builtin.faas.git_repo import GitRepo  # noqa: PLC0415

    git = await GitRepo.local(str(repo))
    if plan.action == "pull":
        done = await git.pull(branch=origin.branch)
        op = "pull"
    else:
        done = await git.cherry_pick(plan.commits)
        op = "cherry-pick"
    if done.ok:
        return
    data = {"operation": op, "branch": done.branch, "workdir": str(repo), "conflicted": done.conflicted}
    code = "conflict" if done.kind == "conflict" else ("no-access" if done.kind == "permission" else "git-failed")
    raise GitShareError(code, done.message, data)


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
