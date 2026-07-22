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

# Env var name the inline git credential helper reads the token from. The helper
# script (below) references only this NAME; the token value lives solely in the
# child process env — never in argv (ps-visible) nor in the clone URL on disk.
_GIT_TOKEN_ENV = "FLOWPAD_GIT_TOKEN"
# `!f() { … }; f` is executed by git via /bin/sh, so `$FLOWPAD_GIT_TOKEN` resolves
# from the child env. GitHub accepts any username with a token (use x-access-token).
_GIT_TOKEN_CREDENTIAL_HELPER = (
    f'!f() {{ echo username=x-access-token; echo "password=${_GIT_TOKEN_ENV}"; }}; f'
)


def _git_token_auth(token: Optional[str]) -> Tuple[list[str], Optional[dict]]:
    """Auth for one git invocation: `(extra argv, child env)`.

    The argv installs an inline `credential.helper` that names the env var; the
    env carries the token itself (never argv, never the on-disk URL) plus
    GIT_TERMINAL_PROMPT=0 so a bad/absent token fails fast instead of hanging.
    `([], None)` when there's no token — a plain public clone.
    """
    if not token:
        return [], None
    return (
        ["-c", f"credential.helper={_GIT_TOKEN_CREDENTIAL_HELPER}"],
        {**os.environ, _GIT_TOKEN_ENV: token, "GIT_TERMINAL_PROMPT": "0"},
    )


@dataclass
class GitPushResult:
    ok: bool
    message: str
    warning: Optional[str] = None


commit_hash = None  # Global variable to store the commit hash


def git_root_folder():
    app_root = ROOT_FOLDER
    app_root = Path(app_root).resolve().parent
    return str(app_root)


def git_commit_hash():
    global commit_hash
    if commit_hash is not None:
        return commit_hash
    result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True, cwd=git_root_folder()
    )
    commit_hash = result.stdout.strip()
    return commit_hash


# ── Per-repo git operations ───────────────────────────────────────────────────

def find_project_root(file_path: str) -> Optional[str]:
    """Walk up from file_path to find the nearest .git directory."""
    p = Path(file_path).resolve()
    for candidate in [p] + list(p.parents):
        if (candidate / ".git").exists():
            return str(candidate)
    return None


def git_remote_url(repo_path: str) -> str:
    """Return the origin remote URL for the given repo, or empty string."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=repo_path, capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def git_current_branch(repo_path: str) -> str:
    """Return the current branch name for the given repo, or empty string."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_path, capture_output=True, text=True, timeout=5,
        )
        branch = result.stdout.strip() if result.returncode == 0 else ""
        return branch if branch and branch != "HEAD" else ""
    except Exception:
        return ""


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
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=path, capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() == clone_url.strip()
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


async def git_pull(repo_path: str, branch: Optional[str] = None) -> Tuple[bool, str]:
    """Pull latest from origin for the given branch, or the current branch if not specified.

    Returns (success, message).
    """
    try:
        def _run(args, cwd):
            return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=60)

        if not branch:
            branch_result = await asyncio.to_thread(
                _run, ["git", "rev-parse", "--abbrev-ref", "HEAD"], repo_path
            )
            branch = branch_result.stdout.strip() if branch_result.returncode == 0 else ""
        if not branch or branch == "HEAD":
            logger.warning("[git] Detached HEAD at %s — skipping pull", repo_path)
            return False, "Skipped git pull (detached HEAD). Files may not be up to date."

        result = await asyncio.to_thread(_run, ["git", "pull", "origin", branch], repo_path)
        if result.returncode == 0:
            out = (result.stdout or "").strip()
            logger.info("[git] pull origin %s succeeded: %s", branch, out)
            return True, out or "Already up to date."
        else:
            err = (result.stderr or result.stdout or "").strip()
            logger.warning("[git] pull origin %s FAILED: %s", branch, err)
            return False, f"Git pull failed: {err}"
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


async def git_add_commit_push(repo_path: str, paths: list[str], commit_message: str) -> GitPushResult:
    """Stage the given paths, commit if anything is staged, and push to origin."""
    try:
        def _run(args, cwd):
            return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=30)

        for path in paths:
            if Path(repo_path, path).exists():
                await asyncio.to_thread(_run, ["git", "add", path], repo_path)

        staged = await asyncio.to_thread(
            _run, ["git", "diff", "--cached", "--quiet"], repo_path
        )
        if staged.returncode == 0:
            logger.info("[git] nothing staged, skipping commit+push")
            return GitPushResult(ok=True, message="Nothing to commit")

        await asyncio.to_thread(_run, ["git", "commit", "-m", commit_message, "--", *paths], repo_path)

        branch_result = await asyncio.to_thread(
            _run, ["git", "rev-parse", "--abbrev-ref", "HEAD"], repo_path
        )
        current_branch = branch_result.stdout.strip() if branch_result.returncode == 0 else "HEAD"
        if not current_branch or current_branch == "HEAD":
            current_branch = "HEAD"

        pull_warning: Optional[str] = None
        pull_result = await asyncio.to_thread(
            _run, ["git", "pull", "--rebase", "origin", current_branch], repo_path
        )
        if pull_result.returncode != 0:
            pull_output = (pull_result.stderr or pull_result.stdout or "").strip()
            if "couldn't find remote ref" in pull_output:
                # Branch doesn't exist on remote yet — push will create it
                logger.info("[git] branch '%s' not yet on remote, skipping pull --rebase", current_branch)
            else:
                pull_warning = pull_output
                logger.warning("[git] pull --rebase before push failed: %s", pull_warning)

        result = await asyncio.to_thread(_run, ["git", "push", "origin", current_branch], repo_path)
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            logger.warning("[git] push failed: %s", err)
            return GitPushResult(ok=False, message=err, warning=pull_warning)
        else:
            logger.info("[git] push succeeded")
            return GitPushResult(ok=True, message="Pushed successfully", warning=pull_warning)
    except Exception as e:
        logger.warning("[git] push error (non-fatal): %s", e)
        return GitPushResult(ok=False, message=str(e))


# ── Per-file revision history (local, no push) ────────────────────────────────

_LOG_SEP = "\x1f"


def _run_git(args: list[str], cwd: str, timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)


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
        args = ["git", "log"]
        if not target.is_dir():
            args.append("--follow")
        args.extend(["--format=%aI", "--diff-filter=A", "--", rel_path])
        result = _run_git(args, root)
        if result.returncode != 0:
            return None
        dates: list[datetime] = []
        for line in result.stdout.splitlines():
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
    except (OSError, ValueError, subprocess.SubprocessError):
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
