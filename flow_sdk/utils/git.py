import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

from .file_system import ROOT_FOLDER

logger = logging.getLogger(__name__)

@dataclass
class GitPushResult:
    ok: bool
    message: str
    warning: Optional[str] = None
    #: HEAD after a successful commit — the thing a caller advertises to others.
    sha: Optional[str] = None
    #: False when the paths were already clean (``ok`` is still True).
    committed: bool = False
    pushed: bool = False
    branch: Optional[str] = None


commit_hash = None  # Global variable to store the commit hash


def git_root_folder():
    app_root = ROOT_FOLDER
    app_root = Path(app_root).resolve().parent
    return str(app_root)


def git_commit_hash():
    global commit_hash
    if commit_hash is not None:
        return commit_hash
    commit_hash = _sync(git_root_folder(), "rev-parse", "--short", "HEAD")
    return commit_hash


# ── Per-repo git operations ───────────────────────────────────────────────────

def _sync(repo_path: str, *args: str, timeout: int = 10) -> str:
    """One blocking git call, through GitFolder. Returns trimmed stdout, "" on failure.

    The synchronous helpers below are path-math conveniences used from
    non-async call sites (the indexer, entity constructors). They route through
    ``GitFolder.git_sync`` so argv construction, token handling and env live in
    exactly one place, even though the callers cannot await.
    """
    from flow_sdk.utils.git_folder import GitFolder  # noqa: PLC0415 - avoids an import cycle

    try:
        result = GitFolder(repo_path).git_sync(*args, timeout=timeout)
    except Exception:  # noqa: BLE001 - these helpers answer "" rather than raising
        return ""
    return result.stdout.strip() if result.ok else ""


def find_project_root(file_path: str) -> Optional[str]:
    """Walk up from file_path to find the nearest .git directory."""
    p = Path(file_path).resolve()
    for candidate in [p] + list(p.parents):
        if (candidate / ".git").exists():
            return str(candidate)
    return None


def git_remote_url(repo_path: str) -> str:
    """The origin URL of a checkout, or "" when there is none."""
    return _sync(repo_path, "config", "--get", "remote.origin.url")


def git_current_branch(repo_path: str) -> str:
    """The checked-out branch, or "" when detached or not a repo."""
    branch = _sync(repo_path, "rev-parse", "--abbrev-ref", "HEAD")
    return "" if branch == "HEAD" else branch


def git_repo_full_name(repo_path: str) -> str:
    """Extract 'owner/repo' from origin URL (handles https and ssh). Returns empty string if not found."""
    url = git_remote_url(repo_path)
    if not url:
        return ""
    m = re.search(r'[:/]([^/:\s]+/[^/:\s]+?)(?:\.git)?$', url)
    return m.group(1) if m else ""


def derive_repo_leaf_from_url(clone_url: str) -> str:
    """Extract the repo folder name from a git URL.

    Handles https / ssh / scp-style git URLs:
      https://github.com/foo/bar.git   → bar
      git@github.com:foo/bar.git       → bar
      https://example.com/some/repo/   → repo
    Returns empty string when the URL has no usable trailing segment.
    """
    if not clone_url:
        return ""
    leaf = clone_url.strip().rstrip("/").split("/")[-1]
    # ssh form `git@host:owner/repo.git` leaves "owner/repo.git" or just "repo.git"
    if ":" in leaf and "/" not in leaf:
        leaf = leaf.split(":")[-1]
    if leaf.endswith(".git"):
        leaf = leaf[:-4]
    return leaf


def _url_matches(path: str, clone_url: str) -> bool:
    """Return True if the git repo at path has an origin URL matching clone_url."""
    try:
        return git_remote_url(path) == clone_url.strip()
    except Exception:
        return False


def find_local_repo_for_url(clone_url: str) -> Optional[str]:
    """Find a local repo whose origin URL matches clone_url.

    Pass 1: Claude-registered projects (fast, authoritative).
    Pass 2: Immediate siblings of those projects — covers repos that exist
            on disk but were never opened in Claude.
    """
    if not clone_url:
        return None

    from pathlib import Path as _Path

    from flow_sdk.fs_store.indexer.functions._claude_projects import iter_claude_project_paths

    claude_paths = list(iter_claude_project_paths())

    # Pass 1: Claude-registered projects
    for project_root in claude_paths:
        if _url_matches(str(project_root), clone_url):
            return str(project_root)

    # Pass 2: siblings — scan one level inside each unique parent directory
    seen_parents: set[_Path] = set()
    for project_root in claude_paths:
        parent = _Path(project_root).parent
        if parent in seen_parents:
            continue
        seen_parents.add(parent)
        try:
            for sibling in parent.iterdir():
                if not sibling.is_dir() or sibling == _Path(project_root):
                    continue
                if (sibling / ".git").exists() and _url_matches(str(sibling), clone_url):
                    return str(sibling)
        except OSError:
            continue

    return None


