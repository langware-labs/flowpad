"""One way to run a command and touch files — wherever the work actually happens.

Git is implemented several times across this codebase because each copy is welded
to *how* it runs: local ``subprocess`` in ``utils/git.py`` and
``assets/git_worktree.py``, a remote shell in ``builtin/faas/git_repo.py``. The
git logic is identical; only the substrate differs. ``CommandExecutor`` is that
substrate, so a caller can be written once against exit codes and IO.

Two rules the implementations must agree on, because they are the places where a
local and a remote executor would otherwise diverge silently:

* **``env`` is an additive overlay, never a replacement.** A remote node can only
  prepend assignments to a command; it cannot hand the child a fresh environment.
  So ``env`` means "these variables, on top of whatever the target already has"
  in both implementations. A caller that wants a scrubbed environment must scrub
  it itself.
* **``argv`` is a real argument vector.** Callers never pre-quote and never build
  a shell string. Quoting belongs to the implementation, which is the only thing
  that knows whether the far end is POSIX or ``cmd.exe``.

``ComputeNodeCommandExecutor`` deliberately lives in ``builtin/faas/`` rather than
here: ``utils`` is the leaf layer that ``builtin`` imports, and putting a
ComputeNode dependency in it would invert that.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol, Sequence, runtime_checkable


@dataclass(frozen=True)
class CommandResult:
    """The whole result of one command: what it wrote and how it exited."""

    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


@runtime_checkable
class CommandExecutor(Protocol):
    """Run commands and touch files on some target — local disk, or a compute node.

    The file primitives are not a convenience. A git caller has to resolve paths,
    walk a tree and read blobs as well as run ``git``; a run-only protocol would
    work locally and break the moment the target is remote.
    """

    async def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: int | None = None,
    ) -> CommandResult: ...

    async def exists(self, path: str) -> bool: ...

    async def is_dir(self, path: str) -> bool: ...

    async def is_symlink(self, path: str) -> bool: ...

    async def read_bytes(self, path: str) -> bytes: ...

    async def write_bytes(self, path: str, data: bytes) -> None: ...

    async def remove(self, path: str) -> None: ...

    async def make_dirs(self, path: str) -> None: ...

    async def list_dir(self, path: str) -> list[str]: ...

    async def resolve(self, path: str) -> str: ...


class LocalCommandExecutor:
    """Runs on this machine's filesystem, off the event loop.

    Never ``shell=True``: the argv goes to ``execve`` untouched, so a path or a
    branch name containing shell metacharacters is data, not syntax.
    """

    def run_sync(
        self,
        argv: Sequence[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: int | None = None,
    ) -> CommandResult:
        """The blocking form, for callers that are not in an event loop.

        Exists so a synchronous helper does not need its own ``subprocess``
        call — there is one place a local command is built and one place its
        failures are classified. ``run`` is this, moved off the loop. Not part
        of the :class:`CommandExecutor` protocol: a remote target has no
        blocking form.
        """
        child_env = {**os.environ, **env} if env else None
        try:
            completed = subprocess.run(
                list(argv),
                cwd=cwd,
                env=child_env,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            return CommandResult(returncode=124, stdout=_as_text(exc.stdout), stderr=_as_text(exc.stderr))
        except (OSError, ValueError) as exc:
            return CommandResult(returncode=127, stdout="", stderr=f"{type(exc).__name__}")
        return CommandResult(
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )

    async def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: int | None = None,
    ) -> CommandResult:
        return await asyncio.to_thread(self.run_sync, argv, cwd=cwd, env=env, timeout=timeout)

    async def exists(self, path: str) -> bool:
        return await asyncio.to_thread(os.path.exists, path)

    async def is_dir(self, path: str) -> bool:
        return await asyncio.to_thread(os.path.isdir, path)

    async def is_symlink(self, path: str) -> bool:
        return await asyncio.to_thread(os.path.islink, path)

    async def read_bytes(self, path: str) -> bytes:
        return await asyncio.to_thread(Path(path).read_bytes)

    async def write_bytes(self, path: str, data: bytes) -> None:
        def _write() -> None:
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

        await asyncio.to_thread(_write)

    async def remove(self, path: str) -> None:
        def _remove() -> None:
            target = Path(path)
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target, ignore_errors=True)
            else:
                target.unlink(missing_ok=True)

        await asyncio.to_thread(_remove)

    async def make_dirs(self, path: str) -> None:
        await asyncio.to_thread(lambda: Path(path).mkdir(parents=True, exist_ok=True))

    async def list_dir(self, path: str) -> list[str]:
        def _list() -> list[str]:
            target = Path(path)
            if not target.is_dir():
                return []
            return sorted(entry.name for entry in target.iterdir())

        return await asyncio.to_thread(_list)

    async def resolve(self, path: str) -> str:
        """Fully resolved, symlinks followed. ``strict=False`` so a caller can
        resolve a path that does not exist yet and then decide about it."""
        return await asyncio.to_thread(lambda: str(Path(path).resolve(strict=False)))


def _as_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)
