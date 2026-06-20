"""GitRepo — thin wrapper around git for a given working directory.

Used by ComputeNode action handlers (git-ops catch-all).  Not a DB entity;
instantiated per-request.
"""
from __future__ import annotations

import logging
import re
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


class GitFileContent(_CamelModel):
    content: str


class GitRevision(_CamelModel):
    hash: str
    version: int | None = None
    message: str
    date: str
    author: str


class GitRevisionList(_CamelModel):
    revisions: list[GitRevision] = []
    version: int | None = None  # current (HEAD) version parsed from the newest revision
    unpushed: int = 0  # commits to this file ahead of @{u} (0 when no upstream)


class GitRestoreResult(_CamelModel):
    ok: bool
    message: str


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
    # Per-file revision history (scoped to a single asset file)
    # ------------------------------------------------------------------

    @staticmethod
    def _version_from_message(message: str) -> int | None:
        """Parse the running version the auto-commit hook encodes as ``v{n}``."""
        m = re.search(r"\bv(\d+)\b", message)
        return int(m.group(1)) if m else None

    async def get_file_revisions(self, file_path: str) -> GitRevisionList:
        """Commit history for a single file, newest first.

        Each record carries the running ``version`` parsed from its commit
        message (encoded as ``v{n}`` by the auto-version hook). The list's
        top-level ``version`` is the newest revision's.
        """
        fmt = "--format=%H%x1f%an%x1f%aI%x1f%s"
        out, _ = await self._run_git("log", "--follow", fmt, "--", f"'{file_path}'")
        revisions: list[GitRevision] = []
        for line in out.splitlines():
            if not line.strip():
                continue
            parts = line.split("\x1f")
            if len(parts) < 4:
                continue
            hash_, author, date, message = parts[0], parts[1], parts[2], parts[3]
            revisions.append(
                GitRevision(
                    hash=hash_,
                    version=self._version_from_message(message),
                    message=message,
                    date=date,
                    author=author,
                )
            )
        current = revisions[0].version if revisions else None
        # Unpushed commits to this file. `rev-list @{u}..HEAD` exits non-zero when
        # there's no upstream — treat that (and any parse miss) as 0, so no extra
        # `rev-parse @{u}` probe is needed.
        unpushed = 0
        cnt_out, cnt_rc = await self._run_git(
            "rev-list", "--count", "@{u}..HEAD", "--", f"'{file_path}'"
        )
        if cnt_rc == 0:
            try:
                unpushed = int(cnt_out.strip() or "0")
            except ValueError:
                unpushed = 0
        return GitRevisionList(revisions=revisions, version=current, unpushed=unpushed)

    async def compare_file_revision(self, file_path: str, commit_hash: str) -> GitFileDiff:
        """Unified diff of a file between a past revision and the working tree."""
        diff, _ = await self._run_git(
            "diff", shlex.quote(commit_hash), "HEAD", "--", f"'{file_path}'"
        )
        return GitFileDiff(diff=diff)

    async def get_file_at(self, file_path: str, commit_hash: str) -> GitFileContent:
        """Full file content at a revision (``git show <hash>:./<file>``).

        Powers the Word-style review compare, which renders both versions as
        formatted markdown. ``commit_hash`` may be ``HEAD`` for the current side.

        The ``:./`` prefix makes git resolve ``file_path`` relative to the working
        dir (``git -C work_dir``); plain ``<rev>:<path>`` is **repo-root**-relative,
        so a basename for a file in a subdirectory would silently resolve to nothing.

        Note: ``git show`` does not follow renames, so a revision from *before* the
        file moved to its current path returns empty content (the review viewer then
        shows it as all-new — acceptable; rename-aware history is out of scope).
        """
        rel = file_path[2:] if file_path.startswith("./") else file_path
        content, _ = await self._run_git("show", shlex.quote(f"{commit_hash}:./{rel}"))
        return GitFileContent(content=content)

    async def restore_file(self, file_path: str, commit_hash: str) -> GitRestoreResult:
        """Check out a single file at a past revision (working-tree mutation).

        Scoped to the one file (``git checkout <hash> -- <file>``); other files
        in the shared working tree are untouched. The restore itself is a content
        change, so the next save re-versions it as a fresh revision.
        """
        _, err, rc = await self._run_git_io(
            "checkout", shlex.quote(commit_hash), "--", f"'{file_path}'"
        )
        if rc != 0:
            return GitRestoreResult(ok=False, message=(err or "Restore failed").strip())
        return GitRestoreResult(ok=True, message=f"Restored to {commit_hash[:8]}")

    # ------------------------------------------------------------------
    # Per-file working-tree actions (discard / stage / unstage)
    # ------------------------------------------------------------------

    async def discard_file(self, file_path: str, status: str) -> GitRestoreResult:
        """Undo a single file's pending change, chosen by its status char.

        * ``?`` untracked → delete the file (``git clean -f``); it isn't tracked,
          so there's nothing to restore it to.
        * everything else (``M`` modified, ``D`` deleted, ``A`` added, ``R``
          renamed, …) → revert both the index and the working tree to HEAD
          (``git restore --staged --worktree``), bringing a deleted file back and
          dropping edits/staging in one shot.

        For a rename the panel hands us the **new** path (the caller strips the
        ``old → new`` display form); v1 reverts that path only — the old name may
        linger as a separate deletion until the next refresh.
        """
        if status == "?":
            _, err, rc = await self._run_git_io("clean", "-f", "--", f"'{file_path}'")
            verb = "Deleted"
        else:
            _, err, rc = await self._run_git_io(
                "restore", "--staged", "--worktree", "--", f"'{file_path}'"
            )
            verb = "Discarded changes to"
        if rc != 0:
            return GitRestoreResult(ok=False, message=(err or "Discard failed").strip())
        return GitRestoreResult(ok=True, message=f"{verb} {file_path}")

    async def stage_file(self, file_path: str) -> GitRestoreResult:
        """Stage just this file (``git add -- <file>``)."""
        _, err, rc = await self._run_git_io("add", "--", f"'{file_path}'")
        if rc != 0:
            return GitRestoreResult(ok=False, message=(err or "Stage failed").strip())
        return GitRestoreResult(ok=True, message=f"Staged {file_path}")

    async def unstage_file(self, file_path: str) -> GitRestoreResult:
        """Unstage just this file (``git restore --staged -- <file>``)."""
        _, err, rc = await self._run_git_io("restore", "--staged", "--", f"'{file_path}'")
        if rc != 0:
            return GitRestoreResult(ok=False, message=(err or "Unstage failed").strip())
        return GitRestoreResult(ok=True, message=f"Unstaged {file_path}")

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

    # Failure classes a publish can land in. `conflict` keeps its dedicated flag
    # for the existing Resolve-agent path; the rest let the UI give state-specific,
    # plain-language guidance instead of one generic "Push failed".
    @staticmethod
    def _classify_push_error(stderr: str) -> str:
        """Map raw git/transport stderr to a publish failure kind.

        One of: ``permission | no_remote | network | conflict | generic``.
        """
        s = (stderr or "").lower()
        if any(k in s for k in (
            "permission denied", "denied", "403", "forbidden", "authentication failed",
            "access rights", "not authorized", "could not read from remote repository",
        )):
            return "permission"
        if any(k in s for k in (
            "does not appear to be a git repository", "no configured push destination",
            "no such remote", "'origin' does not", "no upstream",
        )):
            return "no_remote"
        if any(k in s for k in (
            "could not resolve host", "connection refused", "connection timed out",
            "timed out", "network is unreachable", "failed to connect", "ssl",
        )):
            return "network"
        if any(k in s for k in ("non-fast-forward", "rejected", "fetch first", "behind", "unmerged")):
            return "conflict"
        return "generic"

    @staticmethod
    def _push_result(branch: str | None, message: str, *, ok: bool = False,
                     conflict: bool = False, nothing: bool = False, kind: str | None = None) -> dict:
        """Build the dict the publish UI consumes.

        ``kind`` is the typed outcome (``pushed|nothing|conflict|permission|
        no_remote|network|generic``). When omitted it's derived from the flags so
        existing call sites stay correct; the back-compat ``ok/conflict/nothing``
        keys are kept for the footer button.
        """
        if kind is None:
            if nothing:
                kind = "nothing"
            elif conflict:
                kind = "conflict"
            elif ok:
                kind = "pushed"
            else:
                kind = "generic"
        return {"ok": ok, "conflict": conflict, "nothing": nothing, "kind": kind, "branch": branch, "message": message}

    async def push(self) -> dict:
        """Stage everything, auto-commit, sync with remote, and push.

        Returns a camelCase-ish dict the footer button consumes::

            { ok: bool, conflict: bool, nothing: bool,
              branch: str | None, message: str }

        ``conflict=True`` means a rebase conflict is in progress (left in place
        so the resolve agent can finish it) — never auto-aborted here.
        """
        if not await self.is_init():
            return self._push_result(None, "Not a git repository", kind="no_repo")

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
                    return self._push_result(
                        branch,
                        combined.strip() or "Could not sync with the remote",
                        kind=self._classify_push_error(combined),
                    )

        # 6. Push (set upstream when the branch is new on the remote).
        push_args = ["push", "origin", shlex.quote(branch)] if has_upstream else ["push", "-u", "origin", shlex.quote(branch)]
        ps_out, ps_err, ps_rc = await self._run_git_io(*push_args)
        if ps_rc != 0:
            combined = (ps_err or ps_out or "").strip()
            unmerged, _ = await self._run_git("ls-files", "--unmerged")
            kind = "conflict" if unmerged.strip() else self._classify_push_error(combined)
            return self._push_result(
                branch, combined or "Push failed", conflict=(kind == "conflict"), kind=kind,
            )

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
            discard-file (POST) → discard_file()         → {ok, message}  (requires ?file=&status=)
            stage-file   (POST) → stage_file()           → {ok, message}  (requires ?file=)
            unstage-file (POST) → unstage_file()         → {ok, message}  (requires ?file=)
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
        if sub == "file-revisions":
            file_path = params.get("file", "")
            if not file_path:
                return ApiFailResponse(message="Missing required query parameter: file", status_code=400)
            return ApiSuccessResponse(data=(await self.get_file_revisions(file_path)).model_dump(by_alias=True))
        if sub == "revision-diff":
            file_path = params.get("file", "")
            commit_hash = params.get("hash", "")
            if not file_path or not commit_hash:
                return ApiFailResponse(message="Missing required query parameter: file and hash", status_code=400)
            return ApiSuccessResponse(data=(await self.compare_file_revision(file_path, commit_hash)).model_dump(by_alias=True))
        if sub == "show":
            file_path = params.get("file", "")
            commit_hash = params.get("hash", "")
            if not file_path or not commit_hash:
                return ApiFailResponse(message="Missing required query parameter: file and hash", status_code=400)
            return ApiSuccessResponse(data=(await self.get_file_at(file_path, commit_hash)).model_dump(by_alias=True))
        if sub == "restore-file":
            if method.upper() != "POST":
                return ApiFailResponse(message="git-ops/restore-file requires POST", status_code=405)
            file_path = params.get("file", "")
            commit_hash = params.get("hash", "")
            if not file_path or not commit_hash:
                return ApiFailResponse(message="Missing required parameter: file and hash", status_code=400)
            return ApiSuccessResponse(data=(await self.restore_file(file_path, commit_hash)).model_dump(by_alias=True))
        # Per-file working-tree mutations share the same shape: POST-only, a
        # required ``file`` param, and a GitRestoreResult-returning coroutine.
        # ``discard-file`` additionally passes the status char.
        post_file_ops = {
            "discard-file": lambda fp: self.discard_file(fp, params.get("status", "M")),
            "stage-file": lambda fp: self.stage_file(fp),
            "unstage-file": lambda fp: self.unstage_file(fp),
        }
        if sub in post_file_ops:
            if method.upper() != "POST":
                return ApiFailResponse(message=f"git-ops/{sub} requires POST", status_code=405)
            file_path = params.get("file", "")
            if not file_path:
                return ApiFailResponse(message="Missing required parameter: file", status_code=400)
            return ApiSuccessResponse(data=(await post_file_ops[sub](file_path)).model_dump(by_alias=True))
        return ApiFailResponse(message=f"Unknown git-ops sub-path: '{sub}'", status_code=404)


