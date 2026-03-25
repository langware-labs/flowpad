import asyncio
import json
import os
import platform
import re
import textwrap
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal, TypedDict

import anyio
from fastmcp import Context
from fastmcp.server.dependencies import get_http_headers
from mcp_auth import create_mcp_server
from pydantic import Field

# Create an MCP server
mcp = create_mcp_server("ShellMCP")


@dataclass
class ShellSession:
    id: str
    process: asyncio.subprocess.Process
    workdir: str
    command_counter: int
    created_at: datetime
    last_accessed: datetime
    is_windows: bool

    @property
    def exit_marker(self) -> str:
        """
        Exit marker is a string that is written to the stdout of the process when the process exits.
        It is used to signal the end of the output and the return code of the process.
        """
        if self.is_windows:
            # Windows cmd uses %ERRORLEVEL% for exit code
            return f"EXIT_MARKER_{self.id}__{self.command_counter}:%ERRORLEVEL%"
        else:
            # Unix/Linux uses $? for exit code
            return f"EXIT_MARKER_{self.id}__{self.command_counter}:$?"

    @property
    def exit_marker_pattern(self) -> re.Pattern:
        return re.compile(f"EXIT_MARKER_{self.id}__{self.command_counter}:(\\d+)")


# Global session storage
sessions: dict[str, ShellSession] = {}


def get_environment_variables() -> dict[str, str]:
    request_headers = get_http_headers()
    env_vars = {}
    for k, v in request_headers.items():
        if k.startswith("x-flow-env-"):
            key = k[len("x-flow-env-") :].upper()
            # Header value is already a string from mcp_server.py
            # It's either a JSON string (for dict/list) or a plain string (for other types)
            # Only special case: json.dumps(None) produces "null", convert to empty string
            if v == "null":
                env_vars[key] = ""
            else:
                env_vars[key] = v
    return env_vars


def get_shell_command() -> tuple[str, bool]:
    """Get the appropriate shell command based on the platform"""
    is_windows = platform.system().lower() == "windows"
    if is_windows:
        return "cmd /Q", True
    else:
        return "/bin/bash", False


async def create_shell_session(workdir: str | None = None) -> ShellSession:
    """Create a new interactive shell session"""
    session_id = str(uuid.uuid4())
    shell_cmd, is_windows = get_shell_command()

    # Get environment variables
    env_keys_to_remove = ["FLOWPAD_MCP_TOKEN", "E2B_SANDBOX"]
    env = {k: v for k, v in os.environ.items() if k not in env_keys_to_remove} | get_environment_variables()

    # Enable colored output in the shell
    env["FORCE_COLOR"] = "1"  # For tools that support FORCE_COLOR
    env["CLICOLOR_FORCE"] = "1"  # For BSD/macOS tools
    env["TERM"] = "xterm-256color"  # Standard terminal type with color support
    env["PYTHONUNBUFFERED"] = "1"  # Enable unbuffered output for streaming

    # Create interactive shell process
    process = await asyncio.create_subprocess_shell(
        shell_cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=workdir,
        env=env,
    )

    session = ShellSession(
        id=session_id,
        process=process,
        workdir=workdir or os.getcwd(),
        created_at=datetime.now(),
        last_accessed=datetime.now(),
        command_counter=-1,
        is_windows=is_windows,
    )

    sessions[session_id] = session
    return session


async def dump_output_to_file(
    content: str, session_id: str, output_type: Literal["stdout", "stderr"], command_counter: int
) -> str:
    """Dump large output to a temporary file and return the file path."""
    folder_path = anyio.Path(".flowpad") / ".shell" / session_id
    await anyio.Path(folder_path).mkdir(parents=True, exist_ok=True)
    file_path = folder_path / f"{output_type}_{command_counter}.txt"
    await anyio.Path(file_path).write_text(content, encoding="utf-8")
    return str(file_path)


