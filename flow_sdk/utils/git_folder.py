"""One class for doing git on a folder — wherever that folder lives.

Git was implemented five times across this codebase (``utils/git.py``,
``assets/git_worktree.py``, ``builtin/faas/git_repo.py``, the hub's
``GitStorageDriver``, the hub's ``install_review``), each welded to *how* it ran
and each with its own error convention. The logic was the same every time. This
is that logic, once, over a :class:`CommandExecutor` — so the same code runs on
local disk or on a compute node.

What this class is NOT:

* **Not a policy layer.** It does not decide that a remote must be GitHub, or
  that a branch must be ``flow-cloud``, or who may push. Those are caller rules;
  ``validate_github_remote`` is offered for the callers that want the first one.
* **Not a durable store.** A checkout is a cache. Callers that treat it as state
  are the reason the hub's per-process checkout keeps surprising people.
* **Not a secret holder beyond one command.** The token reaches git through an
  inline credential helper reading a child-env variable — never argv (ps-visible),
  never the on-disk remote URL, never a log line.

Two invariants worth stating because breaking them is silent:

* **git stderr never reaches a caller.** It can contain the token. Failures carry
  a :class:`GitErrorCode`, not the process output.
* **Mutations on one checkout are serialized** by a lock keyed on the resolved
  root — the actually-contended resource — so two callers cannot interleave a
  fetch/commit/push on the same directory.
"""

from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, AsyncIterator, Iterable, Mapping, Sequence
from urllib.parse import urlparse
from weakref import WeakValueDictionary

from flow_sdk._compat import StrEnum
from flow_sdk.utils.command_executor import CommandExecutor, CommandResult

if TYPE_CHECKING:
    from flow_sdk.assets.git_publish import GitAuthor

# The env var the inline credential helper reads. The helper script references
# only this NAME; the value lives solely in the child env.
GIT_TOKEN_ENV = "FLOWPAD_GIT_TOKEN"
CREDENTIAL_HELPER = f'!f() {{ echo username=x-access-token; echo "password=${GIT_TOKEN_ENV}"; }}; f'

#: Empty directories cannot be represented in git; this marker stands in for one.
KEEP_FILE = ".flowpad-vfs-keep"

_REPO_LOCKS: "WeakValueDictionary[tuple[object, str], asyncio.Lock]" = WeakValueDictionary()

# Mirrors PortableGitOrigin._validate_branch. Kept as a plain predicate so a
# branch can be checked before a subprocess exists to ask.
_BRANCH_FORBIDDEN = re.compile(r"[\x00-\x20~^:?*\[\\]")


class GitErrorCode(StrEnum):
    """Why a git operation failed, in terms a caller can map to its own contract.

    Deliberately free of hub and asset vocabulary: the hub maps these to
    ``GitMutationCode`` and the publish path maps them to ``AssetPublishCode``,
    so neither existing wire contract has to change.
    """

    NOT_A_REPO = "not_a_repo"
    REMOTE_INVALID = "remote_invalid"
    REMOTE_MISMATCH = "remote_mismatch"
    BRANCH_INVALID = "branch_invalid"
    BRANCH_NOT_FOUND = "branch_not_found"
    AUTH_REQUIRED = "auth_required"
    AUTH_FAILED = "auth_failed"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    ORIGIN_OUT_OF_DATE = "origin_out_of_date"
    PUSH_REJECTED = "push_rejected"
    PATH_ESCAPES_REPO = "path_escapes_repo"
    COMMAND_FAILED = "command_failed"


class GitError(RuntimeError):
    """A typed, deliberately output-free git failure."""

    def __init__(self, code: GitErrorCode, message: str = "", *, data: dict | None = None) -> None:
        super().__init__(message or str(code))
        self.code = code
        self.data = data or {}


def validate_branch_name(branch: str) -> str:
    """Reject a branch name git would refuse or that could smuggle an argument.

    Offered as a predicate rather than shelling out to ``check-ref-format`` so a
    caller can validate before a checkout exists.
    """
    candidate = (branch or "").strip()
    if (
        not candidate
        or candidate.startswith(("-", ".", "/"))
        or candidate.endswith(("/", ".", ".lock"))
        or ".." in candidate
        or "@{" in candidate
        or _BRANCH_FORBIDDEN.search(candidate)
    ):
        raise GitError(GitErrorCode.BRANCH_INVALID, "Invalid branch name")
    return candidate


