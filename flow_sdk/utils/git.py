import asyncio
import logging
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

from .file_system import ROOT_FOLDER

logger = logging.getLogger(__name__)

# The credential-helper script and its env-var name are DEFINED ONCE, in
# git_folder. Re-declaring them here is how a security-critical path drifts: the
# copy immediately lost ``GIT_TERMINAL_PROMPT=0`` on the no-token branch, which
# turns a bad URL into a hang instead of a fast failure.
def _git_token_auth(token: Optional[str]) -> Tuple[list[str], Optional[dict]]:
    """Auth for one git invocation: `(extra argv, child env)`.

    The argv installs an inline `credential.helper` that names the env var; the
    env carries the token itself (never argv, never the on-disk URL) plus
    GIT_TERMINAL_PROMPT=0 so a bad/absent token fails fast instead of hanging.
    `([], None)` when there's no token — a plain public clone.
    """
    from flow_sdk.utils.git_folder import CREDENTIAL_HELPER, GIT_TOKEN_ENV  # noqa: PLC0415

    # GIT_TERMINAL_PROMPT=0 on BOTH branches: without a token a private or
    # mistyped URL must fail fast, not block on a credential prompt until the
    # command timeout.
    if not token:
        return [], {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    return (
        ["-c", f"credential.helper={CREDENTIAL_HELPER}"],
        {**os.environ, GIT_TOKEN_ENV: token, "GIT_TERMINAL_PROMPT": "0"},
    )


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

def _run_git(args: list[str], cwd: str, timeout: int = 10) -> subprocess.CompletedProcess:
    """One blocking git invocation.

    These helpers are cheap LOCAL probes (does this path sit in a repo? what is
    its origin?) called from synchronous code — the indexer, entity
    constructors, route handlers. They are not "git operations on a repository"
    and deliberately do not go through ``GitFolder``/``CommandExecutor``, which
    is async and reached only via a ComputeNode.
    """
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def _sync(repo_path: str, *args: str, timeout: int = 10) -> str:
    """Trimmed stdout of a local git probe, or "" on any failure."""
    try:
        result = _run_git(["git", *args], repo_path, timeout=timeout)
    except Exception:  # noqa: BLE001 - these helpers answer "" rather than raising
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


async def _git(args: list[str], cwd: str, timeout: int = 60) -> subprocess.CompletedProcess:
    """One git invocation, off the event loop. The async sibling of ``_run_git``."""
    return await asyncio.to_thread(_run_git, args, cwd, timeout)


async def _checked_out_branch(repo_path: str) -> Optional[str]:
    """The branch a checkout is on, or ``None`` when detached.

    Shared by ``git_pull`` and ``git_sync_mirror``: both must refuse to act on a
    detached HEAD, and that rule should not live in two places.
    """
    return await asyncio.to_thread(git_current_branch, repo_path) or None


def _git_err(result: subprocess.CompletedProcess, verb: str) -> str:
    """One phrasing for a failed invocation. `stderr or stdout` in one place, so
    the fallback order cannot drift between call sites."""
    err = (result.stderr or result.stdout or "").strip()
    logger.warning("[git] %s FAILED: %s", verb, err)
    return f"Git {verb} failed: {err}"


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

    For a MIRROR — a checkout the app manages and the user never edits — as
    opposed to ``git_pull``, which is for a working tree whose local changes
    must be preserved. Use it only where local modifications are known to be
    machine-made and disposable; it throws away uncommitted work.

    Returns ``(ok, changed, message)``. ``changed`` means **the working tree is
    not what it was**, which is the question a caller actually asks (do I need
    to re-index?) — NOT merely "did HEAD move". Those differ in exactly the case
    this function exists for: when the remote has not moved but the tree is
    dirty with index stamps, the reset rewrites those files, and reporting
    "nothing changed" there would tell the caller to skip an index that the
    reset just invalidated.

    It is reported explicitly rather than encoded into ``message``: recovering
    it by substring-matching English prose breaks the moment the wording or the
    locale changes.
    """
    try:
        branch = branch or await _checked_out_branch(repo_path)
        if not branch:
            return False, False, "Skipped sync (detached HEAD)."

        # Dirty BEFORE the reset: the reset is about to revert these, so they
        # count as a change even when no new commit arrives.
        status = await _git(["git", "status", "--porcelain"], repo_path)
        was_dirty = bool(status.stdout.strip()) if status.returncode == 0 else False

        before = await _git(["git", "rev-parse", "HEAD"], repo_path)
        fetch = await _git(["git", "fetch", "origin", branch], repo_path)
        if fetch.returncode != 0:
            return False, False, _git_err(fetch, f"fetch origin {branch}")

        # Compare against the ref we just fetched rather than re-reading HEAD
        # after the reset — same answer, one subprocess fewer.
        remote = await _git(["git", "rev-parse", f"origin/{branch}"], repo_path)
        moved = before.stdout.strip() != remote.stdout.strip()

        reset = await _git(["git", "reset", "--hard", f"origin/{branch}"], repo_path)
        if reset.returncode != 0:
            return False, False, _git_err(reset, f"reset --hard origin/{branch}")

        # Indexing also CREATES files (folder capsules, sidecars); `reset --hard`
        # leaves untracked ones behind, so a mirror has to clean them too or it
        # is only half a mirror.
        await _git(["git", "clean", "-fd"], repo_path)

        changed = moved or was_dirty
        logger.info("[git] mirror synced to origin/%s (moved=%s dirty=%s)", branch, moved, was_dirty)
        return True, changed, "Updated." if moved else ("Restored." if was_dirty else "Already up to date.")
    except Exception as e:
        logger.warning("[git] mirror sync error: %s", e)
        return False, False, f"Git mirror sync error: {e}"


async def git_pull(repo_path: str, branch: Optional[str] = None) -> Tuple[bool, str]:
    """Pull latest from origin for the given branch, or the current branch if not specified.

    For a WORKING TREE whose local changes must be preserved — the opposite of
    ``git_sync_mirror``, which discards them.

    Returns (success, message).
    """
    try:
        branch = branch or await _checked_out_branch(repo_path)
        if not branch:
            logger.warning("[git] Detached HEAD at %s — skipping pull", repo_path)
            return False, "Skipped git pull (detached HEAD). Files may not be up to date."

        result = await _git(["git", "pull", "origin", branch], repo_path)
        if result.returncode == 0:
            out = (result.stdout or "").strip()
            logger.info("[git] pull origin %s succeeded: %s", branch, out)
            return True, out or "Already up to date."
        return False, _git_err(result, f"pull origin {branch}")
    except Exception as e:
        logger.warning("[git] pull error: %s", e)
        return False, f"Git pull error: {e}"


async def git_clone(
    clone_url: str, target_dir: str, branch: Optional[str] = None, token: Optional[str] = None
) -> Tuple[bool, str]:
    """Clone clone_url into target_dir, optionally checking out branch.

    When ``token`` is given (a GitHub access token), the clone authenticates via
    an inline credential helper that reads the token from the child env — so
    private repos work and the token never touches argv or the on-disk URL.

    Returns (success, message).
    """
    try:
        auth_args, env = _git_token_auth(token)
        cmd = ["git", *auth_args, "clone", clone_url, target_dir]
        if branch:
            cmd += ["--branch", branch]

        def _run(args):
            return subprocess.run(args, capture_output=True, text=True, timeout=120, env=env)

        result = await asyncio.to_thread(_run, cmd)
        if result.returncode == 0:
            out = (result.stdout or result.stderr or "").strip()
            logger.info("[git] clone %s into %s succeeded", clone_url, target_dir)
            return True, out or "Cloned successfully."
        else:
            err = (result.stderr or result.stdout or "").strip()
            logger.warning("[git] clone %s FAILED: %s", clone_url, err)
            return False, f"Git clone failed: {err}"
    except Exception as e:
        logger.warning("[git] clone error: %s", e)
        return False, f"Git clone error: {e}"


async def git_remote_access(clone_url: str, token: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    """Can we read ``clone_url``, and what is its default branch?

    ``git ls-remote --symref <url> HEAD`` is the cheap, provider-agnostic
    reachability probe: it answers for public repos anonymously and for private
    ones with ``token``, without fetching a single object. Same credential path
    as ``git_clone``, so "the check passed" and "the clone will work" cannot
    disagree.

    Returns (accessible, default_branch or None).
    """
    try:
        auth_args, env = _git_token_auth(token)
        env = {**(env or os.environ), "GIT_TERMINAL_PROMPT": "0"}
        cmd = ["git", *auth_args, "ls-remote", "--symref", clone_url, "HEAD"]

        def _run():
            return subprocess.run(cmd, capture_output=True, text=True, timeout=20, env=env)

        result = await asyncio.to_thread(_run)
        if result.returncode != 0:
            logger.info("[git] ls-remote %s denied: %s", clone_url, (result.stderr or "").strip()[:200])
            return False, None
        # "ref: refs/heads/main\tHEAD" — the symref line names the default branch.
        for line in (result.stdout or "").splitlines():
            if line.startswith("ref:") and "refs/heads/" in line:
                return True, line.split("refs/heads/", 1)[1].split()[0].strip()
        return True, None
    except Exception as e:
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
        async def _run(*args):
            return await asyncio.to_thread(_run_git, ["git", *args], repo_path, 30)

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
    """Stage and commit a single pathspec — a file OR a folder (no push). Returns
    True if a commit was made.

    Pathspec-scoped: ``git add -- <pathspec>`` then ``git commit -- <pathspec>`` so
    concurrent edits outside the pathspec are never swept in. A folder pathspec
    (a folder-backed asset, e.g. a skill) commits every change under it. No-ops
    (returns False) when the pathspec has no staged delta. Best-effort; never raises.
    """
    try:
        if not Path(repo_path, rel_file).exists():
            return False
        await asyncio.to_thread(_run_git, ["git", "add", "--", rel_file], repo_path)
        staged = await asyncio.to_thread(
            _run_git, ["git", "diff", "--cached", "--quiet", "--", rel_file], repo_path
        )
        if staged.returncode == 0:
            return False  # nothing staged for this file
        result = await asyncio.to_thread(
            _run_git, ["git", "commit", "-m", message, "--", rel_file], repo_path
        )
        return result.returncode == 0
    except Exception as e:  # noqa: BLE001 — auto-commit must never break a save
        logger.warning("[git] commit_file error (non-fatal): %s", e)
        return False
