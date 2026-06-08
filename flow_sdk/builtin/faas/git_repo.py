"""GitRepo — thin wrapper around git for a given working directory.

Used by ComputeNode action handlers (git-ops catch-all).  Not a DB entity;
instantiated per-request.
"""
from __future__ import annotations

import logging
import shlex
from datetime import datetime
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


class GitFileDiff(_CamelModel):
    diff: str


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

    async def _run_git_io(self, *args: str) -> tuple[str, str, int]:
        """Run a git sub-command inside self.work_dir via the compute node.

        Returns (stdout_stripped, stderr_stripped, returncode). Git writes most
        progress/error text (push rejections, rebase failures) to stderr, so the
        push flow needs it for user-facing messages. Conflict *detection* still
        keys off stdout-based ``git ls-files --unmerged`` so it stays reliable
        regardless of where git happened to write.
        """
        try:
            cmd = await self._compute_node.run_command(
                f"git -C '{self.work_dir}' " + " ".join(args),
                background=False,
            )
            return (cmd.all_stdout or "").rstrip("\n"), (cmd.all_stderr or "").rstrip("\n"), cmd.exit_code or 0
        except Exception:
            logger.debug("git command failed: git %s", " ".join(args), exc_info=True)
            return "", "", 1

    async def _run_git(self, *args: str) -> tuple[str, int]:
        """``_run_git_io`` without stderr — (stdout_stripped, returncode)."""
        stdout, _, rc = await self._run_git_io(*args)
        return stdout, rc

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

        # Porcelain v1 for file list. ``--untracked-files=all`` lists each
        # untracked file individually instead of collapsing a wholly-untracked
        # directory into a single ``dir/`` entry — otherwise a new file like
        # ``marketing/workflows/.../workflow.md`` is hidden behind ``marketing/``.
        porcelain_out, _ = await self._run_git("status", "--porcelain=v1", "--untracked-files=all")
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

    async def get_file_diff(self, file_path: str, status: str) -> GitFileDiff:
        """Return the unified diff for a single file in the working tree.

        For untracked files (status '?') uses --no-index to show the full
        file as an addition.  For all other statuses, diffs HEAD against
        the working tree (covers both staged and unstaged changes).
        """
        if status == "?":
            diff, _ = await self._run_git("diff", "--no-index", "/dev/null", f"'{file_path}'")
        else:
            diff, _ = await self._run_git("diff", "HEAD", "--", f"'{file_path}'")
        return GitFileDiff(diff=diff)

    # ------------------------------------------------------------------
    # Greedy "non-tech" push: stage-all → commit → pull --rebase → push
    # ------------------------------------------------------------------

    @staticmethod
    def _summarize_unmerged(ls_files_unmerged: str) -> str:
        """Distinct conflicted paths from ``git ls-files --unmerged`` output.

        Each line looks like ``<mode> <sha> <stage>\\t<path>``; collapse the
        stage entries (1/2/3) down to the unique paths (order-preserving) for a
        plain summary.
        """
        paths = {
            line.split("\t", 1)[1].strip(): None
            for line in ls_files_unmerged.splitlines()
            if "\t" in line and line.split("\t", 1)[1].strip()
        }
        return ", ".join(paths)

    @staticmethod
    def _push_result(branch: str | None, message: str, *, ok: bool = False,
                     conflict: bool = False, nothing: bool = False) -> dict:
        """Build the dict the footer push button consumes."""
        return {"ok": ok, "conflict": conflict, "nothing": nothing, "branch": branch, "message": message}

    async def push(self) -> dict:
        """Stage everything, auto-commit, sync with remote, and push.

        Returns a camelCase-ish dict the footer button consumes::

            { ok: bool, conflict: bool, nothing: bool,
              branch: str | None, message: str }

        ``conflict=True`` means a rebase conflict is in progress (left in place
        so the resolve agent can finish it) — never auto-aborted here.
        """
        if not await self.is_init():
            return self._push_result(None, "Not a git repository")

        # 1. Stage everything.
        await self._run_git("add", "-A")

        # 2. Anything staged? `--quiet` exits 1 when there are staged diffs.
        _, _, staged_rc = await self._run_git_io("diff", "--cached", "--quiet")
        has_staged = staged_rc != 0

        branch = await self.get_branch() or "HEAD"

        # Upstream presence + how far ahead we already are.
        _, up_rc = await self._run_git("rev-parse", "--abbrev-ref", "@{u}")
        has_upstream = up_rc == 0
        ahead = 0
        if has_upstream:
            ahead_out, ahead_rc = await self._run_git("rev-list", "--count", "@{u}..HEAD")
            if ahead_rc == 0:
                try:
                    ahead = int(ahead_out.strip() or "0")
                except ValueError:
                    ahead = 0

        # 3. Nothing to do: no staged changes and nothing un-pushed.
        if not has_staged and has_upstream and ahead == 0:
            return self._push_result(branch, "Nothing to push", ok=True, nothing=True)

        # 4. Auto-commit staged changes with a friendly, non-technical message.
        if has_staged:
            names_out, _ = await self._run_git("diff", "--cached", "--name-only")
            n = len([ln for ln in names_out.splitlines() if ln.strip()])
            stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
            msg = f"Flowpad: save changes ({n} file{'s' if n != 1 else ''}) — {stamp}"
            c_out, c_err, c_rc = await self._run_git_io("commit", "-m", shlex.quote(msg))
            if c_rc != 0:
                return self._push_result(branch, (c_err or c_out or "Commit failed").strip())

        # 5. Sync with remote first (rebase) so the push is fast-forward.
        if has_upstream:
            p_out, p_err, p_rc = await self._run_git_io("pull", "--rebase", "origin", shlex.quote(branch))
            if p_rc != 0:
                combined = (p_err or p_out or "")
                if "couldn't find remote ref" not in combined:
                    unmerged, _ = await self._run_git("ls-files", "--unmerged")
                    if unmerged.strip():
                        files = self._summarize_unmerged(unmerged)
                        return self._push_result(
                            branch,
                            f"Merge conflict while syncing with the remote. Conflicted: {files or 'see git status'}",
                            conflict=True,
                        )
                    return self._push_result(branch, combined.strip() or "Could not sync with the remote")

        # 6. Push (set upstream when the branch is new on the remote).
        push_args = ["push", "origin", shlex.quote(branch)] if has_upstream else ["push", "-u", "origin", shlex.quote(branch)]
        ps_out, ps_err, ps_rc = await self._run_git_io(*push_args)
        if ps_rc != 0:
            combined = (ps_err or ps_out or "").strip()
            unmerged, _ = await self._run_git("ls-files", "--unmerged")
            lowered = combined.lower()
            conflict = bool(unmerged.strip()) or any(
                s in lowered for s in ("non-fast-forward", "rejected", "fetch first", "behind")
            )
            return self._push_result(branch, combined or "Push failed", conflict=conflict)

        return self._push_result(branch, "Pushed", ok=True)

    # ------------------------------------------------------------------
    # Dispatch — routes git-ops sub-paths to the appropriate operation
    # ------------------------------------------------------------------

    async def dispatch(self, sub: str, query_params: dict | None = None, method: str = "GET") -> "ApiResponse":
        """Route a git-ops sub-path to the appropriate git operation.

        Sub-paths:
            status              → get_status()           → GitStatus (camelCase)
            diff?filepath=...   → get_diff(filepath)     → GitDiffData
            branch              → get_branch()           → {branch}
            is-init             → is_init()              → {isInit}
            is-linked-worktree  → is_linked_worktree()   → {isLinkedWorktree}
            has-commit          → has_commit()           → {hasCommit}
            diff                → get_file_diff()        → {diff}  (requires ?file=&status=)
            push  (POST)        → push()                 → {ok, conflict, nothing, branch, message}
        """
        from flow_sdk.responses.response import ApiSuccessResponse, ApiFailResponse  # noqa: PLC0415

        params = query_params or {}

        if sub == "push":
            if method.upper() != "POST":
                return ApiFailResponse(message="git-ops/push requires POST", status_code=405)
            return ApiSuccessResponse(data=await self.push())
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
        if sub == "diff":
            file_path = params.get("file", "")
            status = params.get("status", "M")
            if not file_path:
                return ApiFailResponse(message="Missing required query parameter: file", status_code=400)
            return ApiSuccessResponse(data=(await self.get_file_diff(file_path, status)).model_dump(by_alias=True))
        return ApiFailResponse(message=f"Unknown git-ops sub-path: '{sub}'", status_code=404)