def validate_github_remote(remote_url: str) -> tuple[str, str]:
    """``(owner, name)`` for a canonical GitHub HTTPS remote, else raise.

    Caller policy, not a GitFolder rule — the publish path requires it; a plain
    checkout on a compute node does not.
    """
    parsed = urlparse((remote_url or "").strip())
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() != "github.com"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise GitError(GitErrorCode.REMOTE_INVALID, "Only a canonical GitHub HTTPS remote is allowed")
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    if len(parts) != 2:
        raise GitError(GitErrorCode.REMOTE_INVALID, "Remote must be <owner>/<name>")
    return parts[0], parts[1].removesuffix(".git")


def _assert_no_credentials(remote_url: str) -> str:
    """The one remote rule GitFolder itself enforces: never a URL carrying a secret."""
    parsed = urlparse((remote_url or "").strip())
    if parsed.username is not None or parsed.password is not None:
        raise GitError(GitErrorCode.REMOTE_INVALID, "Remote URL must not embed credentials")
    return remote_url.strip()


class GitFolder:
    """A folder that is (or is about to be) a git checkout."""

    def __init__(
        self,
        root: str | Path,
        *,
        executor: CommandExecutor,
        remote_url: str | None = None,
        branch: str | None = None,
        token: str | None = None,
    ) -> None:
        self.root = Path(root)
        self.executor: CommandExecutor = executor
        self.remote_url = _assert_no_credentials(remote_url) if remote_url else None
        self.branch = validate_branch_name(branch) if branch else None
        self._token = token
        # ``root`` never changes, so resolving it is done once. It is also the
        # lock key, and re-deriving that per acquisition invites two callers
        # keying on subtly different strings.
        self._resolved_root: str | None = None

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"GitFolder(root={str(self.root)!r}, branch={self.branch!r})"

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    @classmethod
    async def discover(
        cls, path: str | Path, *, executor: CommandExecutor, **kwargs
    ) -> "GitFolder":
        """The checkout containing ``path``.

        The async, executor-based counterpart of ``utils.git.find_project_root``
        — that one stays for the sync call sites, which cannot await.
        """
        probe = Path(path)
        if not await executor.exists(str(probe)):
            probe = probe.parent
        current = Path(await executor.resolve(str(probe)))
        while True:
            if await executor.exists(str(current / ".git")):
                return cls(current, executor=executor, **kwargs)
            if current.parent == current:
                raise GitError(GitErrorCode.NOT_A_REPO, "Path is not inside a git checkout")
            current = current.parent

    @classmethod
    def from_origin(
        cls,
        origin,
        root: str | Path,
        *,
        executor: CommandExecutor,
        token: str | None = None,
    ) -> "GitFolder":
        """Build from either GitOrigin flavour — the strict ``PortableGitOrigin``
        or the looser ``builtin`` one. Only ``clone_url()`` and ``branch`` are
        required, so neither is baked in as a dependency."""
        return cls(
            root,
            executor=executor,
            remote_url=origin.clone_url(),
            branch=getattr(origin, "branch", None) or None,
            token=token,
        )

    @classmethod
    async def clone(
        cls,
        remote_url: str,
        target: str | Path,
        *,
        branch: str | None = None,
        token: str | None = None,
        executor: CommandExecutor,
        sparse_paths: Sequence[str] | None = None,
        depth: int | None = None,
        blobless: bool = False,
        single_branch: bool = False,
    ) -> "GitFolder":
        folder = cls(target, executor=executor, remote_url=remote_url, branch=branch, token=token)
        await folder.ensure(
            sparse_paths=sparse_paths, depth=depth, blobless=blobless, single_branch=single_branch
        )
        return folder

    # ------------------------------------------------------------------
    # Command plumbing
    # ------------------------------------------------------------------

    def _auth(self, use_token: bool) -> tuple[list[str], dict[str, str]]:
        """``(extra argv, env overlay)``. ``GIT_TERMINAL_PROMPT=0`` always, so a
        missing or bad credential fails fast instead of hanging on a prompt."""
        env = {"GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
        if use_token and self._token:
            return ["-c", f"credential.helper={CREDENTIAL_HELPER}"], {**env, GIT_TOKEN_ENV: self._token}
        return [], env

    async def git(
        self,
        *args: str,
        auth: bool = False,
        env: Mapping[str, str] | None = None,
        timeout: int | None = None,
        cwd: str | Path | None = None,
    ) -> CommandResult:
        auth_args, auth_env = self._auth(auth)
        return await self.executor.run(
            ["git", *auth_args, *args],
            cwd=str(cwd or self.root),
            env={**auth_env, **(env or {})},
            timeout=timeout,
        )

    async def required(
        self,
        *args: str,
        code: GitErrorCode = GitErrorCode.COMMAND_FAILED,
        auth: bool = False,
        env: Mapping[str, str] | None = None,
    ) -> str:
        """Run and return trimmed stdout, or raise. The process output is
        deliberately dropped — it can contain the token."""
        result = await self.git(*args, auth=auth, env=env)
        if not result.ok:
            raise GitError(code, "Git operation failed")
        return result.stdout.strip()

    async def resolved_root(self) -> str:
        """The fully-resolved root, computed once."""
        if self._resolved_root is None:
            self._resolved_root = await self.executor.resolve(str(self.root))
        return self._resolved_root

    @asynccontextmanager
    async def lock(self) -> AsyncIterator[None]:
        """Serialize work on this checkout. Keyed on (event loop, resolved root):
        the loop because tests run several, the root because that is what two
        callers actually contend over."""
        key = (asyncio.get_running_loop(), await self.resolved_root())
        existing = _REPO_LOCKS.get(key)
        if existing is None:
            existing = asyncio.Lock()
            _REPO_LOCKS[key] = existing
        async with existing:
            yield

    # ------------------------------------------------------------------
    # Inspection
    # ------------------------------------------------------------------

    async def is_repo(self) -> bool:
        return (await self.git("rev-parse", "--is-inside-work-tree")).ok

    async def head(self) -> str:
        return await self.required("rev-parse", "HEAD", code=GitErrorCode.NOT_A_REPO)

    async def current_branch(self) -> str | None:
        """``None`` when detached — callers must refuse to act on a detached HEAD."""
        result = await self.git("rev-parse", "--abbrev-ref", "HEAD")
        name = result.stdout.strip() if result.ok else ""
        return None if name in ("", "HEAD") else name

    async def get_remote_url(self, name: str = "origin") -> str | None:
        result = await self.git("config", "--get", f"remote.{name}.url")
        return result.stdout.strip() or None if result.ok else None

    async def remote_head(self, branch: str | None = None) -> str:
        target = validate_branch_name(branch or self.branch or "")
        await self.fetch(target)
        result = await self.git("rev-parse", "--verify", f"refs/remotes/origin/{target}")
        if not result.ok:
            raise GitError(GitErrorCode.BRANCH_NOT_FOUND, "Remote branch not found")
        return result.stdout.strip()

    async def remote_branch_exists(self, branch: str | None = None) -> bool:
        target = validate_branch_name(branch or self.branch or "")
        if not self.remote_url:
            raise GitError(GitErrorCode.REMOTE_INVALID, "No remote configured")
        result = await self.git(
            "ls-remote", "--heads", self.remote_url, f"refs/heads/{target}", auth=True
        )
        if not result.ok:
            raise GitError(self._failure_code(result), "Could not reach the remote")
        return bool(result.stdout.strip())

    async def relation(self, local: str, remote: str) -> str:
        """``aligned`` | ``ahead`` | ``behind`` | ``diverged``."""
        if local == remote:
            return "aligned"
        if (await self.git("merge-base", "--is-ancestor", remote, local)).ok:
            return "ahead"
        return "behind" if (await self.git("merge-base", "--is-ancestor", local, remote)).ok else "diverged"

    async def status_paths(self, *paths: str) -> list[str]:
        scope = ["--", *paths] if paths else []
        out = await self.required("status", "--porcelain", *scope)
        return [line for line in out.splitlines() if line.strip()]

    @staticmethod
    def _failure_code(result: CommandResult) -> GitErrorCode:
        """Classify a git failure without echoing what git said (it can hold the token).

        One classifier for every remote operation. Split in two it drifted
        immediately: "terminal prompts disabled" was only recognised on clone, so
        the same missing credential during a fetch reported as an unreachable
        upstream.
        """
        detail = f"{result.stderr}\n{result.stdout}".lower()
        # git says this two different ways depending on the verb: "could not find
        # remote branch X to clone" (warning) alongside "Remote branch X not
        # found in upstream origin" (fatal), and "couldn't find remote ref" for
        # fetch. All three mean the same thing to a caller.
        if (
            "could not find remote branch" in detail
            or "couldn't find remote ref" in detail
            or ("remote branch" in detail and "not found" in detail)
        ):
            return GitErrorCode.BRANCH_NOT_FOUND
        if any(m in detail for m in ("authentication failed", "permission denied", "forbidden", "http 403")):
            return GitErrorCode.AUTH_FAILED
        if "terminal prompts disabled" in detail or "could not read username" in detail:
            return GitErrorCode.AUTH_REQUIRED
        if any(m in detail for m in ("non-fast-forward", "fetch first", "rejected")):
            return GitErrorCode.PUSH_REJECTED
        return GitErrorCode.UPSTREAM_UNAVAILABLE

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def ensure(
        self,
        *,
        sparse_paths: Sequence[str] | None = None,
        depth: int | None = None,
        blobless: bool = False,
        single_branch: bool = False,
    ) -> None:
        """Clone if missing; otherwise verify the existing checkout is the right repo.

        A cached checkout pointing at a different remote is an error, not
        something to silently re-point — that is how one repo's contents end up
        served as another's.
        """
        if await self.executor.exists(str(self.root / ".git")):
            existing = await self.get_remote_url()
            if self.remote_url and existing and _normalize_remote(existing) != _normalize_remote(self.remote_url):
                raise GitError(GitErrorCode.REMOTE_MISMATCH, "Cached checkout points at a different repository")
            return

        if not self.remote_url:
            raise GitError(GitErrorCode.REMOTE_INVALID, "No remote configured to clone from")
        if await self.executor.exists(str(self.root)) and await self.executor.list_dir(str(self.root)):
            raise GitError(GitErrorCode.NOT_A_REPO, "Clone target is not empty")

        args = ["clone"]
        if blobless:
            args.append("--filter=blob:none")
        if sparse_paths is not None:
            args.append("--sparse")
        if single_branch:
            args.append("--single-branch")
        if depth:
            args.extend(["--depth", str(depth)])
        if self.branch:
            args.extend(["--branch", self.branch])
        args.extend([self.remote_url, str(self.root)])

        await self.executor.make_dirs(str(self.root.parent))
        result = await self.git(*args, auth=True, cwd=self.root.parent)
        if not result.ok:
            raise GitError(self._failure_code(result), "Could not clone the repository")
        if sparse_paths is not None:
            await self.set_sparse_paths(sparse_paths)

    async def fetch(self, branch: str | None = None, *, prune: bool = True) -> None:
        args = ["fetch", "--no-tags"]
        if prune:
            args.append("--prune")
        args.append("origin")
        if branch:
            args.append(validate_branch_name(branch))
        result = await self.git(*args, auth=True)
        if not result.ok:
            raise GitError(self._failure_code(result), "Could not fetch from the remote")

    async def sync(self, *, expected_head: str | None = None, branch: str | None = None) -> str:
        """Fetch and hard-align the working tree to the remote branch; returns the head.

        ``expected_head`` is optimistic concurrency: when given, the remote must
        still be at that commit or the caller's view is stale.
        """
        target = validate_branch_name(branch or self.branch or "")
        remote_head = await self.remote_head(target)
        if expected_head and remote_head.lower() != expected_head.lower():
            raise GitError(
                GitErrorCode.ORIGIN_OUT_OF_DATE,
                "Remote has moved",
                data={"head_commit": remote_head},
            )
        if not (await self.git("checkout", "-B", target, remote_head)).ok:
            raise GitError(GitErrorCode.UPSTREAM_UNAVAILABLE, "Could not check out the remote branch")
        if not (await self.git("clean", "-fdx")).ok:
            raise GitError(GitErrorCode.UPSTREAM_UNAVAILABLE, "Could not clean the checkout")
        return remote_head

    # ------------------------------------------------------------------
    # Sparse checkout
    # ------------------------------------------------------------------

    async def set_sparse_paths(self, paths: Iterable[str]) -> None:
        """Restrict the working tree to ``paths`` (cone mode).

        Each path is validated as repo-relative first: a sparse path is a caller
        input, and ``..`` in one would widen the checkout past the subtree the
        caller thinks it asked for.
        """
        cleaned = [_repo_relative(p) for p in paths]
        if not cleaned:
            raise GitError(GitErrorCode.PATH_ESCAPES_REPO, "At least one sparse path is required")
        if not (await self.git("sparse-checkout", "set", *cleaned)).ok:
            raise GitError(GitErrorCode.COMMAND_FAILED, "Could not set the sparse paths")

    async def sparse_paths(self) -> list[str]:
        result = await self.git("sparse-checkout", "list")
        if not result.ok:
            return []
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    # ------------------------------------------------------------------
    # Safety
    # ------------------------------------------------------------------

    async def safe_path(self, rel: str) -> Path:
        """Resolve a repo-relative path, refusing anything that leaves the repo.

        Rejects ``..`` and ``.git`` segments lexically, then re-checks after
        resolution so a symlink cannot smuggle the path out. Symlink *components*
        are refused outright — following one inside the repo is still a way to
        reach content the caller did not name.

        Note: ``CommandExecutor.is_symlink`` is always False on a remote node, so
        the symlink guarantee holds only for a local executor. The containment
        check below holds either way.
        """
        relative = _repo_relative(rel)
        root = Path(await self.resolved_root())
        candidate = root.joinpath(*PurePosixPath(relative).parts) if relative else root
        resolved = Path(await self.executor.resolve(str(candidate)))
        if resolved != root and root not in resolved.parents:
            raise GitError(GitErrorCode.PATH_ESCAPES_REPO, "Path escapes the repository root")

        cursor = root
        for part in PurePosixPath(relative).parts if relative else ():
            cursor = cursor / part
            if await self.executor.is_symlink(str(cursor)):
                raise GitError(GitErrorCode.PATH_ESCAPES_REPO, "Symlinked path components are not allowed")
            if cursor != root and await self.executor.exists(str(cursor / ".git")):
                raise GitError(GitErrorCode.PATH_ESCAPES_REPO, "Nested repositories are not allowed")
        return candidate

    async def tree_is_confined(self, rel_path: str) -> bool:
        """True when every changed or untracked path lives under ``rel_path``.

        The belt to ``safe_path``'s braces: it catches a mutation that landed
        outside the subtree even if the path checks let it through.
        """
        scope = _repo_relative(rel_path)
        changed = await self.required("diff", "--name-only", "HEAD", "--")
        untracked = await self.required("ls-files", "--others", "--exclude-standard")
        for line in [*changed.splitlines(), *untracked.splitlines()]:
            candidate = line.strip()
            if candidate and candidate != scope and not candidate.startswith(f"{scope}/"):
                return False
        return True

    async def normalize_keep_markers(self, scope: str | None = None) -> None:
        """Write a marker into every otherwise-empty directory, remove it once a
        real sibling appears. Git cannot represent an empty directory."""
        base = self.root / _repo_relative(scope) if scope else self.root
        await self._normalize_keep_markers_at(base)

    async def _normalize_keep_markers_at(self, directory: Path) -> None:
        if not await self.executor.is_dir(str(directory)):
            return
        names = await self.executor.list_dir(str(directory))
        for name in names:
            if name != ".git":
                await self._normalize_keep_markers_at(directory / name)
        visible = [n for n in names if n not in (KEEP_FILE, ".git")]
        marker = directory / KEEP_FILE
        if visible:
            if await self.executor.exists(str(marker)):
                await self.executor.remove(str(marker))
        elif directory != self.root and not await self.executor.exists(str(marker)):
            await self.executor.write_bytes(str(marker), b"")

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    async def create_branch(self, name: str, *, start_point: str | None = None, push: bool = False) -> str:
        """Create ``name`` (at ``start_point``, default current HEAD) and optionally publish it."""
        branch = validate_branch_name(name)
        args = ["checkout", "-B", branch]
        if start_point:
            args.append(start_point)
        if not (await self.git(*args)).ok:
            raise GitError(GitErrorCode.COMMAND_FAILED, "Could not create the branch")
        self.branch = branch
        if push:
            await self.push(refspec=f"HEAD:refs/heads/{branch}", set_upstream=True)
        return await self.head()

    async def commit(
        self,
        paths: Sequence[str],
        message: str,
        *,
        author: "GitAuthor | None" = None,
        trailers: Sequence[str] = (),
        scoped_index: bool = False,
    ) -> str | None:
        """Stage ``paths`` and commit. Returns the new HEAD, or ``None`` if nothing changed.

        ``scoped_index=True`` commits through a temporary ``GIT_INDEX_FILE`` and
        then realigns only these paths in the real index. That is what lets the
        publish path commit an asset inside a checkout where the user has
        unrelated staged work — without it, publishing silently commits their
        staging area.
        """
        scoped = [_repo_relative(p) for p in paths] or ["."]
        env: dict[str, str] = {}
        if author is not None:
            env |= {
                "GIT_AUTHOR_NAME": author.name,
                "GIT_AUTHOR_EMAIL": author.email,
                "GIT_COMMITTER_NAME": author.name,
                "GIT_COMMITTER_EMAIL": author.email,
            }

        index_path: Path | None = None
        if scoped_index:
            index_path = self.root / f".git/flowpad-index-{id(self)}"
            await self.executor.remove(str(index_path))
            env["GIT_INDEX_FILE"] = str(index_path)

        try:
            if scoped_index and not (await self.git("read-tree", "HEAD", env=env)).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not prepare the commit index")
            if not (await self.git("add", "-A", "--", *scoped, env=env)).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not stage the paths")
            diff = await self.git("diff", "--cached", "--quiet", "--", *scoped, env=env)
            if diff.returncode == 0:
                return None
            if diff.returncode != 1:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not inspect the staged change")

            body = "\n".join([message, "", *trailers]) if trailers else message
            if not (
                await self.git("-c", "commit.gpgSign=false", "commit", "--no-gpg-sign", "-m", body, env=env)
            ).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not commit")
            if scoped_index and not (await self.git("reset", "-q", "HEAD", "--", *scoped)).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not finalize the commit")
            return await self.head()
        finally:
            if index_path is not None:
                await self.executor.remove(str(index_path))

    async def push(
        self,
        *,
        refspec: str | Sequence[str] | None = None,
        set_upstream: bool = False,
        rebase_retry: bool = False,
    ) -> None:
        """Push one or more refspecs in a single invocation.

        Several refspecs travel together so they cost one connection and one
        credential handshake — and so a caller advancing two refs cannot end up
        with one moved and the other not.
        """
        target = validate_branch_name(self.branch or "") if self.branch else None
        if refspec is None:
            specs = [f"HEAD:refs/heads/{target}" if target else "HEAD"]
        else:
            specs = [refspec] if isinstance(refspec, str) else list(refspec)
        args = ["push"]
        if set_upstream:
            args.append("--set-upstream")
        args.extend(["origin", *specs])

        result = await self.git(*args, auth=True)
        if result.ok:
            return
        if not rebase_retry or not target:
            raise GitError(self._failure_code(result), "Could not push to the remote")

        # Someone else advanced the branch between our fetch and our push. Rebase
        # onto them and try once; a second failure is a real conflict.
        await self.fetch(target)
        if not (await self.git("rebase", f"origin/{target}")).ok:
            await self.git("rebase", "--abort")
            raise GitError(GitErrorCode.PUSH_REJECTED, "Could not rebase onto the remote branch")
        retry = await self.git(*args, auth=True)
        if not retry.ok:
            raise GitError(self._failure_code(retry), "Could not push to the remote")

    async def restore(self, head: str | None) -> None:
        """Best-effort return to a known commit after a failed mutation."""
        await self.git("rebase", "--abort")
        if head:
            await self.git("reset", "--hard", head)
        await self.git("clean", "-fdx")

    async def pull(self, branch: str | None = None) -> str:
        """Pull, PRESERVING local changes — the opposite of :meth:`sync_mirror`.

        For a working tree the user edits. Refuses a detached HEAD rather than
        guessing which branch was meant.
        """
        target = branch or await self.current_branch()
        if not target:
            raise GitError(GitErrorCode.BRANCH_INVALID, "Cannot pull onto a detached HEAD")
        result = await self.git("pull", "origin", validate_branch_name(target), auth=True)
        if not result.ok:
            raise GitError(self._failure_code(result), "Could not pull from the remote")
        return result.stdout.strip()

    async def sync_mirror(self, branch: str | None = None) -> bool:
        """Force the tree to match its remote, DISCARDING local changes.

        For a checkout the app manages and the user never edits. Returns whether
        the working tree is now different from what it was — which is the
        question a caller actually asks ("must I re-index?"), and is not the same
        as "did HEAD move": when the remote is unchanged but the tree was dirty,
        the reset rewrites those files and reporting "nothing changed" would tell
        the caller to skip an index the reset just invalidated.
        """
        target = branch or await self.current_branch()
        if not target:
            raise GitError(GitErrorCode.BRANCH_INVALID, "Cannot mirror a detached HEAD")
        target = validate_branch_name(target)

        was_dirty = bool(await self.status_paths())
        before = await self.head()
        await self.fetch(target, prune=False)
        remote = await self.required("rev-parse", f"origin/{target}")

        if not (await self.git("reset", "--hard", f"origin/{target}")).ok:
            raise GitError(GitErrorCode.COMMAND_FAILED, "Could not reset onto the remote branch")
        # Indexing also CREATES files (capsules, sidecars); `reset --hard` leaves
        # untracked ones behind, so a mirror has to clean them or it is only half
        # a mirror.
        await self.git("clean", "-fd")
        return before != remote or was_dirty

    async def add_commit_push(
        self,
        paths: Sequence[str],
        message: str,
        *,
        author: "GitAuthor | None" = None,
    ) -> tuple[str | None, bool]:
        """Stage ``paths``, commit, and push. Returns ``(head or None, pushed)``.

        ``head is None`` means the paths were already clean — not a failure.
        Rebases once onto the remote if someone else moved the branch first.
        """
        head = await self.commit(paths, message, author=author)
        if head is None:
            return None, False
        await self.push(rebase_retry=True)
        return head, True

    @classmethod
    async def remote_access(
        cls,
        remote_url: str,
        *,
        executor: CommandExecutor,
        token: str | None = None,
    ) -> tuple[bool, str | None]:
        """``(reachable, default_branch)`` without fetching a single object.

        ``ls-remote --symref HEAD`` is the provider-agnostic probe: it answers
        anonymously for public repos and with ``token`` for private ones, over
        the same credential path a clone would use — so "the check passed" and
        "the clone will work" cannot disagree.
        """
        probe = cls(Path("."), executor=executor, remote_url=remote_url, token=token)
        result = await probe.git("ls-remote", "--symref", _assert_no_credentials(remote_url), "HEAD", auth=True)
        if not result.ok:
            return False, None
        for line in result.stdout.splitlines():
            if line.startswith("ref:"):
                parts = line.split()
                if len(parts) >= 2 and parts[1].startswith("refs/heads/"):
                    return True, parts[1].removeprefix("refs/heads/")
        return True, None


def _normalize_remote(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme == "file":
        return str(Path(parsed.path).resolve())
    return value.strip().removesuffix(".git").removesuffix("/").lower()


def _repo_relative(rel: str | None) -> str:
    """A repo-relative path with no way out of the repo.

    Rejects ``..`` and ``.git`` segments and absolute paths. Backslashes are
    normalized first so a Windows-style path cannot smuggle a segment past the
    check.
    """
    candidate = (rel or "").replace("\\", "/").strip("/")
    if not candidate or candidate == ".":
        return ""
    parts = [p for p in candidate.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise GitError(GitErrorCode.PATH_ESCAPES_REPO, "Parent segments are not allowed")
    if any(p.lower() == ".git" for p in parts):
        raise GitError(GitErrorCode.PATH_ESCAPES_REPO, "The .git directory is not addressable")
    if KEEP_FILE in parts:
        raise GitError(GitErrorCode.PATH_ESCAPES_REPO, f"{KEEP_FILE} is reserved")
    return "/".join(parts)
