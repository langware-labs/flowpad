"""A ``CommandExecutor`` backed by a ComputeNode — the remote half of the seam.

Lives here rather than in ``utils`` because ``utils`` is the leaf layer that
``builtin`` imports; a ComputeNode dependency there would invert the direction.

``ComputeNode.run_command`` takes a shell *string*, so this is where argv becomes
one — with the quoting rule chosen by the node's own path separator, exactly as
``faas/git_repo.py`` already does it. Callers upstream keep passing raw values.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from typing import TYPE_CHECKING, Mapping, NamedTuple, Sequence

from flow_sdk.compute.providers.env_prefix import build_env_prefix
from flow_sdk.utils.command_executor import CommandResult

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.compute_node import ComputeNode


class _EnvPair(NamedTuple):
    """``build_env_prefix`` reads ``.name``/``.value`` and deliberately refuses a
    mapping — the dict shape is the bug that module exists to remove. This is the
    smallest thing that satisfies it."""

    name: str
    value: str


class ComputeNodeCommandExecutor:
    """Runs commands and touches files on a compute node (desktop, Docker, E2B)."""

    def __init__(self, compute_node: "ComputeNode") -> None:
        self._node = compute_node

    @property
    def _windows_shell(self) -> bool:
        return getattr(getattr(self._node, "compute_provider", None), "path_sep", os.sep) == "\\"

    def _quote(self, arg: str) -> str:
        """cmd.exe has no single-quote semantics — POSIX quoting would reach the
        far end as literal quote characters and split paths on spaces."""
        if self._windows_shell:
            return subprocess.list2cmdline([arg])
        return shlex.quote(arg)

    async def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        timeout: int | None = None,
    ) -> CommandResult:
        """``timeout`` is accepted for protocol parity and not enforced — the node
        API has no per-command deadline. Do not add one here to paper over a slow
        command; fix the command."""
        command = " ".join(self._quote(arg) for arg in argv)
        prefix = build_env_prefix(
            [_EnvPair(name, value) for name, value in (env or {}).items()],
            windows=self._windows_shell,
        )
        if cwd:
            cd = f"cd /d {self._quote(cwd)}" if self._windows_shell else f"cd {self._quote(cwd)}"
            command = f"{cd} && {prefix}{command}"
        else:
            command = f"{prefix}{command}"

        cli_command = await self._node.run_command(command, background=False)
        return CommandResult(
            returncode=cli_command.exit_code or 0,
            stdout=(cli_command.all_stdout or ""),
            stderr=(cli_command.all_stderr or ""),
        )

    async def exists(self, path: str) -> bool:
        return await self._node.exists(path)

    async def is_dir(self, path: str) -> bool:
        """Asked of the parent listing rather than the path itself, so a plain file
        answers False instead of surfacing a provider error."""
        parent, _, name = path.rstrip("/").rpartition("/")
        listing = await self._node.list_dir(parent or "/")
        for items in listing.values():
            for item in items:
                if item.name == name:
                    return item.is_dir
        return False

    async def is_symlink(self, path: str) -> bool:
        """Always False: the node API exposes no ``lstat``. A caller that needs a
        symlink-based containment guarantee must run against a local executor —
        see ``GitFolder.safe_path``, which says so at the point of use."""
        return False

    async def read_bytes(self, path: str) -> bytes:
        streams = await self._node.read_files(path, "stream")
        chunks: list[bytes] = []
        for stream in streams.values():
            async for chunk in stream:
                chunks.append(chunk)
        return b"".join(chunks)

    async def write_bytes(self, path: str, data: bytes) -> None:
        await self._node.write_files(path, data)

    async def remove(self, path: str) -> None:
        await self._node.delete_files(path)

    async def make_dirs(self, path: str) -> None:
        await self._node.create_folders(path)

    async def list_dir(self, path: str) -> list[str]:
        listing = await self._node.list_dir(path)
        names: list[str] = []
        for items in listing.values():
            names.extend(item.name for item in items)
        return sorted(names)

    async def resolve(self, path: str) -> str:
        """No remote ``realpath`` in the node API, so this normalizes textually.
        Symlink resolution is not available remotely — a caller that needs a
        containment guarantee must not rely on this alone."""
        return os.path.normpath(path)
