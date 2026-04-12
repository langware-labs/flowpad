import asyncio
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

from .file_system import ROOT_FOLDER

logger = logging.getLogger(__name__)


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


def find_local_repo_for_url(project_url: str) -> Optional[str]:
    """Find a local repo whose origin URL matches project_url."""
    if not project_url:
        return None
    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    for project_root in iter_claude_project_paths():
        try:
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                cwd=str(project_root), capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip() == project_url.strip():
                return str(project_root)
        except Exception:
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