def create_dumped_output_message(
    file_path: str, content: str, output_type: Literal["stdout", "stderr"], preview_chars: int
) -> str:
    """Create a message for dumped output with preview."""
    preview = content[:preview_chars]
    if len(content) > preview_chars:
        preview += "\n... (truncated)"

    return textwrap.dedent(
        """
        Output dumped to: {file_path}
        Use 'sed' or 'grep' to read the file efficiently to avoid loading large content.

        Preview ({output_type}):
        {preview}
        """
    ).format(file_path=file_path, preview=preview, output_type=output_type)


class ShellExecuteResponse(TypedDict):
    session_id: str | None
    stdout: str
    stdout_dumped: bool
    stderr: str
    stderr_dumped: bool
    return_code: int | None
    status: Literal["completed", "running", "terminated", "error"]


@dataclass
class ShellStreamChunk:
    """A chunk of output from a streaming shell command."""

    stdout: str
    stderr: str
    return_code: int | None
    status: Literal["streaming", "completed", "error"]


class OutputBuffer:
    """Tracks output chunks and handles dumping to file when threshold exceeded."""

    DUMP_THRESHOLD = 40000

    def __init__(self, output_type: Literal["stdout", "stderr"]):
        self.output_type = output_type
        self.chunks: list[str] = []
        self.total_size = 0
        self.dump_file: str | None = None

    def append(self, content: str) -> None:
        if content:
            self.chunks.append(content)
            self.total_size += len(content)

    @property
    def needs_dump(self) -> bool:
        return self.total_size > self.DUMP_THRESHOLD

    async def finalize(self, session_id: str, command_counter: int) -> None:
        """Dump to file if threshold exceeded."""
        if self.needs_dump:
            self.dump_file = await dump_output_to_file(
                self.get_content(), session_id, self.output_type, command_counter
            )

    def get_content(self) -> str:
        return "".join(self.chunks)

    def get_final_message(self) -> str:
        content = self.get_content()
        if self.dump_file:
            return create_dumped_output_message(self.dump_file, content, self.output_type, preview_chars=1000)
        return content

    def add_to_progress(self, progress_data: dict, chunk_content: str) -> None:
        """Add output info to progress data dict."""
        if self.needs_dump:
            progress_data[f"{self.output_type}_dumped"] = True
        else:
            progress_data[self.output_type] = chunk_content


