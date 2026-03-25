"""GitRepo — thin wrapper around git for a given working directory.

Used by ComputeNode action handlers (git-ops catch-all).  Not a DB entity;
instantiated per-request.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.compute_node import ComputeNode

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Response models — serialize to camelCase via alias_generator (same pattern
# as process.py / project.py).
# ---------------------------------------------------------------------------

class _CamelModel(BaseModel):
    """Base for git response models — serializes to camelCase via alias_generator."""
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GitStatusFile(_CamelModel):
    status: str
    path: str
    insertions: int | None = None
    deletions: int | None = None


class GitStatus(_CamelModel):
    error: str | None = None
    branch: str | None = None
    ahead: int = 0
    behind: int = 0
    files: list[GitStatusFile] = []


class GitBranchData(_CamelModel):
    branch: str | None


class GitIsInitData(_CamelModel):
    is_init: bool


class GitIsLinkedWorktreeData(_CamelModel):
    is_linked_worktree: bool


class GitHasCommitData(_CamelModel):
    has_commit: bool


# ---------------------------------------------------------------------------
# GitRepo
# ---------------------------------------------------------------------------

class GitRepo:
    """Run git operations for a specific working directory via a ComputeNode."""

    def __init__(self, work_dir: str, compute_node: "ComputeNode") -> None:
        self.work_dir = work_dir
        self._compute_node = compute_node

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run_git(self, *args: str) -> tuple[str, int]:
        """Run a git sub-command inside self.work_dir via the compute node.

        Returns (stdout_stripped, returncode).
        """
        try:
            cmd = await self._compute_node.run_command(
                f"git -C '{self.work_dir}' " + " ".join(args),
                background=False,
            )
            return (cmd.all_stdout or "").rstrip("\n"), cmd.exit_code or 0
        except Exception:
            logger.debug("git command failed: git %s", " ".join(args), exc_info=True)
            return "", 1

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def is_init(self) -> bool:
        """Return True if work_dir is inside a git repository."""
        _, rc = await self._run_git("rev-parse", "--is-inside-work-tree")
        return rc == 0

    async def is_linked_worktree(self) -> bool:
        """Return True if work_dir is a linked worktree (not the main one).

        Runs ``git rev-parse --git-dir`` and checks whether the output
        contains ``.git/worktrees/``.
        """
        git_dir, rc = await self._run_git("rev-parse", "--git-dir")
        if rc != 0:
            return False
        return ".git/worktrees/" in git_dir

    async def has_commit(self) -> bool:
        """Return True if the repo has at least one commit (HEAD exists)."""
        _, rc = await self._run_git("rev-parse", "HEAD")
        return rc == 0

    async def get_branch(self) -> str | None:
        """Return the current branch name, or None if detached / not a repo."""
        branch, rc = await self._run_git("branch", "--show-current")
        if rc != 0:
            return None
        return branch.strip() or None

    async def get_status(self) -> GitStatus:
        """Return a rich git-status object.

        Schema::

            GitStatus(
                error    = str | None,
                branch   = str | None,
                ahead    = int,
                behind   = int,
                files    = [GitStatusFile(status, path, insertions, deletions), ...],
            )
        """
        if not await self.is_init():
            return GitStatus(error="not a git repository")

        branch = await self.get_branch()

        # Ahead / behind remote
        ahead, behind = 0, 0
        ab_out, ab_rc = await self._run_git("rev-list", "--left-right", "--count", "HEAD...@{upstream}")
        if ab_rc == 0 and ab_out:
            parts = ab_out.split()
            if len(parts) == 2:
                try:
                    ahead, behind = int(parts[0]), int(parts[1])
                except ValueError:
                    pass

        # Numstat for insertion/deletion counts
        def parse_numstat(output: str) -> dict[str, tuple[int | None, int | None]]:
            result: dict[str, tuple[int | None, int | None]] = {}
            for line in output.splitlines():
                cols = line.split("\t", 2)
                if len(cols) == 3:
                    try:
                        ins: int | None = int(cols[0]) if cols[0] != "-" else None
                        dels: int | None = int(cols[1]) if cols[1] != "-" else None
                        result[cols[2]] = (ins, dels)
                    except ValueError:
                        pass
            return result

        numstat_unstaged_out, _ = await self._run_git("diff", "--numstat")
        numstat_staged_out, _ = await self._run_git("diff", "--numstat", "--staged")
        numstat_unstaged = parse_numstat(numstat_unstaged_out)
        numstat_staged = parse_numstat(numstat_staged_out)

        # Porcelain v1 for file list
        porcelain_out, _ = await self._run_git("status", "--porcelain=v1")
        files: list[GitStatusFile] = []
        for line in porcelain_out.splitlines():
            if len(line) < 4:
                continue
            x = line[0]   # staged status char
            y = line[1]   # unstaged status char
            path_part = line[3:]

            # Handle renames: "old -> new"
            display_path = path_part
            lookup_path = path_part
            if " -> " in path_part:
                old, new = path_part.split(" -> ", 1)
                display_path = f"{old} → {new}"
                lookup_path = new

            # Staged takes priority over unstaged
            if x not in (" ", "?"):
                status = x
                ins, dels = numstat_staged.get(lookup_path, (None, None))
            elif y not in (" ", "?"):
                status = y
                ins, dels = numstat_unstaged.get(lookup_path, (None, None))
            elif x == "?" and y == "?":
                status = "?"
                ins, dels = None, None
            else:
                status = (x if x != " " else y) or "?"
                ins, dels = None, None

            files.append(GitStatusFile(
                status=status,
                path=display_path,
                insertions=ins,
                deletions=dels,
            ))

        return GitStatus(
            error=None,
            branch=branch,
            ahead=ahead,
            behind=behind,
            files=files,
        )

    # ------------------------------------------------------------------
    # Dispatch — routes git-ops sub-paths to the appropriate operation
    # ------------------------------------------------------------------

    async def dispatch(self, sub: str) -> "ApiResponse":
        """Route a git-ops sub-path to the appropriate git operation.

        Sub-paths:
            status              → get_status()           → GitStatus (camelCase)
            branch              → get_branch()           → {branch}
            is-init             → is_init()              → {isInit}
            is-linked-worktree  → is_linked_worktree()   → {isLinkedWorktree}
            has-commit          → has_commit()           → {hasCommit}
        """
        from flow_sdk.responses.response import ApiSuccessResponse, ApiFailResponse  # noqa: PLC0415

        if sub == "status":
            return ApiSuccessResponse(data=(await self.get_status()).model_dump(by_alias=True))
        if sub == "branch":
            return ApiSuccessResponse(data=GitBranchData(branch=await self.get_branch()).model_dump(by_alias=True))
        if sub == "is-init":
            return ApiSuccessResponse(data=GitIsInitData(is_init=await self.is_init()).model_dump(by_alias=True))
        if sub == "is-linked-worktree":
            return ApiSuccessResponse(data=GitIsLinkedWorktreeData(is_linked_worktree=await self.is_linked_worktree()).model_dump(by_alias=True))
        if sub == "has-commit":
            return ApiSuccessResponse(data=GitHasCommitData(has_commit=await self.has_commit()).model_dump(by_alias=True))
        return ApiFailResponse(message=f"Unknown git-ops sub-path: '{sub}'", status_code=404)


