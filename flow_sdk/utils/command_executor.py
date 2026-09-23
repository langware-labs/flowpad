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

Every ``run`` answers with a ``CliResult`` built by ``CliResult.of_process`` —
the raw ``returncode`` for a caller that branches on it (``git diff --quiet``
answers 1 for "there is a change"), and ``exit_code`` / ``.ok`` derived from it
in that one place. ``returncode is None`` means the command never finished:
it could not start, or it ran out of time (``timed_out``).

**There is exactly one way to obtain an executor: ``ComputeNode.get_command_executor()``.**
Nothing else constructs one. That is what keeps "where does this command run"
answerable from the call site instead of defaulting silently to this machine —
and it is what lets git execution be moved inside a sandbox later without
hunting for callers that quietly assumed local.

``_LocalCommandExecutor`` below is private and exists for TESTS and for the
local compute node's own use. Production code reaches it only through a
ComputeNode.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Mapping, Protocol, Sequence, runtime_checkable

from flow_sdk.schema.data_spec.returned_value_spec import CliResult


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
    ) -> CliResult: ...

    async def exists(self, path: str) -> bool: ...

    async def is_dir(self, path: str) -> bool: ...

    async def is_symlink(self, path: str) -> bool: ...

    async def read_bytes(self, path: str) -> bytes: ...

    async def write_bytes(self, path: str, data: bytes) -> None: ...

    async def remove(self, path: str) -> None: ...

    async def make_dirs(self, path: str) -> None: ...

    async def list_dir(self, path: str) -> list[str]: ...

    async def resolve(self, path: str) -> str: ...


class _LocalCommandExecutor:
    """Runs on this machine's filesystem, off the event loop.

    PRIVATE. Obtain an executor via ``ComputeNode.get_command_executor()``; this
    class is for tests and for the local compute node.

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
    ) -> CliResult:
        """The blocking body of :meth:`run`; ``run`` is this, moved off the loop.

        Not part of the :class:`CommandExecutor` protocol — a remote target has
        no blocking form, which is why sync callers use the local probes in
        ``utils/git.py`` rather than reaching for an executor.
        """
        child_env = {**os.environ, **env} if env else None
        command = shlex.join(argv)
        started = time.monotonic()
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
            return CliResult.of_process(
                command, None, _as_text(exc.stdout), _as_text(exc.stderr),
                timed_out=True, duration_s=time.monotonic() - started, cap=None,
            )
        except (OSError, ValueError) as exc:
            return CliResult.of_process(command, None, "", f"{type(exc).__name__}: {exc}")
        # cap=None: callers PARSE this output (`git show` is a whole file, and
        # module_rpc reads JSON) — the tail-only default is for records a person
        # reads, and would hand them a file's last 8 KB as if it were the file.
        return CliResult.of_process(
            command, completed.returncode, completed.stdout or "", completed.stderr or "",
            duration_s=time.monotonic() - started, cap=None,
        )

    async def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: int | None = None,
    ) -> CliResult:
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