async def stream(
    stdout_stream: asyncio.StreamReader,
    stderr_stream: asyncio.StreamReader,
    exit_marker_pattern: re.Pattern,
    timeout_sec: float,
) -> AsyncIterator[ShellStreamChunk]:
    """
    Stream stdout and stderr chunks as they arrive.

    Yields ShellStreamChunk objects as output becomes available.
    The final chunk will have status="completed" and include the return code.
    """
    stdout_buffer = ""
    stderr_buffer = ""
    # The exit marker pattern looks like: EXIT_MARKER_{uuid}__{counter}:(\d+)
    # We need to keep enough buffer to detect potential partial matches
    marker_max_len = len(exit_marker_pattern.pattern) + 10

    async def read_stderr_available() -> str:
        """Read any available stderr without blocking."""
        stderr_data = ""
        while True:
            try:
                # Use wait_for with a very short timeout to check for available data
                chunk = await asyncio.wait_for(stderr_stream.read(1024), timeout=0.01)
                if not chunk:
                    break
                stderr_data += chunk.decode("utf-8", errors="ignore")
            except asyncio.TimeoutError:
                break
        return stderr_data

    def find_safe_yield_point(buffer: str) -> int:
        """Find the point up to which we can safely yield without splitting exit marker.

        Returns the index up to which we can safely yield, keeping enough buffer
        to detect partial exit marker matches. Returns 0 if nothing can be yielded yet.
        """
        if not buffer:
            return 0

        # Find the last 'E' which could be the start of EXIT_MARKER
        # We need to keep everything from the last 'E' onwards in case it's the start
        last_e_pos = buffer.rfind("E")

        if last_e_pos == -1:
            # No 'E' in buffer, safe to yield everything
            return len(buffer)

        # Keep marker_max_len chars from the last 'E' to detect partial matches
        safe_point = last_e_pos
        if safe_point > 0:
            return safe_point

        # If 'E' is at the start, we can't yield anything yet unless buffer is large
        # In that case, check if the buffer starting at 'E' could be EXIT_MARKER
        if len(buffer) > marker_max_len:
            # Buffer is large enough - if it doesn't match EXIT_MARKER prefix, yield some
            if not buffer.startswith("EXIT_MARKER"):
                # Find next 'E' after position 0
                next_e = buffer.find("E", 1)
                if next_e == -1:
                    return len(buffer)
                return next_e

        return 0

    while True:
        try:
            # Read stdout with timeout
            chunk = await asyncio.wait_for(stdout_stream.read(1024), timeout=timeout_sec)

            # Also check for any stderr
            stderr_chunk = await read_stderr_available()
            if stderr_chunk:
                stderr_buffer += stderr_chunk

            if not chunk:
                # Stream closed without exit marker - unexpected
                yield ShellStreamChunk(stdout=stdout_buffer, stderr=stderr_buffer, return_code=-1, status="error")
                break

            decoded_chunk = chunk.decode("utf-8", errors="ignore")
            stdout_buffer += decoded_chunk

            # Check if we have the exit marker
            match = exit_marker_pattern.search(stdout_buffer)
            if match:
                before_marker = stdout_buffer[: match.start()]
                return_code_str = match.group(1)

                return_code = 0
                try:
                    return_code = int(return_code_str)
                except ValueError:
                    pass

                # Read any remaining stderr
                final_stderr = await read_stderr_available()
                stderr_buffer += final_stderr

                yield ShellStreamChunk(
                    stdout=before_marker,
                    stderr=stderr_buffer,
                    return_code=return_code,
                    status="completed",
                )
                break

            # Yield content that we can safely send without risking splitting exit marker
            safe_point = find_safe_yield_point(stdout_buffer)
            if safe_point > 0 or stderr_buffer:
                stdout_output = ""
                stderr_output = ""

                if safe_point > 0:
                    stdout_output = stdout_buffer[:safe_point]
                    stdout_buffer = stdout_buffer[safe_point:]

                if stderr_buffer:
                    stderr_output = stderr_buffer
                    stderr_buffer = ""

                if stdout_output or stderr_output:
                    yield ShellStreamChunk(
                        stdout=stdout_output, stderr=stderr_output, return_code=None, status="streaming"
                    )

        except asyncio.TimeoutError:
            yield ShellStreamChunk(
                stdout=stdout_buffer,
                stderr=stderr_buffer or "Timeout waiting for command output",
                return_code=-1,
                status="error",
            )
            break