async def git_sync_mirror(repo_path: str, branch: Optional[str] = None) -> Tuple[bool, bool, str]:
    """Force a checkout to match its remote, discarding local changes.

    Thin wrapper over :meth:`GitFolder.sync_mirror` — the mechanics live there.
    Kept as a function because callers want the ``(ok, changed, message)`` shape
    rather than an exception: a mirror sync failing is routine, not exceptional.

    ``changed`` means **the working tree is not what it was** (do I need to
    re-index?), NOT merely "did HEAD move".
    """
    from flow_sdk.utils.git_folder import GitError, GitFolder  # noqa: PLC0415 - avoids an import cycle

    try:
        changed = await GitFolder(repo_path).sync_mirror(branch)
        return True, changed, "Updated." if changed else "Already up to date."
    except GitError as e:
        logger.warning("[git] mirror sync failed: %s", e.code)
        return False, False, f"Git mirror sync failed: {e.code}"
    except Exception as e:  # noqa: BLE001 - a mirror sync must never raise at a call site
        logger.warning("[git] mirror sync error: %s", e)
        return False, False, f"Git mirror sync error: {e}"


async def git_pull(repo_path: str, branch: Optional[str] = None) -> Tuple[bool, str]:
    """Pull latest from origin, preserving local changes. Returns (success, message)."""
    from flow_sdk.utils.git_folder import GitError, GitFolder  # noqa: PLC0415

    try:
        out = await GitFolder(repo_path).pull(branch)
        return True, out or "Already up to date."
    except GitError as e:
        logger.warning("[git] pull failed: %s", e.code)
        return False, f"Git pull failed: {e.code}"
    except Exception as e:  # noqa: BLE001
        logger.warning("[git] pull error: %s", e)
        return False, f"Git pull error: {e}"


async def git_clone(
    clone_url: str, target_dir: str, branch: Optional[str] = None, token: Optional[str] = None
) -> Tuple[bool, str]:
    """Clone ``clone_url`` into ``target_dir``. Returns (success, message).

    The token reaches git through an inline credential helper reading a child-env
    variable — never argv, never the on-disk URL. That is enforced once, in
    :class:`GitFolder`.
    """
    from flow_sdk.utils.git_folder import GitError, GitFolder  # noqa: PLC0415

    try:
        await GitFolder.clone(clone_url, target_dir, branch=branch, token=token)
        logger.info("[git] clone %s into %s succeeded", clone_url, target_dir)
        return True, "Cloned successfully."
    except GitError as e:
        logger.warning("[git] clone %s FAILED: %s", clone_url, e.code)
        return False, f"Git clone failed: {e.code}"
    except Exception as e:  # noqa: BLE001
        logger.warning("[git] clone error: %s", e)
        return False, f"Git clone error: {e}"


