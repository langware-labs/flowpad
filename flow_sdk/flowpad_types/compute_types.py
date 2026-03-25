"""Compute operation types for command execution and file operations."""

import asyncio
from io import BytesIO
from typing import Optional

from pydantic import BaseModel, ConfigDict


class SendFileEntry(BaseModel):
    """Contains path and data of the file to be written to the filesystem."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    remote_path: str
    data: str | bytes | BytesIO


class CLICommand(BaseModel):
    """Represents a CLI command execution with streaming support."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    message_id: str
    command: str
    exit_code: Optional[int] = None
    stdout: list[str] = []
    stderr: list[str] = []

    def __init__(self, command: str, message_id: str, **kwargs):
        """Initialize a CLI command."""
        super().__init__(command=command, message_id=message_id, **kwargs)
        self._stdout_queue: asyncio.Queue = asyncio.Queue()
        self._stderr_queue: asyncio.Queue = asyncio.Queue()
        self._completed = asyncio.Event()

    @property
    def all_stdout(self) -> str:
        """Get all stdout as a single string."""
        return "".join(self.stdout)

    @property
    def all_stderr(self) -> str:
        """Get all stderr as a single string."""
        return "".join(self.stderr)

    def append_stdout(self, line: str) -> None:
        """Append a line to stdout."""
        if hasattr(self, "_stdout_queue"):
            self._stdout_queue.put_nowait(line)
        self.stdout.append(line)

    def append_stderr(self, line: str) -> None:
        """Append a line to stderr."""
        if hasattr(self, "_stderr_queue"):
            self._stderr_queue.put_nowait(line)
        self.stderr.append(line)

    def mark_complete(self, exit_code: int) -> None:
        """Mark the command as complete with an exit code."""
        self.exit_code = exit_code
        if hasattr(self, "_completed"):
            self._completed.set()
            if hasattr(self, "_stdout_queue"):
                self._stdout_queue.put_nowait(None)
            if hasattr(self, "_stderr_queue"):
                self._stderr_queue.put_nowait(None)

    async def stdout_stream(self):
        """Stream stdout lines as they become available."""
        if not hasattr(self, "_stdout_queue"):
            self._stdout_queue = asyncio.Queue()
        while True:
            line = await self._stdout_queue.get()
            if line is None:
                break
            yield line

    async def stderr_stream(self):
        """Stream stderr lines as they become available."""
        if not hasattr(self, "_stderr_queue"):
            self._stderr_queue = asyncio.Queue()
        while True:
            line = await self._stderr_queue.get()
            if line is None:
                break
            yield line

    async def wait(self, timeout: Optional[float] = None) -> bool:
        """Wait for the command to complete.

        Args:
            timeout: Optional timeout in seconds

        Returns:
            True if completed, False if timed out
        """
        try:
            if not hasattr(self, "_completed"):
                self._completed = asyncio.Event()
            if timeout is None:
                await self._completed.wait()
                return True
            else:
                await asyncio.wait_for(self._completed.wait(), timeout)
                return True
        except asyncio.TimeoutError:
            return False
