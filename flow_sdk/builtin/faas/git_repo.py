"""GitRepo — thin wrapper around git for a given working directory.

Used by ComputeNode action handlers (git-ops catch-all).  Not a DB entity;
instantiated per-request.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex
from datetime import datetime
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.responses.response import ApiResponse

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
    # True when the change is in the index (porcelain X column) — the UI's
    # stage/unstage toggle reads this instead of inferring from the status char.
    staged: bool = False
    insertions: int | None = None
    deletions: int | None = None


class GitStatus(_CamelModel):
    error: str | None = None
    branch: str | None = None
    ahead: int = 0
    behind: int = 0
    files: list[GitStatusFile] = []


class GitCurrentBranchData(_CamelModel):
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


class GitAssetDiff(_CamelModel):
    diff: str
    files: list[GitStatusFile] = []


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


class GitUnpushedFiles(_CamelModel):
    # Repo-relative paths changed in commits ahead of @{u} (empty when no
    # upstream or no commits).
    files: list[str] = []


class GitRestoreResult(_CamelModel):
    ok: bool
    message: str


# Typed publish outcome — mirrored by ``PushKind`` in ts_sdk git-workdir.ts.
PushKind = Literal[
    "pushed",
    "nothing",
    "conflict",
    "permission",
    "no_remote",
    "network",
    "no_repo",
    "generic",
]


class GitPushResult(_CamelModel):
    ok: bool
    conflict: bool
    nothing: bool
    kind: PushKind
    branch: str | None
    message: str


# Config a fresh Flowpad repo gets at init time. Single source shared by
# GitRepo.init() and ComputeSourceControl._init_git_repository so the two init
# surfaces can never drift.
GIT_INIT_CONFIG: tuple[tuple[str, str], ...] = (
    ("user.name", "Flowpad"),
    ("user.email", "git@example.com"),
    ("push.autoSetupRemote", "true"),
)


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

    async def init(self) -> GitRestoreResult:
        """Initialize a git repository in work_dir (idempotent).

        Mirrors ``ComputeSourceControl._init_git_repository`` but workdir-scoped:
        ``git init --initial-branch=main`` plus the identity/push config a fresh
        Flowpad repo needs. Config failures are non-fatal (same as the source-
        control path) — the repo is usable either way.
        """
        if await self.is_init():
            return GitRestoreResult(ok=True, message="Already a git repository")
        _, err, rc = await self._run_git_io("init", "--initial-branch=main")
        if rc != 0:
            return GitRestoreResult(ok=False, message=(err or "git init failed").strip())
        for key, value in GIT_INIT_CONFIG:
            await self._run_git("config", key, shlex.quote(value))
        return GitRestoreResult(ok=True, message="Initialized git repository")

    async def get_branch(self) -> str | None:
        """Return the current branch name, or None if detached / not a repo."""
        branch, rc = await self._run_git("branch", "--show-current")
        if rc != 0:
            return None
        return branch.strip() or None

    @staticmethod
    def _parse_branch_header(line: str) -> tuple[str | None, int, int]:
        """Parse a porcelain v1 ``## `` branch header into (branch, ahead, behind).

        Examples::

            ## main                              → ("main", 0, 0)
            ## main...origin/main                → ("main", 0, 0)
            ## main...origin/main [ahead 1, behind 2] → ("main", 1, 2)
            ## HEAD (no branch)                  → (None, 0, 0)   # detached
            ## No commits yet on main            → ("main", 0, 0) # empty repo
        """
        body = line[3:].strip()
        ahead = behind = 0
        m = re.search(r"\[([^\]]*)\]\s*$", body)
        if m:
            for part in m.group(1).split(","):
                part = part.strip()
                if part.startswith("ahead "):
                    ahead = int(part[len("ahead ") :] or 0)
                elif part.startswith("behind "):
                    behind = int(part[len("behind ") :] or 0)
            body = body[: m.start()].strip()
        if body.startswith("No commits yet on "):
            return (body[len("No commits yet on ") :].strip() or None, ahead, behind)
        if body.startswith("HEAD "):  # "HEAD (no branch)" — detached
            return (None, ahead, behind)
        return (body.split("...", 1)[0].strip() or None, ahead, behind)

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
        # One combined call replaces is_init + get_branch + ahead/behind +
        # file-list (4 git spawns → 1). ``--branch`` prepends a
        # ``## <branch>...<upstream> [ahead N, behind M]`` header line; the
        # remaining lines are the same porcelain v1 file entries parsed below.
        # rc != 0 ⇒ not a git repository (replaces the separate is_init probe).
        status_out, status_rc = await self._run_git("status", "--porcelain=v1", "--branch", "--untracked-files=all")
        if status_rc != 0:
            return GitStatus(error="not a git repository")

        branch, ahead, behind = None, 0, 0

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

        # Independent reads — run concurrently rather than back-to-back.
        (numstat_unstaged_out, _), (numstat_staged_out, _) = await asyncio.gather(
            self._run_git("diff", "--numstat"),
            self._run_git("diff", "--numstat", "--staged"),
        )
        numstat_unstaged = parse_numstat(numstat_unstaged_out)
        numstat_staged = parse_numstat(numstat_staged_out)

        # File list comes from the same ``status_out`` above. ``--untracked-files=all``
        # lists each untracked file individually instead of collapsing a wholly-
        # untracked directory into a single ``dir/`` entry — otherwise a new file
        # like ``marketing/workflows/.../workflow.md`` is hidden behind ``marketing/``.
        files: list[GitStatusFile] = []
        for line in status_out.splitlines():
            if line.startswith("## "):
                branch, ahead, behind = self._parse_branch_header(line)
                continue
            if len(line) < 4:
                continue
            x = line[0]  # staged status char
            y = line[1]  # unstaged status char
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

            files.append(
                GitStatusFile(
                    status=status,
                    path=display_path,
                    staged=x not in (" ", "?"),
                    insertions=ins,
                    deletions=dels,
                )
            )

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

    async def get_working_file(self, file_path: str) -> GitFileContent:
        """Full file content from the working tree, relative to ``work_dir``."""
        try:
            root = os.path.realpath(self.work_dir)
            full = os.path.realpath(os.path.join(root, file_path))
            if full != root and not full.startswith(root + os.sep):
                return GitFileContent(content="")
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                return GitFileContent(content=f.read())
        except OSError:
            return GitFileContent(content="")

    # ------------------------------------------------------------------
    # Per-file revision history (scoped to a single asset file)
    # ------------------------------------------------------------------

    @staticmethod
    def _version_from_message(message: str) -> int | None:
        """Parse the running version the auto-commit hook encodes as ``v{n}``."""
        m = re.search(r"\bv(\d+)\b", message)
        return int(m.group(1)) if m else None

    def _scope_pathspec(self, file_path: str) -> tuple[str, bool]:
        """Git pathspec for this asset's revisions/diff, and whether ``--follow``
        applies. A folder-backed asset (skill — ``workdir`` IS the asset folder)
        versions and diffs across the WHOLE folder, so internal-file edits show up
        as revisions; everything else stays file-scoped. ``--follow`` (rename
        tracking) only works for a single file, so it is dropped for folder scope.
        """
        try:
            from flow_sdk.actions.fs.asset_scope import is_folder_asset_dir

            if is_folder_asset_dir(self.work_dir):
                return "'.'", False
        except Exception:  # noqa: BLE001 — scope resolution must never break the route
            logger.debug("scope-pathspec resolve failed; file-scoped", exc_info=True)
        return f"'{file_path}'", True

    @staticmethod
    def _status_lookup_path(path: str) -> str:
        """Path used for scope matching, taking the new side of a rename."""
        if " → " in path:
            return path.split(" → ", 1)[1]
        if " -> " in path:
            return path.split(" -> ", 1)[1]
        return path

    async def _workdir_prefix(self) -> str:
        """Repo-root-relative prefix for ``work_dir`` with a trailing slash."""
        prefix, rc = await self._run_git("rev-parse", "--show-prefix")
        if rc != 0:
            return ""
        return prefix.strip().replace("\\", "/")

    @staticmethod
    def _strip_prefix(path: str, prefix: str) -> str | None:
        """Strip a repo-root prefix from a status path. None means outside scope."""
        if not prefix:
            return path
        if path == prefix.rstrip("/"):
            return ""
        if path.startswith(prefix):
            return path[len(prefix) :]
        return None

    @classmethod
    def _status_file_relative_to_workdir(cls, file: GitStatusFile, prefix: str) -> GitStatusFile | None:
        """Convert a porcelain status path from repo-root to workdir-relative."""
        if " → " in file.path:
            old, new = file.path.split(" → ", 1)
            old_rel = cls._strip_prefix(old, prefix)
            new_rel = cls._strip_prefix(new, prefix)
            if old_rel is None and new_rel is None:
                return None
            display = f"{old_rel if old_rel is not None else old} → {new_rel if new_rel is not None else new}"
        else:
            rel = cls._strip_prefix(file.path, prefix)
            if rel is None:
                return None
            display = rel
        return GitStatusFile(
            status=file.status,
            path=display,
            staged=file.staged,
            insertions=file.insertions,
            deletions=file.deletions,
        )

    async def get_asset_diff(self, file_path: str) -> GitAssetDiff:
        """Unified working-tree diff for an asset.

        Single-file assets diff just that file. Folder-backed assets diff the
        whole asset folder and include every changed file in that folder.
        """
        pathspec, _ = self._scope_pathspec(file_path)
        status = await self.get_status()
        prefix = await self._workdir_prefix()
        files = [rel for f in status.files if (rel := self._status_file_relative_to_workdir(f, prefix)) is not None]
        if pathspec != "'.'":
            files = [f for f in files if self._status_lookup_path(f.path).strip("./") == file_path.strip("./")]

        if await self.has_commit():
            diff, _ = await self._run_git("diff", "HEAD", "--", pathspec)
        else:
            diff = ""

        # ``git diff HEAD`` omits untracked files. Append a no-index diff for
        # each one so the asset-level diff is complete.
        additions: list[str] = []
        for f in files:
            if f.status != "?":
                continue
            rel = self._status_lookup_path(f.path)
            d, _ = await self._run_git("diff", "--no-index", "/dev/null", f"'{rel}'")
            if d:
                additions.append(d)
        if additions:
            diff = "\n".join(part for part in [diff, *additions] if part)

        return GitAssetDiff(diff=diff, files=files)

    async def get_file_revisions(self, file_path: str) -> GitRevisionList:
        """Commit history for an asset, newest first — a single file, or the whole
        folder for a folder-backed asset (skill).

        Each record carries the running ``version`` parsed from its commit
        message (encoded as ``v{n}`` by the auto-version hook). The list's
        top-level ``version`` is the newest revision's.
        """
        pathspec, follow = self._scope_pathspec(file_path)
        fmt = "--format=%H%x1f%an%x1f%aI%x1f%s"
        log_args = ["log", *(["--follow"] if follow else []), fmt, "--", pathspec]
        out, _ = await self._run_git(*log_args)
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
        cnt_out, cnt_rc = await self._run_git("rev-list", "--count", "@{u}..HEAD", "--", pathspec)
        if cnt_rc == 0:
            try:
                unpushed = int(cnt_out.strip() or "0")
            except ValueError:
                unpushed = 0
        return GitRevisionList(revisions=revisions, version=current, unpushed=unpushed)

    async def get_unpushed_files(self) -> GitUnpushedFiles:
        """Repo-relative paths touched by commits ahead of the upstream.

        `git diff @{u}..HEAD` exits non-zero when there is no upstream or no
        HEAD — treat that as "nothing unpushed" rather than an error, matching
        the tolerant `rev-list @{u}..HEAD` probe in `get_file_revisions`.
        """
        out, rc = await self._run_git("diff", "--name-only", "@{u}..HEAD")
        if rc != 0:
            return GitUnpushedFiles(files=[])
        return GitUnpushedFiles(files=[line.strip() for line in out.splitlines() if line.strip()])

    async def compare_file_revision(self, file_path: str, commit_hash: str) -> GitFileDiff:
        """Unified diff of an asset between a past revision and the working tree —
        a single file, or the whole folder for a folder-backed asset (skill), so
        internal-file changes are shown."""
        pathspec, _ = self._scope_pathspec(file_path)
        diff, _ = await self._run_git("diff", shlex.quote(commit_hash), "HEAD", "--", pathspec)
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
        """Check out an asset at a past revision (working-tree mutation).

        Scoped to the asset — the one file, or the whole folder for a folder-backed
        asset (skill) so its internal files are restored together; files outside the
        asset in the shared working tree are untouched. The restore itself is a
        content change, so the next save re-versions it as a fresh revision.
        """
        pathspec, _ = self._scope_pathspec(file_path)
        _, err, rc = await self._run_git_io("checkout", shlex.quote(commit_hash), "--", pathspec)
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
            _, err, rc = await self._run_git_io("restore", "--staged", "--worktree", "--", f"'{file_path}'")
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
    def _classify_push_error(stderr: str) -> PushKind:
        """Map raw git/transport stderr to a publish failure kind.

        One of: ``permission | no_remote | network | conflict | generic``.
        """
        s = (stderr or "").lower()
        if any(
            k in s
            for k in (
                "permission denied",
                "denied",
                "403",
                "forbidden",
                "authentication failed",
                "access rights",
                "not authorized",
                "could not read from remote repository",
            )
        ):
            return "permission"
        if any(
            k in s
            for k in (
                "does not appear to be a git repository",
                "no configured push destination",
                "no such remote",
                "'origin' does not",
                "no upstream",
            )
        ):
            return "no_remote"
        if any(
            k in s
            for k in (
                "could not resolve host",
                "connection refused",
                "connection timed out",
                "timed out",
                "network is unreachable",
                "failed to connect",
                "ssl",
            )
        ):
            return "network"
        if any(k in s for k in ("non-fast-forward", "rejected", "fetch first", "behind", "unmerged")):
            return "conflict"
        return "generic"

    @staticmethod
    def _push_result(
        branch: str | None,
        message: str,
        *,
        ok: bool = False,
        conflict: bool = False,
        nothing: bool = False,
        kind: PushKind | None = None,
    ) -> GitPushResult:
        """Build the ``GitPushResult`` the publish UI consumes.

        ``kind`` is the typed outcome (``pushed|nothing|conflict|permission|
        no_remote|network|no_repo|generic``). When omitted it's derived from the
        flags so existing call sites stay correct; the back-compat
        ``ok/conflict/nothing`` flags are kept for the footer button.
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
        return GitPushResult(ok=ok, conflict=conflict, nothing=nothing, kind=kind, branch=branch, message=message)

    async def push(self) -> GitPushResult:
        """Stage everything, auto-commit, sync with remote, and push.

        Returns a ``GitPushResult`` (serialized camelCase for the footer button):
        ``{ ok, conflict, nothing, kind, branch, message }``.

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
                combined = p_err or p_out or ""
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
        push_args = (
            ["push", "origin", shlex.quote(branch)] if has_upstream else ["push", "-u", "origin", shlex.quote(branch)]
        )
        ps_out, ps_err, ps_rc = await self._run_git_io(*push_args)
        if ps_rc != 0:
            combined = (ps_err or ps_out or "").strip()
            unmerged, _ = await self._run_git("ls-files", "--unmerged")
            kind = "conflict" if unmerged.strip() else self._classify_push_error(combined)
            return self._push_result(
                branch,
                combined or "Push failed",
                conflict=(kind == "conflict"),
                kind=kind,
            )

        return self._push_result(branch, "Pushed", ok=True)

    # ------------------------------------------------------------------
    # Dispatch — routes git-ops sub-paths to the appropriate operation
    # ------------------------------------------------------------------

    async def dispatch(self, sub: str, query_params: dict | None = None, method: str = "GET") -> "ApiResponse":
        """Route a git-ops sub-path to the appropriate git operation.

        Sub-paths:
            status              → get_status()           → GitStatus (camelCase)
            unpushed-files      → get_unpushed_files()   → {files} (repo-rel, ahead of @{u})
            diff?filepath=...   → get_diff(filepath)     → GitDiffData
            branch              → get_branch()           → {branch}
            is-init             → is_init()              → {isInit}
            is-linked-worktree  → is_linked_worktree()   → {isLinkedWorktree}
            has-commit          → has_commit()           → {hasCommit}
            diff                → get_file_diff()        → {diff}  (requires ?file=&status=)
            push  (POST)        → push()                 → GitPushResult {ok, conflict, nothing, kind, branch, message}
            init  (POST)        → init()                 → {ok, message}  (idempotent)
            discard-file (POST) → discard_file()         → {ok, message}  (requires ?file=&status=)
            stage-file   (POST) → stage_file()           → {ok, message}  (requires ?file=)
            unstage-file (POST) → unstage_file()         → {ok, message}  (requires ?file=)
        """
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        params = query_params or {}

        if sub == "push":
            if method.upper() != "POST":
                return ApiFailResponse(message="git-ops/push requires POST", status_code=405)
            return ApiSuccessResponse(data=(await self.push()).model_dump(by_alias=True))
        if sub == "init":
            if method.upper() != "POST":
                return ApiFailResponse(message="git-ops/init requires POST", status_code=405)
            return ApiSuccessResponse(data=(await self.init()).model_dump(by_alias=True))
        if sub == "status":
            return ApiSuccessResponse(data=(await self.get_status()).model_dump(by_alias=True))
        if sub == "unpushed-files":
            return ApiSuccessResponse(data=(await self.get_unpushed_files()).model_dump(by_alias=True))
        if sub == "branch":
            return ApiSuccessResponse(
                data=GitCurrentBranchData(branch=await self.get_branch()).model_dump(by_alias=True)
            )
        if sub == "is-init":
            return ApiSuccessResponse(data=GitIsInitData(is_init=await self.is_init()).model_dump(by_alias=True))
        if sub == "is-linked-worktree":
            return ApiSuccessResponse(
                data=GitIsLinkedWorktreeData(is_linked_worktree=await self.is_linked_worktree()).model_dump(
                    by_alias=True
                )
            )
        if sub == "has-commit":
            return ApiSuccessResponse(
                data=GitHasCommitData(has_commit=await self.has_commit()).model_dump(by_alias=True)
            )
        if sub == "diff":
            file_path = params.get("file", "")
            status = params.get("status", "M")
            if not file_path:
                return ApiFailResponse(message="Missing required query parameter: file", status_code=400)
            return ApiSuccessResponse(data=(await self.get_file_diff(file_path, status)).model_dump(by_alias=True))
        if sub == "asset-diff":
            file_path = params.get("file", "")
            if not file_path:
                return ApiFailResponse(message="Missing required query parameter: file", status_code=400)
            return ApiSuccessResponse(data=(await self.get_asset_diff(file_path)).model_dump(by_alias=True))
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
            return ApiSuccessResponse(
                data=(await self.compare_file_revision(file_path, commit_hash)).model_dump(by_alias=True)
            )
        if sub == "show":
            file_path = params.get("file", "")
            commit_hash = params.get("hash", "")
            if not file_path or not commit_hash:
                return ApiFailResponse(message="Missing required query parameter: file and hash", status_code=400)
            return ApiSuccessResponse(data=(await self.get_file_at(file_path, commit_hash)).model_dump(by_alias=True))
        if sub == "working-file":
            file_path = params.get("file", "")
            if not file_path:
                return ApiFailResponse(message="Missing required query parameter: file", status_code=400)
            return ApiSuccessResponse(data=(await self.get_working_file(file_path)).model_dump(by_alias=True))
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