@mcp.tool(
    name="shell",
    description="Executes a command in an interactive shell session with streaming output via progress updates.",
    tags={"shell", "command", "interactive", "streaming"},
)
async def shell(
    ctx: Context,
    command: Annotated[
        str | None, Field(description="The shell command to execute, can be empty to just read from session")
    ],
    session_id: Annotated[str | None, Field(description="Optional session ID to reuse existing session")] = None,
    workdir: Annotated[
        str | None, Field(description="The working directory for the command (only used for new sessions)")
    ] = None,
    timeout: Annotated[
        int,
        Field(
            description="Time to wait for output in milliseconds before returning. Default is 5000ms. Max is 120000ms. A value of -1 will kill the session if it is running."
        ),
    ] = 5000,
) -> ShellExecuteResponse:
    """
    Executes a command in an interactive shell session.
    Streams output via progress updates, then returns final result.
    """
    try:
        await ctx.info(f"Command: {command}")
        await ctx.info(f"Session ID: {session_id}")
        await ctx.info(f"Workdir: {workdir}")
        await ctx.info(f"Timeout: {timeout}")

        if not command and not session_id:
            raise Exception("Either command or session_id must be provided")
        if timeout == -1 and not session_id:
            raise Exception("Timeout of -1 is only allowed when a session_id is provided")
        if timeout <= 0 and timeout != -1:
            raise Exception("Timeout must be greater than 0 or -1")

        if timeout > 120_000:
            await ctx.warning("Timeout is too long, setting to 120 seconds")
            timeout = 120_000

        # Get or create session
        session = None
        if session_id:
            if session_id not in sessions:
                raise Exception(f"Session {session_id} not found")
            session = sessions[session_id]
            session.last_accessed = datetime.now()
            await ctx.info(f"Reusing existing session: {session_id}")
        else:
            session = await create_shell_session(workdir)
            await ctx.info(f"Created new session: {session.id}")

        # Execute command
        if command:
            if session.process.stdin is None:
                raise Exception("Session process stdin is None")
            if session.process.stdout is None:
                raise Exception("Session process stdout is None")
            if session.process.stderr is None:
                raise Exception("Session process stderr is None")
            session.command_counter += 1

            # Use appropriate command syntax based on platform
            if session.is_windows:
                full_command = f"{command} && echo {session.exit_marker}\r\n"
            else:
                full_command = f"{command}; echo {session.exit_marker}\n"

            session.process.stdin.write(full_command.encode())
            await session.process.stdin.drain()

        if timeout > 0:
            # Stream output with progress updates as JSON
            stdout_buf = OutputBuffer("stdout")
            stderr_buf = OutputBuffer("stderr")
            completed = False
            return_code: int | None = None
            chunk_index = 0

            async for chunk in stream(
                session.process.stdout,
                session.process.stderr,
                session.exit_marker_pattern,
                timeout / 1000,
            ):
                # Collect chunks
                stdout_buf.append(chunk.stdout)
                stderr_buf.append(chunk.stderr)

                # Build progress message as JSON
                progress_data: dict = {"status": chunk.status}
                stdout_buf.add_to_progress(progress_data, chunk.stdout)
                stderr_buf.add_to_progress(progress_data, chunk.stderr)

                if chunk.return_code is not None:
                    progress_data["return_code"] = chunk.return_code

                await ctx.report_progress(progress=chunk_index, total=None, message=json.dumps(progress_data))
                chunk_index += 1

                if chunk.status == "completed":
                    completed = True
                    return_code = chunk.return_code
                elif chunk.status == "error":
                    completed = False
                    return_code = chunk.return_code

            # Dump to file if threshold exceeded (only once at the end)
            for buf in (stdout_buf, stderr_buf):
                await buf.finalize(session.id, session.command_counter)
                if buf.dump_file:
                    await ctx.info(f"{buf.output_type.capitalize()} dumped to: {buf.dump_file}")

            final_stdout = stdout_buf.get_final_message()
            final_stderr = stderr_buf.get_final_message()
            stdout_dumped = stdout_buf.needs_dump
            stderr_dumped = stderr_buf.needs_dump
        else:
            # Terminate the session
            session.process.terminate()
            try:
                await asyncio.wait_for(session.process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                session.process.kill()
                await session.process.wait()
            final_stdout, final_stderr, completed, return_code = "", "", True, None
            stdout_dumped, stderr_dumped = False, False
            del sessions[session.id]
            await ctx.info(f"Session {session.id} terminated and cleaned up")

        return {
            "session_id": session.id,
            "stdout": final_stdout,
            "stdout_dumped": stdout_dumped,
            "stderr": final_stderr,
            "stderr_dumped": stderr_dumped,
            "return_code": return_code,
            "status": "completed" if completed else ("running" if return_code is None else "terminated"),
        }

    except Exception as e:
        await ctx.error(f"Error: {e}")
        return {
            "session_id": session_id,
            "stdout": "",
            "stdout_dumped": False,
            "stderr": f"Error: {e}\n",
            "stderr_dumped": False,
            "return_code": -1,
            "status": "error",
        }
