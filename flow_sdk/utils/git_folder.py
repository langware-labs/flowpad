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
from dataclasses import dataclass
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
    DETACHED_HEAD = "detached_head"
    BRANCH_AHEAD = "branch_ahead"
    BRANCH_DIVERGED = "branch_diverged"
    PUSH_REJECTED = "push_rejected"
    PATH_ESCAPES_REPO = "path_escapes_repo"
    COMMAND_FAILED = "command_failed"


@dataclass(frozen=True)
class PublishReceipt:
    """What one publish did. ``changed`` is False for an idempotent re-publish."""

    changed: bool
    head_commit: str
    branch: str


@dataclass(frozen=True)
class CheckoutReceipt:
    """Where a checked-out subtree landed, and what commit it came from."""

    head_commit: str
    path: Path


@dataclass(frozen=True)
class CaptureReceipt:
    """An inert zip of a subtree, and the commit it was taken from."""

    head_commit: str
    archive: bytes


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

    async def _required(
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

    async def _resolve_root(self) -> str:
        """The fully-resolved root, computed once."""
        if self._resolved_root is None:
            self._resolved_root = await self.executor.resolve(str(self.root))
        return self._resolved_root

    @asynccontextmanager
    async def lock(self) -> AsyncIterator[None]:
        """Serialize work on this checkout. Keyed on (event loop, resolved root):
        the loop because tests run several, the root because that is what two
        callers actually contend over."""
        key = (asyncio.get_running_loop(), await self._resolve_root())
        existing = _REPO_LOCKS.get(key)
        if existing is None:
            existing = asyncio.Lock()
            _REPO_LOCKS[key] = existing
        async with existing:
            yield

    # ------------------------------------------------------------------
    # Inspection
    # ------------------------------------------------------------------

    async def _head(self) -> str:
        return await self._required("rev-parse", "HEAD", code=GitErrorCode.NOT_A_REPO)

    async def _current_branch(self) -> str | None:
        """``None`` when detached — callers must refuse to act on a detached HEAD."""
        result = await self.git("rev-parse", "--abbrev-ref", "HEAD")
        name = result.stdout.strip() if result.ok else ""
        return None if name in ("", "HEAD") else name

    async def get_remote_url(self, name: str = "origin") -> str | None:
        result = await self.git("config", "--get", f"remote.{name}.url")
        return result.stdout.strip() or None if result.ok else None

    async def _remote_head(self, branch: str | None = None) -> str:
        target = validate_branch_name(branch or self.branch or "")
        await self._fetch(target)
        result = await self.git("rev-parse", "--verify", f"refs/remotes/origin/{target}")
        if not result.ok:
            raise GitError(GitErrorCode.BRANCH_NOT_FOUND, "Remote branch not found")
        return result.stdout.strip()

    async def _relation(self, local: str, remote: str) -> str:
        """``aligned`` | ``ahead`` | ``behind`` | ``diverged``."""
        if local == remote:
            return "aligned"
        if (await self.git("merge-base", "--is-ancestor", remote, local)).ok:
            return "ahead"
        return "behind" if (await self.git("merge-base", "--is-ancestor", local, remote)).ok else "diverged"

    async def _status_paths(self, *paths: str) -> list[str]:
        scope = ["--", *paths] if paths else []
        out = await self._required("status", "--porcelain", *scope)
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

    async def _ensure(
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
            await self._set_sparse_paths(sparse_paths)

    async def _fetch(self, branch: str | None = None, *, prune: bool = True) -> None:
        args = ["fetch", "--no-tags"]
        if prune:
            args.append("--prune")
        args.append("origin")
        if branch:
            args.append(validate_branch_name(branch))
        result = await self.git(*args, auth=True)
        if not result.ok:
            raise GitError(self._failure_code(result), "Could not fetch from the remote")

    async def _sync(self, *, expected_head: str | None = None, branch: str | None = None) -> str:
        """Fetch and hard-align the working tree to the remote branch; returns the head.

        ``expected_head`` is optimistic concurrency: when given, the remote must
        still be at that commit or the caller's view is stale.
        """
        target = validate_branch_name(branch or self.branch or "")
        remote_head = await self._remote_head(target)
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

    async def _set_sparse_paths(self, paths: Iterable[str]) -> None:
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

    async def _safe_path(self, rel: str) -> Path:
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
        root = Path(await self._resolve_root())
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

    # ------------------------------------------------------------------
    # Application operations
    # ------------------------------------------------------------------

    async def publish(
        self,
        rel_path: str,
        *,
        message: str,
        author: "GitAuthor",
        trailers: Sequence[str] = (),
        also_advance: str | None = None,
        retry_marker: str | None = None,
    ) -> PublishReceipt:
        """Commit one path and publish it. The whole operation, not a step of one.

        This exists because every caller was re-deriving the same eight-call
        sequence — align, probe, commit, push — and each one is a chance to get
        the order wrong. What a caller actually means is "publish this path".

        Three behaviours are deliberate and easy to lose:

        * **The commit is path-scoped through a temporary index**, so publishing
          inside a checkout where the user has unrelated staged work does not
          sweep it in.
        * **``retry_marker`` recovers a half-finished publish.** If a previous
          run committed and then failed to push, the branch is one commit ahead
          and would be refused forever. When the single unpushed commit carries
          this trailer it is recognised as ours and re-pushed rather than
          re-committed.
        * **``also_advance`` is pushed in the SAME invocation** as the working
          branch — one connection, one credential handshake, and no window where
          one ref moved and the other did not. It is pushed even when nothing
          changed, because the branch may not exist yet.

        Raises :class:`GitError`; callers map the code onto their own contract.
        """
        scoped = _repo_relative(rel_path)
        branch = await self._current_branch()
        if not branch:
            raise GitError(GitErrorCode.DETACHED_HEAD, "Cannot publish from a detached HEAD")
        if not await self.get_remote_url():
            raise GitError(GitErrorCode.REMOTE_INVALID, "Checkout has no origin remote")

        local_head = await self._head()
        remote_head = await self._remote_head(branch)
        relation = await self._relation(local_head, remote_head)

        retrying = relation == "ahead" and await self._is_own_pending_commit(remote_head, retry_marker)
        if relation == "ahead" and not retrying:
            raise GitError(GitErrorCode.BRANCH_AHEAD, "Local branch has unpublished commits")
        if relation in {"behind", "diverged"}:
            raise GitError(GitErrorCode.BRANCH_DIVERGED, "Local branch is not aligned with its remote")
        if retrying and await self._status_paths(scoped):
            raise GitError(GitErrorCode.BRANCH_AHEAD, "The pending commit no longer matches the working tree")

        committed = None if retrying else await self._commit(scoped, message, author=author, trailers=trailers)
        changed = retrying or committed is not None
        head = committed or local_head

        refspecs = [f"HEAD:refs/heads/{validate_branch_name(also_advance)}"] if also_advance else []
        if changed:
            refspecs.insert(0, f"HEAD:refs/heads/{branch}")
        if refspecs:
            await self._push(refspecs, head)

        return PublishReceipt(changed=changed, head_commit=head, branch=branch)

    async def checkout(
        self,
        rel_path: str,
        *,
        branch: str | None = None,
        depth: int | None = 1,
        blobless: bool = True,
    ) -> CheckoutReceipt:
        """Make one subtree of ``branch`` present on disk, and say where it is.

        The read counterpart of :meth:`publish`, and it exists for the same
        reason: callers were re-deriving clone-then-align-then-resolve, and the
        order is load-bearing — resolving the path before the branch is aligned
        hands back a subtree from whatever the previous run left behind.

        The checkout is **sparse to ``rel_path``**: a shared asset is a subtree
        of a repository that may be far larger, and cloning the rest is
        bandwidth spent on bytes nobody asked for.

        It is a **cache, not state**. An existing clone of the same repository is
        reused; one pointing at a *different* repository is refused rather than
        silently re-pointed, which is how one repo's contents end up served as
        another's.
        """
        target = validate_branch_name(branch or self.branch or "")
        scoped = _repo_relative(rel_path)
        await self.executor.make_dirs(str(self.root))
        await self._ensure(sparse_paths=[scoped], depth=depth, blobless=blobless, single_branch=True)
        head = await self._sync(branch=target)
        return CheckoutReceipt(head_commit=head, path=await self._safe_path(scoped))

    async def capture(self, rel_path: str, *, branch: str | None = None) -> CaptureReceipt:
        """Fetch a subtree and hand back **inert bytes** — the whole operation.

        This is what a consumer of a published asset actually wants: not a
        checkout, which is a live tree on a disk it then has to walk, but the
        content, in a form that cannot execute anything.

        It matters *where* the seam is. Everything dangerous — the clone, the
        checkout, git itself running against a repository we do not control —
        happens on this folder's executor. What crosses back is a zip built by
        ``git archive`` from the object database. So the caller can put this
        folder on a sandbox node and get the bytes on the host, without the host
        ever running repo content or walking a hostile tree.

        The archive is read back through the executor too, so a remote node
        works without a second transport: one file, not N round trips.
        """
        checked_out = await self.checkout(rel_path, branch=branch)
        # A sibling of the checkout, never inside it: the archive must not be a
        # candidate for the next capture of the same folder.
        dest = f"{self.root}.capture.zip"
        try:
            await self.archive(rel_path, dest, treeish=checked_out.head_commit)
            return CaptureReceipt(head_commit=checked_out.head_commit, archive=await self.executor.read_bytes(dest))
        finally:
            await self.executor.remove(dest)

    async def archive(self, rel_path: str, dest: str, *, treeish: str = "HEAD") -> str:
        """Write a zip of ``rel_path`` at ``treeish`` to ``dest``; returns ``dest``.

        Uses ``git archive``, and that choice is the security property, not a
        convenience. ``git archive`` emits **tracked content only**, straight
        from the object database:

        * ``.git/`` cannot appear — it is not tracked, so ``config`` and
          ``hooks/`` cannot ride out of the checkout and execute wherever the
          archive is unpacked.
        * a symlink is emitted as a symlink *entry*, never as a copy of what it
          points at, so a link to ``/etc/passwd`` exports a dangling link rather
          than the file's contents. (The unpacking side refuses those entries
          outright — see the hub's ``zip_transfer``.)
        * untracked and ignored working-tree junk is absent, so what ships is
          exactly what was published.

        Walking the working tree instead — ``rglob`` plus ``is_file()`` — gets
        every one of those wrong, and the symlink case silently exfiltrates.
        """
        scoped = _repo_relative(rel_path)
        # ``<treeish>:<dir>`` roots the archive AT that directory, so entries come
        # out relative to the asset. Passing the path as a pathspec instead would
        # keep its full repo-relative prefix on every member, and the unpacked
        # tree would nest the asset inside a copy of its own path.
        source = f"{treeish}:{scoped}" if scoped else treeish
        result = await self.git("archive", "--format=zip", "-o", dest, source)
        if not result.ok:
            raise GitError(self._failure_code(result), "Could not archive the path")
        return dest

    async def _is_own_pending_commit(self, remote_head: str, marker: str | None) -> bool:
        """True when the one unpushed commit is ours, identified by ``marker``.

        Without this a publish whose push failed after committing is stuck behind
        the "unpublished commits" guard forever.
        """
        if not marker:
            return False
        if await self._required("rev-list", "--count", f"{remote_head}..HEAD") != "1":
            return False
        body = await self._required("show", "-s", "--format=%B", "HEAD")
        return any(line.strip() == marker for line in body.splitlines())

    async def _commit(
        self,
        path: str,
        message: str,
        *,
        author: "GitAuthor",
        trailers: Sequence[str] = (),
    ) -> str | None:
        """Stage ``path`` and commit it. Returns the new HEAD, or ``None`` if nothing changed.

        The commit goes through a **temporary** ``GIT_INDEX_FILE``, and only
        this path is then realigned in the real index. That is what lets publish
        commit an asset inside a checkout where the user has unrelated staged
        work — without it, publishing silently commits their staging area.
        """
        scoped = path or "."
        index_path = self.root / f".git/flowpad-index-{id(self)}"
        await self.executor.remove(str(index_path))
        env = {
            "GIT_AUTHOR_NAME": author.name,
            "GIT_AUTHOR_EMAIL": author.email,
            "GIT_COMMITTER_NAME": author.name,
            "GIT_COMMITTER_EMAIL": author.email,
            "GIT_INDEX_FILE": str(index_path),
        }

        try:
            if not (await self.git("read-tree", "HEAD", env=env)).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not prepare the commit index")
            if not (await self.git("add", "-A", "--", scoped, env=env)).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not stage the path")
            diff = await self.git("diff", "--cached", "--quiet", "--", scoped, env=env)
            if diff.returncode == 0:
                return None
            if diff.returncode != 1:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not inspect the staged change")

            body = "\n".join([message, "", *trailers]) if trailers else message
            if not (
                await self.git("-c", "commit.gpgSign=false", "commit", "--no-gpg-sign", "-m", body, env=env)
            ).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not commit")
            if not (await self.git("reset", "-q", "HEAD", "--", scoped)).ok:
                raise GitError(GitErrorCode.COMMAND_FAILED, "Could not finalize the commit")
            return await self._head()
        finally:
            await self.executor.remove(str(index_path))

    async def _push(self, refspecs: Sequence[str], head: str) -> None:
        """Push every refspec in ONE invocation, keeping the failure actionable.

        They travel together so they cost one connection and one credential
        handshake — and so a caller advancing two refs cannot end up with one
        moved and the other not.

        A refused push and an unreachable remote are the same fact to a caller —
        *the commit exists locally and did not reach the remote* — so both become
        ``PUSH_REJECTED``. A credential failure is NOT flattened into that: it
        keeps its own code, so a user whose token expired mid-publish is told to
        reconnect rather than to resolve a conflict that does not exist. Either
        way the head travels along, so a retry can recognise its own work.
        """
        result = await self.git("push", "origin", *refspecs, auth=True)
        if result.ok:
            return
        code = self._failure_code(result)
        if code in (GitErrorCode.PUSH_REJECTED, GitErrorCode.UPSTREAM_UNAVAILABLE):
            raise GitError(
                GitErrorCode.PUSH_REJECTED,
                "The commit did not reach the remote",
                data={"head_commit": head},
            )
        raise GitError(code, "Could not push to the remote", data={"head_commit": head})


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
