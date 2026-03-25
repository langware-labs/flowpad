from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, AsyncGenerator

if TYPE_CHECKING:
    from .environment import Environment


@dataclass
class ShellResult:
    """Result of a shell command execution."""

    stdout: str
    stderr: str
    exit_code: int


class ShellRunner:
    """Wraps command execution in an Environment.

    Renamed from Shell to ShellRunner to avoid confusion with ShellDomain.
    The Shell alias is kept for backward compatibility.

    NOT a DomainObject subclass -- no backing Record.

    Two execution modes:
    1. run_sync() -- subprocess.run() directly. No server needed.
    2. run() -- async, delegates to LocalComputeProvider. Server-context.
    3. stream() -- async generator via provider PTY.
    """

    def __init__(
        self,
        env: Environment,
        provider: Any | None = None,
        provider_node_id: str | None = None,
    ) -> None:
        self._env = env
        self._provider = provider
        self._provider_node_id = provider_node_id
        self._pty_pid: str | None = None

    @property
    def env(self) -> Environment:
        return self._env

    def run_sync(self, cmd: str, timeout: float | None = None) -> ShellResult:
        """Execute a command synchronously via subprocess.run().

        Does NOT require a running server or async event loop.
        Uses Environment.work_dir as cwd and Environment.env_vars
        as additional environment variables.
        """
        import os

        merged_env = {**os.environ, **self._env.env_vars}
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=self._env.work_dir,
            env=merged_env,
            timeout=timeout,
        )
        return ShellResult(
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.returncode,
        )

    async def run(self, cmd: str, timeout: float | None = None) -> ShellResult:
        """Execute a command asynchronously via LocalComputeProvider.

        Requires provider and provider_node_id (set via ComputeNode wiring).
        """
        if not self._provider or not self._provider_node_id:
            raise RuntimeError(
                "Shell.run() requires a provider. Use run_sync() for "
                "headless/no-server execution, or create Shell via "
                "Environment.createShell() with a ComputeNode."
            )
        cmd_handle = await self._provider.run_command(self._provider_node_id, cmd)
        await cmd_handle.wait(timeout=timeout)
        return ShellResult(
            stdout=cmd_handle.all_stdout or "",
            stderr=cmd_handle.all_stderr or "",
            exit_code=cmd_handle.exit_code or 0,
        )

    async def stream(self, cmd: str) -> AsyncGenerator[bytes, None]:
        """Execute a command and yield output chunks as they arrive."""
        if not self._provider or not self._provider_node_id:
            raise RuntimeError("Shell.stream() requires a provider.")
        async for chunk in self._provider.stream_command(self._provider_node_id, cmd):
            yield chunk

    def startClaudeSession(
        self,
        model: str | None = None,
        permission_mode: str = "bypassPermissions",
        session_id: str | None = None,
    ) -> "ClaudeSession":
        """Start a Claude CLI session in this shell. Returns a ClaudeSession."""
        from uuid import uuid4
        from .claude_session import ClaudeSession
        return ClaudeSession(worker_session_id=session_id or str(uuid4()))

    def close(self) -> None:
        """Close the PTY session (if any)."""
        self._pty_pid = None


# Backward-compatibility alias
Shell = ShellRunner
