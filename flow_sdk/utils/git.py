import asyncio
import logging
import subprocess
from pathlib import Path
from typing import Optional, Tuple

from .file_system import ROOT_FOLDER

logger = logging.getLogger(__name__)

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


async def git_pull(repo_path: str) -> Tuple[bool, str]:
    """Pull latest from origin for the current branch.

    Returns (success, message).
    """
    try:
        def _run(args, cwd):
            return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=60)

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


async def git_add_commit_push(repo_path: str, paths: list[str], commit_message: str) -> None:
    """Stage the given paths, commit if anything is staged, and push to origin.

    Fire-and-forget: logs warnings on failure but never raises.
    """
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
            return

        await asyncio.to_thread(_run, ["git", "commit", "-m", commit_message], repo_path)
        result = await asyncio.to_thread(_run, ["git", "push", "origin", "HEAD"], repo_path)
        if result.returncode != 0:
            logger.warning("[git] push failed: %s", result.stderr or result.stdout)
        else:
            logger.info("[git] push succeeded")
    except Exception as e:
        logger.warning("[git] push error (non-fatal): %s", e)