async def git_remote_access(clone_url: str, token: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    """Can we read ``clone_url``, and what is its default branch?

    Delegates to :meth:`GitFolder.remote_access`. Kept as a function returning
    ``(accessible, default_branch)`` because "not reachable" is an answer here,
    not an error.
    """
    from flow_sdk.utils.git_folder import GitFolder  # noqa: PLC0415

    try:
        return await GitFolder.remote_access(clone_url, token=token)
    except Exception as e:  # noqa: BLE001
        logger.warning("[git] ls-remote error for %s: %s", clone_url, e)
        return False, None


async def git_add_commit_push(repo_path: str, paths: list[str], commit_message: str) -> GitPushResult:
    """Stage exactly ``paths``, commit them, and push the branch.

    Pathspec-scoped throughout: an unrelated dirty or staged file elsewhere in
    the repo is never committed. That is the whole point — callers use this to
    publish a couple of known files out of a working tree they do not own.

    Three things this is careful about, each of which was a real defect:

    * **The staged check carries the pathspec.** Without it, an unrelated
      pre-staged file makes an otherwise-clean run believe our paths changed.
    * **The commit's return code is checked.** A pathspec that matches nothing
      fails the commit; pushing anyway and reporting success would advertise a
      URL for content that never reached the remote.
    * **Only paths that exist are passed on.** A missing path is what makes
      ``git commit`` fail in the first place.

    ``ok=True`` with ``committed=False`` means the paths were already clean —
    a successful no-op, not a failure.
    """
    try:
        from flow_sdk.utils.git_folder import GitFolder  # noqa: PLC0415

        folder = GitFolder(repo_path)

        async def _run(*args):
            return await folder.git(*args, timeout=30)

        present, missing = [], []
        for path in paths:
            (present if Path(repo_path, path).exists() else missing).append(path)
        if not present:
            return GitPushResult(ok=False, message=f"none of the given paths exist in {repo_path}: {paths}")
        missing_warning = f"not found, so not committed: {', '.join(missing)}" if missing else None

        # One invocation for every path — same semantics, one process.
        await _run("add", "--", *present)

        # Scoped to OUR paths, so somebody else's staged work doesn't read as ours.
        staged = await _run("diff", "--cached", "--quiet", "--", *present)
        branch_result = await _run("rev-parse", "--abbrev-ref", "HEAD")
        current_branch = (branch_result.stdout.strip() if branch_result.returncode == 0 else "") or "HEAD"

        if staged.returncode == 0:
            logger.info("[git] paths already committed, nothing to do")
            return GitPushResult(
                ok=True,
                message="Nothing to commit",
                branch=current_branch,
                warning=missing_warning,
            )

        commit = await _run("commit", "-m", commit_message, "--", *present)
        if commit.returncode != 0:
            err = (commit.stderr or commit.stdout or "").strip()
            logger.warning("[git] commit failed: %s", err)
            return GitPushResult(ok=False, message=err or "git commit failed", branch=current_branch)

        head = await _run("rev-parse", "HEAD")
        sha = head.stdout.strip() if head.returncode == 0 else None

        # Rebase only when the upstream actually moved. An unconditional pull
        # aborts on an unrelated dirty tree, and swallowing that failure turns
        # into a confusing non-fast-forward push rejection one step later.
        pull_warning: Optional[str] = None
        behind = await _run("rev-list", "--count", "HEAD..@{u}")
        if behind.returncode == 0 and (behind.stdout.strip() or "0") != "0":
            pull_result = await _run("pull", "--rebase", "origin", current_branch)
            if pull_result.returncode != 0:
                pull_warning = (pull_result.stderr or pull_result.stdout or "").strip()
                logger.warning("[git] pull --rebase before push failed: %s", pull_warning)

        result = await _run("push", "origin", current_branch)
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            logger.warning("[git] push failed: %s", err)
            return GitPushResult(
                ok=False, message=err, warning=pull_warning, sha=sha, committed=True, branch=current_branch
            )
        logger.info("[git] push succeeded")
        return GitPushResult(
            ok=True,
            message="Pushed successfully",
            warning=pull_warning or missing_warning,
            sha=sha,
            committed=True,
            pushed=True,
            branch=current_branch,
        )
    except Exception as e:
        logger.warning("[git] push error (non-fatal): %s", e)
        return GitPushResult(ok=False, message=str(e))



# ── Per-file revision history (local, no push) ────────────────────────────────

_LOG_SEP = "\x1f"


def git_asset_introduction(path: str) -> datetime | None:
    """Return the earliest commit that introduced a local file/folder asset.

    File history follows renames. Folder history is pathspec-scoped and chooses
    the earliest tracked child addition. The probe is best-effort and bounded
    by ``_run_git``'s process timeout; callers run it off the event loop and only
    for actual collision groups.
    """
    try:
        root = find_project_root(path)
        if root is None:
            return None
        target = Path(path).resolve()
        rel_path = target.relative_to(Path(root).resolve()).as_posix()
        args = ["log"]
        if not target.is_dir():
            args.append("--follow")
        args.extend(["--format=%aI", "--diff-filter=A", "--", rel_path])
        out = _sync(root, *args)
        if not out:
            return None
        dates: list[datetime] = []
        for line in out.splitlines():
            try:
                parsed = datetime.fromisoformat(line.strip().replace("Z", "+00:00"))
            except ValueError:
                continue
            dates.append(
                parsed.replace(tzinfo=timezone.utc)
                if parsed.tzinfo is None
                else parsed.astimezone(timezone.utc)
            )
        return min(dates) if dates else None
    except (OSError, ValueError):
        return None


async def git_commit_file(repo_path: str, rel_file: str, message: str) -> bool:
    """Stage and commit a single pathspec — a file OR a folder (no push).

    Pathspec-scoped via :meth:`GitFolder.commit`, so concurrent edits outside the
    pathspec are never swept in. Returns False when there was nothing to commit.
    Best-effort; never raises — an auto-commit must not break a save.
    """
    from flow_sdk.utils.git_folder import GitFolder  # noqa: PLC0415

    try:
        if not Path(repo_path, rel_file).exists():
            return False
        return await GitFolder(repo_path).commit([rel_file], message) is not None
    except Exception as e:  # noqa: BLE001 — auto-commit must never break a save
        logger.warning("[git] commit_file error (non-fatal): %s", e)
        return False
