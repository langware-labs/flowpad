"""Local machine compute provider for executing code locally.

Ported from FlowPad: flowpad/hub/core/faas/compute/providers/local_compute_provider.py
Import rewrites applied per MIGRATION_INSTRUCTIONS.md Section 5.
"""

import asyncio
import logging
import os
import platform
import shutil
import sys
import tempfile
import threading
import uuid
from io import BytesIO
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Literal

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.pty_session import Pty as PtySession

import anyio
import psutil

from flow_sdk.config import PLATFORM_DARWIN, PLATFORM_WIN32

from ..compute_provider import (
    ComputeProvider,
    ListDirItem,
    get_remote_paths_and_data_for_files,
)

from flow_sdk.flowpad_types import CLICommand, ExecutionEnvironmentStatus, RuntimeEnvironment, SendFileEntry
from flow_sdk.flowpad_types.machine_status import MACHINE_STATUS_SCRIPT, ComputeNodeInfo
from flow_sdk.flowpad_types.runtime_environment import ComputeNodeSize

logger = logging.getLogger(__name__)

_INHERITED_NO_COLOR_ENV_VARS = (
    "NO_COLOR",
    "NODE_DISABLE_COLORS",
    # Set by Codex automation sessions; interactive Flowpad PTYs should not
    # inherit the parent automation contract.
    "CODEX_CI",
)

_FALSEY_COLOR_ENV_VARS = (
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "FORCE_COLOR",
)

_FALSEY_ENV_VALUES = {"0", "false", "no", "off"}


def _build_interactive_pty_env(
    session_id: str,
    extra_env: dict[str, str] | None = None,
) -> dict[str, str]:
    """Build the environment for a visible, interactive PTY child process.

    The server may itself be launched from automation with color-suppressing
    variables (for example NO_COLOR or CODEX_CI). A Flowpad PTY is an
    interactive xterm, so inherited automation markers must not leak into
    Claude/Codex/plain shells by default. Explicit per-worker env still wins
    through ``extra_env``.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}

    for key in _INHERITED_NO_COLOR_ENV_VARS:
        env.pop(key, None)

    for key in _FALSEY_COLOR_ENV_VARS:
        if env.get(key, "").strip().lower() in _FALSEY_ENV_VALUES:
            env.pop(key, None)

    env["TERM"] = "xterm-256color"
    if not env.get("COLORTERM"):
        env["COLORTERM"] = "truecolor"
    env["FLOWPAD_PTY_SESSION_ID"] = session_id

    if extra_env:
        env.update(extra_env)
    return env

# Cross-platform PTY support
PTY_AVAILABLE = False
PtyProcess = None
_pty_import_error = None

if sys.platform == PLATFORM_WIN32:
    # Windows: use winpty (pywinpty package provides winpty module)
    try:
        from winpty import PtyProcess  # type: ignore[assignment]

        PTY_AVAILABLE = True
    except ImportError as e:
        PTY_AVAILABLE = False
        PtyProcess = None
        _pty_import_error = f"winpty: {e}"
else:
    # Unix-like: use ptyprocess
    try:
        from ptyprocess import PtyProcess  # type: ignore[assignment]

        PTY_AVAILABLE = True
    except ImportError as e:
        PTY_AVAILABLE = False
        PtyProcess = None
        _pty_import_error = f"ptyprocess: {e}"

# Unix-only imports (for fallback process management)
if sys.platform != PLATFORM_WIN32:
    import fcntl
    import termios
else:
    fcntl = None
    termios = None


def get_shell_rc_file() -> str:
    """
    Detect the current shell and return the appropriate rc file path.

    Returns:
        Path to the shell's rc file (e.g., ~/.zshrc, ~/.bashrc)
    """
    shell = os.environ.get("SHELL", "")
    if "zsh" in shell:
        return "~/.zshrc"
    elif "fish" in shell:
        return "~/.config/fish/config.fish"
    else:
        return "~/.bashrc"


def get_set_env_cmd(name: str, value: str | None) -> str:
    """
    Generate a command to set or remove an environment variable persistently.

    Supports:
    - Windows: Uses PowerShell [Environment]::SetEnvironmentVariable
    - Unix-like systems (macOS, Linux): Always uses ~/.bashrc for consistency with E2B provider

    Note: We always use ~/.bashrc (not shell-specific rc files) to ensure consistent behavior
    across different shells and match the E2B provider's behavior for test compatibility.

    Args:
        name: The environment variable name
        value: The value to set, or None to remove the variable

    Returns:
        Shell command string to execute
    """
    if sys.platform == PLATFORM_WIN32:
        if value is None:
            return f"powershell -Command \"[Environment]::SetEnvironmentVariable('{name}', $null, 'User')\""
        else:
            escaped_value = value.replace("'", "''")
            return f"powershell -Command \"[Environment]::SetEnvironmentVariable('{name}', '{escaped_value}', 'User')\""

    # Unix-like systems (macOS, Linux) - always use ~/.bashrc for consistency
    rc_file = "~/.bashrc"

    # Bash/Zsh syntax (export VAR=value)
    if value is None:
        return f"touch {rc_file}; sed -i '' '/^export {name}=/d' {rc_file} 2>/dev/null || sed -i '/^export {name}=/d' {rc_file}"
    else:
        escaped_value = value.replace("'", "'\\''")
        return (
            f"touch {rc_file}; sed -i '' '/^export {name}=/d' {rc_file} 2>/dev/null || sed -i '/^export {name}=/d' {rc_file}; "
            f"echo \"export {name}='{escaped_value}'\" >> {rc_file}"
        )


class LocalComputeProvider(ComputeProvider):
    def __init__(self):
        super().__init__()
        self._node_dirs: dict[str, str] = {}
        self._commands_tasks: dict[str, list[asyncio.Task]] = {}
        self._stream_tasks: dict[str, list[asyncio.Task]] = {}  # Track stdout/stderr read tasks per node
        self._pty_sessions: dict[tuple[str, str], dict[str, Any]] = {}  # (provider_node_id, session_id) -> pty info
        self._node_status: dict[str, ExecutionEnvironmentStatus] = {}

    @property
    def _default_working_dir(self) -> str:
        """Get default working directory, using the instance value."""
        return self.default_working_dir

    def get_temp_folder(self) -> str:
        """Get the system temp folder for local compute."""
        return tempfile.gettempdir()

    def get_home_path(self) -> str:
        """Get the sandbox home path for local compute."""
        return self._default_working_dir

    def get_node_info(self, size: ComputeNodeSize | str = None) -> ComputeNodeInfo:
        """Get actual machine specs for local provider (ignores size parameter)."""
        os_type = platform.system()
        if os_type == "Darwin":
            os_type = "macOS"

        cpu_count = psutil.cpu_count(logical=True) or 1
        memory_gb = round(psutil.virtual_memory().total / (1024**3), 2)

        return ComputeNodeInfo(
            size="local",  # Indicate this is local provider
            cpu_count=cpu_count,
            memory_gb=memory_gb,
            os_type=os_type,
        )

    async def create_node(
        self, name: str, runtime: RuntimeEnvironment, size: ComputeNodeSize = ComputeNodeSize.SMALL
    ) -> str:
        """Create a new local compute node (size parameter is ignored)."""
        node_id = f"local_{uuid.uuid4().hex[:8]}"
        node_dir = self._default_working_dir
        if not node_dir or node_dir == ".":
            node_dir = tempfile.mkdtemp(prefix=f"compute_node_{name}_")
        os.makedirs(node_dir, exist_ok=True)
        self._node_dirs[node_id] = node_dir
        self._node_status[node_id] = ExecutionEnvironmentStatus.NEW
        self.default_working_dir = node_dir
        logger.info(f"Creating new local compute node: {name}, working directory: {node_dir}")
        return node_id

    async def startup(self, provider_node_id: str, config: dict | None = None) -> bool:
        """Start the local compute node."""
        if provider_node_id not in self._node_status:
            self._node_status[provider_node_id] = ExecutionEnvironmentStatus.READY
        else:
            self._node_status[provider_node_id] = ExecutionEnvironmentStatus.READY
        return True

    async def shutdown(self, provider_node_id: str):
        """Shutdown the local compute node and cancel all associated tasks."""
        # Close PTY sessions
        keys_to_remove = [key for key in self._pty_sessions.keys() if key[0] == provider_node_id]
        for key in keys_to_remove:
            await self.close_pty_session(provider_node_id, key[1])

        # Cancel all stream reading tasks for the node
        if provider_node_id in self._stream_tasks:
            for task in self._stream_tasks[provider_node_id]:
                if not task.done():
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass  # Expected when cancelling
                    except Exception as e:
                        logger.error(f"Error waiting for stream task cancellation: {str(e)}")
            del self._stream_tasks[provider_node_id]

        # Cancel all command tasks for the node
        if provider_node_id in self._commands_tasks:
            for task in self._commands_tasks[provider_node_id]:
                if not task.done():
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass  # Expected when cancelling
                    except Exception as e:
                        logger.error(f"Error waiting for command task cancellation: {str(e)}")
            del self._commands_tasks[provider_node_id]

        # Clean up node dir tracking (don't delete working dir for local provider)
        if provider_node_id in self._node_dirs:
            del self._node_dirs[provider_node_id]

        if provider_node_id in self._node_status:
            del self._node_status[provider_node_id]

    async def pause(self, provider_node_id: str, immediate: bool = False):
        """Pause the local compute node (no-op for local provider)."""
        return True

    async def pause_all(self):
        """Pause all local compute nodes."""
        pass

    async def resume(self, provider_node_id: str):
        """Resume the local compute node."""
        pass

    async def get_node_status(self, provider_node_id: str) -> ExecutionEnvironmentStatus:
        """Get the status of the local compute node."""
        return self._node_status.get(provider_node_id, ExecutionEnvironmentStatus.READY)

    async def set_node_status(self, provider_node_id: str, status: ExecutionEnvironmentStatus):
        """Set the status of the local compute node."""
        self._node_status[provider_node_id] = status

    def get_host(self, provider_node_id: str, port: int) -> str:
        """Get the host address to connect to the local compute node."""
        return f"http://localhost:{port}"

    async def exists(self, provider_node_id: str, remote_paths: str | list[str]) -> bool:
        """Check if a file exists on the local compute node."""
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]
        return all(await asyncio.gather(*(anyio.Path(path).exists() for path in remote_paths)))

    async def write_files(
        self,
        provider_node_id: str,
        remote_path_or_files: str | list[SendFileEntry],
        data_or_local_path: str | bytes | BytesIO | None = None,
    ) -> list[str]:
        """Write files to the local compute node."""
        remote_paths, remote_data = get_remote_paths_and_data_for_files(remote_path_or_files, data_or_local_path)
        for path, data in zip(remote_paths, remote_data):
            await anyio.Path(path).parent.mkdir(parents=True, exist_ok=True)
            async with await anyio.open_file(path, "wb") as f:
                await f.write(data)
        return remote_paths

    async def read_files(
        self,
        provider_node_id: str,
        remote_paths: str | list[str],
        file_format: Literal["text", "stream"] = "text",
    ) -> dict[str, str] | dict[str, AsyncIterator[bytes]]:
        """Read files from the local compute node."""
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]

        if file_format == "text":
            result = {}
            for path in remote_paths:
                try:
                    async with await anyio.open_file(path, "r") as f:
                        result[path] = await f.read()
                except Exception as e:
                    result[path] = f"Error reading file: {str(e)}"
            return result
        else:
            async def iter_file_content(file_path: str):
                try:
                    async with await anyio.open_file(file_path, "rb") as f:
                        content = await f.read()
                    for i in range(0, len(content), 8192):
                        yield content[i : i + 8192]
                except Exception as e:
                    yield f"Error reading file: {str(e)}".encode()

            return {path: iter_file_content(path) for path in remote_paths}

    async def list_dir(self, provider_node_id: str, remote_paths: str | list[str]):
        """List the contents of a directory on the local compute node."""

        async def list_dir_item(remote_path: str):
            paths = [path async for path in anyio.Path(remote_path).iterdir()]
            is_dirs = await asyncio.gather(*(path.is_dir() for path in paths))
            return [
                ListDirItem(name=path.name, remote_path=str(path), is_dir=is_dir)
                for path, is_dir in zip(paths, is_dirs)
            ]

        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]

        items = await asyncio.gather(*(list_dir_item(path) for path in remote_paths))
        return {path: items[i] for i, path in enumerate(remote_paths)}

    async def delete_files(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        """Delete files from the local compute node."""
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]

        async def delete_path(path: anyio.Path):
            if await path.is_dir():
                shutil.rmtree(str(path))
            else:
                await path.unlink(missing_ok=True)

        await asyncio.gather(*(delete_path(anyio.Path(path)) for path in remote_paths))

    async def create_folders(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        """Create folders on the local compute node."""
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]
        await asyncio.gather(*(anyio.Path(path).mkdir(parents=True, exist_ok=True) for path in remote_paths))

    async def set_env(self, provider_node_id: str, name: str, value: str | None) -> None:
        """Set or remove an environment variable on the local compute node.

        Uses get_set_env_cmd() to generate the appropriate command for the platform.

        Args:
            provider_node_id: The ID of the compute node
            name: The environment variable name
            value: The value to set, or None to remove the variable
        """
        cmd = get_set_env_cmd(name, value)
        result = await self.run_command(provider_node_id, cmd, background=False)
        if result.exit_code != 0:
            logger.warning(
                f"set_env command returned non-zero exit code: {result.exit_code}, stderr: {result.all_stderr}"
            )

    async def configure_lm_proxy_env(
        self, provider_node_id: str, api_key: str, backend_url: str, lm_proxy_url: str, machine_id: str
    ) -> None:
        # Intentionally do nothing - local machines should use their own Anthropic API keys
        pass

    async def get_machine_status(self, provider_node_id: str) -> dict:
        """Get machine status (CPU, memory, processes, network).

        Args:
            provider_node_id: Provider-specific node ID

        Returns:
            Dict with machine status information
        """
        try:
            result = {
                "processes": [],
                "network": [],
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "memory_total_gb": 0.0,
                "memory_available_gb": 0.0,
            }

            result["cpu_percent"] = psutil.cpu_percent(interval=0.1)
            mem = psutil.virtual_memory()
            result["memory_percent"] = mem.percent
            result["memory_total_gb"] = round(mem.total / (1024**3), 2)
            result["memory_available_gb"] = round(mem.available / (1024**3), 2)

            processes = []
            for proc in psutil.process_iter(["pid", "name", "memory_info", "exe", "status"]):
                try:
                    cpu_percent = proc.cpu_percent()
                    info = proc.info
                    processes.append({
                        "pid": info["pid"],
                        "name": info["name"] or "unknown",
                        "cpu_percent": cpu_percent,
                        "memory_mb": round((info["memory_info"].rss if info["memory_info"] else 0) / (1024**2), 2),
                        "path": info["exe"] or "",
                        "status": info["status"] or "unknown",
                    })
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    pass

            processes.sort(key=lambda x: x["cpu_percent"], reverse=True)
            result["processes"] = processes[:100]

            connections = []
            try:
                net_conns = psutil.net_connections(kind="inet")
                for conn in net_conns:
                    if conn.laddr and conn.laddr.port:
                        connections.append({
                            "port": conn.laddr.port,
                            "pid": conn.pid or 0,
                            "process_name": "",
                            "process_path": "",
                            "status": conn.status,
                            "type": "TCP" if conn.type == 1 else "UDP",
                        })
            except (psutil.AccessDenied, PermissionError, OSError):
                pass

            result["network"] = connections
            return result
        except Exception:
            return {
                "processes": [],
                "network": [],
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "memory_total_gb": 0.0,
                "memory_available_gb": 0.0,
            }

    async def run_command(
        self,
        provider_node_id: str,
        command: str,
        session_id: str | None = None,
        background: bool = True,
        env: list | None = None,
    ) -> CLICommand:
        """Run a command in the local compute node."""
        logger.info(f"Running command in local working directory: {command}")
        message_id = str(uuid.uuid4())
        cmd = CLICommand(command, message_id=message_id)
        self.running_commands[message_id] = cmd

        env_prefix = ""
        if env:
            env_assignments = []
            for flow_env in env:
                # Extract the actual value from SecretStr
                env_value = flow_env.value.get_secret_value() if hasattr(flow_env.value, 'get_secret_value') else str(flow_env.value)

                if sys.platform == PLATFORM_WIN32:
                    escaped_value = (
                        env_value.replace("&", "^&")
                        .replace("|", "^|")
                        .replace("<", "^<")
                        .replace(">", "^>")
                        .replace("^", "^^")
                    )
                    env_assignments.append(f"set {flow_env.name}={escaped_value}")
                else:
                    escaped_value = env_value.replace("'", "'\\''")
                    env_assignments.append(f"{flow_env.name}='{escaped_value}'")

            if sys.platform == PLATFORM_WIN32:
                env_prefix = " && ".join(env_assignments) + " && "
            else:
                env_prefix = " ".join(env_assignments) + " "

        try:
            full_command = env_prefix + command if env_prefix else command
            process = await asyncio.create_subprocess_shell(
                full_command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._node_dirs.get(provider_node_id, self._default_working_dir),
                # Increase buffer limit to 10MB to handle large outputs (e.g., system profile JSON)
                limit=10 * 1024 * 1024,
            )

            if not background:
                # Foreground mode: use communicate() to avoid line-length buffer issues
                try:
                    stdout_data, stderr_data = await process.communicate()
                    if stdout_data:
                        cmd.append_stdout(stdout_data.decode())
                    if stderr_data:
                        cmd.append_stderr(stderr_data.decode())
                    cmd.mark_complete(process.returncode or 0)
                except Exception as e:
                    logger.error(f"Error running foreground command: {str(e)}")
                    cmd.mark_complete(-1)
                return cmd

            # Background mode: stream output line by line
            async def read_stream(stream, append_func):
                """Read from a stream and append to command output."""
                if stream is not None:
                    async for line in stream:
                        append_func(line.decode())

            # Read stdout and stderr concurrently
            stdout_task = asyncio.create_task(
                read_stream(process.stdout, cmd.append_stdout),
                name=f"local_compute_stdout_{provider_node_id}_{process.pid}",
            )
            stderr_task = asyncio.create_task(
                read_stream(process.stderr, cmd.append_stderr),
                name=f"local_compute_stderr_{provider_node_id}_{process.pid}",
            )

            # Track stream tasks for proper cleanup
            if provider_node_id not in self._stream_tasks:
                self._stream_tasks[provider_node_id] = []
            self._stream_tasks[provider_node_id].extend([stdout_task, stderr_task])

            async def handle_output(stdout_task, stderr_task):
                try:
                    # Wait for process completion and output reading
                    return_code = await process.wait()
                    await asyncio.gather(stdout_task, stderr_task)
                    cmd.mark_complete(return_code)
                except Exception as e:
                    logger.error(f"Error handling command output on local compute: {str(e)}")
                    cmd.mark_complete(-1)
                finally:
                    # Clean up completed stream tasks
                    if provider_node_id in self._stream_tasks:
                        self._stream_tasks[provider_node_id] = [
                            t for t in self._stream_tasks[provider_node_id] if t not in [stdout_task, stderr_task]
                        ]

            # Background mode: start async task to wait for completion
            task = asyncio.create_task(
                handle_output(stdout_task, stderr_task),
                name=f"local_compute_handle_output_{provider_node_id}_{process.pid}",
            )

            # Keep track of the command tasks for the node
            if provider_node_id not in self._commands_tasks:
                self._commands_tasks[provider_node_id] = []
            self._commands_tasks[provider_node_id].append(task)

            return cmd
        except Exception as e:
            logger.error(f"Error running command: {str(e)}")
            cmd.mark_complete(-1)
            return cmd

    async def get_or_create_pty_session(
        self,
        provider_node_id: str,
        session_id: str,
        on_output: Callable[[bytes], None],
        rows: int = 24,
        cols: int = 80,
        working_dir: str | None = None,
        on_exit: Callable[[int | None], None] | None = None,
        spawn_args: list[str] | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Get or create a PTY session for the given provider node and session ID.

        Args:
            provider_node_id: The ID of the local compute node
            session_id: The session ID for the PTY
            on_output: Callback function to handle PTY output (data: bytes) -> None
            rows: Number of rows for the PTY
            cols: Number of columns for the PTY
            working_dir: Optional working directory for the PTY session.
                        If not provided, uses self.default_working_dir.
            on_exit: Optional callback fired when the PTY process exits.
                     Receives the exit code (int or None). Called from the daemon
                     read thread — use asyncio.run_coroutine_threadsafe if you
                     need to run async code.

        Returns:
            Dictionary containing PTY session information
        """
        if not PTY_AVAILABLE:
            if sys.platform == PLATFORM_WIN32:
                error_msg = "PTY support not available - pywinpty not installed. Install with: pip install pywinpty"
            else:
                error_msg = "PTY support not available - ptyprocess not installed. Install with: pip install ptyprocess"
            if _pty_import_error:
                error_msg += f" ({_pty_import_error})"
            raise RuntimeError(error_msg)

        pty_key = (provider_node_id, session_id)

        if pty_key not in self._pty_sessions:
            env = _build_interactive_pty_env(session_id, extra_env)

            if spawn_args is not None:
                # Direct spawn: caller provides exact argv (e.g. Claude CLI directly)
                final_spawn_args = spawn_args
            else:
                # Shell spawn: detect and configure the user's default shell
                if sys.platform == PLATFORM_WIN32:
                    # Windows: prefer PowerShell, fallback to cmd.exe
                    shell_cmd = None

                    # Try to find PowerShell using PATH (works regardless of install location)
                    for pwsh_name in ["pwsh", "powershell"]:
                        found_pwsh = shutil.which(pwsh_name)
                        if found_pwsh:
                            shell_cmd = found_pwsh
                            break

                    # If PowerShell not found in PATH, try common locations
                    if shell_cmd is None:
                        system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR", "C:\\Windows")
                        program_files = os.environ.get("ProgramFiles", "C:\\Program Files")

                        pwsh_paths = [
                            os.path.join(program_files, "PowerShell", "7", "pwsh.exe"),
                            os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
                        ]
                        for path in pwsh_paths:
                            if os.path.exists(path):
                                shell_cmd = path
                                break

                    # Fallback to cmd.exe
                    if shell_cmd is None:
                        shell_cmd = os.environ.get("COMSPEC")
                        if not shell_cmd:
                            system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR", "C:\\Windows")
                            shell_cmd = os.path.join(system_root, "System32", "cmd.exe")
                else:
                    # Unix-like: use user's default shell
                    user_shell = os.environ.get("SHELL", "")
                    if user_shell and os.path.exists(user_shell):
                        shell_cmd = user_shell
                    elif sys.platform == "darwin":
                        # macOS defaults to zsh
                        shell_cmd = "/bin/zsh"
                    else:
                        # Linux/Unix - try bash, fallback to sh
                        shell_cmd = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"

                # Configure spawn arguments (command + flags) based on shell type
                if sys.platform == PLATFORM_WIN32:
                    # Windows: PowerShell or cmd.exe
                    if shell_cmd and ("powershell" in shell_cmd.lower() or "pwsh" in shell_cmd.lower()):
                        final_spawn_args = [shell_cmd, "-NoProfile", "-NoLogo"]
                    else:
                        final_spawn_args = [shell_cmd]
                else:
                    # Unix: configure based on shell type
                    if shell_cmd.endswith("zsh"):
                        # zsh: interactive shell (no -l to avoid .zprofile/.zlogin blocking)
                        # The parent env already carries PATH and user settings.
                        final_spawn_args = [shell_cmd]
                        env["ZSH_DISABLE_COMPFIX"] = "true"
                        env["ZDOTDIR"] = os.path.expanduser("~")
                    elif shell_cmd.endswith("bash"):
                        # bash: skip profile files to avoid system messages
                        final_spawn_args = [shell_cmd, "--norc", "--noprofile"]
                    else:
                        final_spawn_args = [shell_cmd]

            # Spawn PTY using ptyprocess/winpty (cross-platform)
            pty_working_dir = working_dir if working_dir else self._node_dirs.get(provider_node_id, self._default_working_dir)
            # Ensure working directory exists (required on Windows for winpty)
            os.makedirs(pty_working_dir, exist_ok=True)

            logger.info(
                f"Spawning PTY (session={session_id}, cwd={pty_working_dir!r}, "
                f"argv={final_spawn_args!r})"
            )
            try:
                pty_process = PtyProcess.spawn(  # type: ignore[union-attr]
                    final_spawn_args,
                    cwd=pty_working_dir,
                    env=env,
                    dimensions=(rows, cols),
                )

                pty_session_running = {"value": True}

                def read_pty_output():
                    """Read from PTY and call on_output callback."""
                    exit_code: int | None = None
                    try:
                        while pty_session_running["value"]:
                            try:
                                # Read available data (non-blocking)
                                if pty_process.isalive():
                                    data = pty_process.read(1024)
                                    if data:
                                        try:
                                            # winpty returns str, ptyprocess returns bytes
                                            # Convert to bytes for consistent callback interface
                                            if isinstance(data, str):
                                                data_bytes = data.encode("utf-8")
                                            else:
                                                data_bytes = data
                                            on_output(data_bytes)
                                        except Exception as e:
                                            logger.warning(f"Error in PTY output callback: {str(e)}")
                                else:
                                    # Process died
                                    try:
                                        exit_code = pty_process.exitstatus
                                    except Exception:
                                        pass
                                    logger.info(
                                        f"PTY process exited (session={session_id}, "
                                        f"argv={final_spawn_args!r}, exit_code={exit_code})"
                                    )
                                    break
                            except EOFError:
                                # PTY closed
                                break
                            except Exception as read_exc:
                                if not pty_session_running["value"]:
                                    break
                                logger.warning(
                                    f"PTY read error (session={session_id}, "
                                    f"argv={final_spawn_args!r}): {read_exc!r}"
                                )
                                break
                    except Exception:
                        pass
                    finally:
                        if on_exit is not None:
                            try:
                                on_exit(exit_code)
                            except Exception as e:
                                logger.warning(f"Error in PTY on_exit callback: {e}")

                read_thread = threading.Thread(target=read_pty_output, daemon=True)
                read_thread.start()

                self._pty_sessions[pty_key] = {
                    "pid": pty_process.pid,
                    "process": pty_process,  # Store the PtyProcess object
                    "running": pty_session_running,
                    "read_thread": read_thread,
                    "on_output": on_output,  # Store callback for potential restart
                }

            except Exception as e:
                logger.error(f"Failed to create PTY: {e}")
                raise RuntimeError(f"Failed to create PTY session: {e}") from e

        return self._pty_sessions[pty_key]

    def get_pty_shell_pid(self, provider_node_id: str, session_id: str) -> int | None:
        """Return the OS PID of the shell process for this PTY session, or None."""
        session = self._pty_sessions.get((provider_node_id, session_id))
        return session["pid"] if session else None

    @staticmethod
    def _is_process_alive(pid: int) -> bool:
        """Check if a process is alive (cross-platform)."""
        try:
            if sys.platform == PLATFORM_WIN32:
                return psutil.pid_exists(pid)
            else:
                os.kill(pid, 0)
                return True
        except (OSError, ImportError):
            return False

    async def _cleanup_dead_pty_session(self, pty_key: tuple[str, str], reason: str = "process died") -> None:
        """Clean up a dead PTY session."""
        if pty_key in self._pty_sessions:
            logger.info(f"[LOCAL] Cleaning up dead PTY session: {pty_key}, reason: {reason}")
            pty_info = self._pty_sessions[pty_key]
            pty_info["running"]["value"] = False

            process = pty_info.get("process")  # type: ignore[assignment]
            if process:
                try:
                    if process.isalive():
                        process.terminate(force=True)
                except Exception:
                    pass

            del self._pty_sessions[pty_key]

    async def send_pty_input(
        self, provider_node_id: str, session_id: str, data: bytes, cols: int, rows: int, _retry_count: int = 0
    ) -> None:
        """Send input to a PTY session.

        Args:
            provider_node_id: The ID of the local compute node
            session_id: The session ID for the PTY
            data: Bytes to send to the PTY
            cols: Number of columns for the PTY
            rows: Number of rows for the PTY
            _retry_count: Internal retry count for handling dead processes
        """
        pty_key = (provider_node_id, session_id)
        if pty_key not in self._pty_sessions:
            raise RuntimeError(f"PTY session not found for {provider_node_id}:{session_id}")

        pty_info = self._pty_sessions[pty_key]
        process = pty_info["process"]  # type: ignore[assignment]
        on_output = pty_info.get("on_output")

        # Validate process is still alive
        if not process.isalive():
            logger.info(f"[LOCAL] PTY process died (PID {process.pid}), cleaning up and restarting: {session_id}")

            # Store the on_output callback before cleanup
            await self._cleanup_dead_pty_session(pty_key, "process died before sending input")

            # Retry once by creating a new PTY session
            if _retry_count < 1 and on_output is not None:
                logger.info(f"[LOCAL] Restarting PTY session and retrying input: {session_id}")
                # Recreate the PTY session with the same callback
                await self.get_or_create_pty_session(provider_node_id, session_id, on_output, rows, cols)
                # Retry the input operation
                return await self.send_pty_input(provider_node_id, session_id, data, cols, rows, _retry_count + 1)

            raise RuntimeError(
                f"PTY process died (PID {process.pid}). Session cleaned up: {provider_node_id}:{session_id}"
            )

        try:
            # Write to PTY
            # winpty expects str, ptyprocess expects bytes
            if sys.platform == PLATFORM_WIN32:
                # Windows: winpty.write() expects str
                if isinstance(data, bytes):
                    process.write(data.decode("utf-8", errors="replace"))
                else:
                    process.write(data)
            else:
                # Unix: ptyprocess.write() expects bytes
                if isinstance(data, str):
                    process.write(data.encode("utf-8"))
                else:
                    process.write(data)
        except Exception as e:
            # Process or FD became invalid
            logger.warning(f"[LOCAL] Write to PTY failed: {str(e)}")
            await self._cleanup_dead_pty_session(pty_key, f"write failed: {str(e)}")

            # Retry once
            if _retry_count < 1 and on_output is not None:
                logger.info(f"[LOCAL] Restarting PTY after write failure and retrying: {session_id}")
                # Recreate the PTY session
                await self.get_or_create_pty_session(provider_node_id, session_id, on_output, rows, cols)
                # Retry the operation
                return await self.send_pty_input(provider_node_id, session_id, data, cols, rows, _retry_count + 1)

            raise RuntimeError(f"Failed to write to PTY (process may have died): {str(e)}") from e

    async def resize_pty(
        self, provider_node_id: str, session_id: str, cols: int, rows: int, _retry_count: int = 0
    ) -> None:
        """Resize a PTY session.

        Args:
            provider_node_id: The ID of the local compute node
            session_id: The session ID for the PTY
            cols: Number of columns
            rows: Number of rows
            _retry_count: Internal retry counter (max 1 retry)
        """
        pty_key = (provider_node_id, session_id)
        if pty_key not in self._pty_sessions:
            raise RuntimeError(f"PTY session not found for {provider_node_id}:{session_id}")

        pty_info = self._pty_sessions[pty_key]
        process = pty_info["process"]  # type: ignore[assignment]
        on_output = pty_info.get("on_output")

        # Validate process is still alive
        if not process.isalive():
            logger.info(f"[LOCAL] PTY process died (PID {process.pid}), cleaning up and restarting: {session_id}")

            await self._cleanup_dead_pty_session(pty_key, "process died before resize")

            # Retry once by creating a new PTY session
            if _retry_count < 1 and on_output is not None:
                logger.info(f"[LOCAL] Restarting PTY session and retrying resize: {session_id}")
                # Recreate the PTY session with the same callback
                await self.get_or_create_pty_session(provider_node_id, session_id, on_output, rows, cols)
                # Retry the resize operation
                return await self.resize_pty(provider_node_id, session_id, cols, rows, _retry_count + 1)

            raise RuntimeError(
                f"PTY process died (PID {process.pid}). Session cleaned up: {provider_node_id}:{session_id}"
            )

        # Resize PTY (ptyprocess/winpty both use setwinsize(rows, cols))
        try:
            process.setwinsize(rows, cols)
        except Exception as e:
            # FD became invalid
            logger.warning(f"[LOCAL] Resize PTY failed: {str(e)}")
            await self._cleanup_dead_pty_session(pty_key, f"resize failed: {str(e)}")

            # Retry once
            if _retry_count < 1 and on_output is not None:
                logger.info(f"[LOCAL] Restarting PTY after resize failure and retrying: {session_id}")
                # Recreate the PTY session
                await self.get_or_create_pty_session(provider_node_id, session_id, on_output, rows, cols)
                # Retry the operation
                return await self.resize_pty(provider_node_id, session_id, cols, rows, _retry_count + 1)

            raise RuntimeError(f"Failed to resize PTY (process may have died): {str(e)}") from e

    def is_pty_alive(self, provider_node_id: str, session_id: str) -> bool:
        """Cross-platform check whether a PTY session's process is still running."""
        pty_key = (provider_node_id, session_id)
        if pty_key not in self._pty_sessions:
            return False
        pid = self._pty_sessions[pty_key].get("pid")
        return self._is_process_alive(pid) if pid else False

    async def pick_folder(self, provider_node_id: str, initial_dir: str | None = None) -> str | None:
        """Open a native OS folder-picker dialog on the local machine.

        Args:
            provider_node_id: The local compute node provider ID.
            initial_dir: Optional path to open the dialog at initially. The frontend
                sends VFS-relative paths (no leading slash) — we rewrite those to
                absolute OS paths here so the native dialogs can consume them.
        """
        import subprocess
        from flow_sdk.config import get_os_root_path

        # Normalize VFS-relative → absolute OS path. Drop the hint if it doesn't
        # resolve to an existing directory, so a stale/bogus suggestion never
        # fails the whole dialog.
        if initial_dir:
            if sys.platform == PLATFORM_WIN32:
                has_drive = len(initial_dir) >= 2 and initial_dir[1] == ":"
                if not has_drive:
                    initial_dir = os.path.join(
                        get_os_root_path(), initial_dir.replace("/", os.sep).lstrip(os.sep)
                    )
            elif not initial_dir.startswith("/"):
                initial_dir = "/" + initial_dir
            if not os.path.isdir(initial_dir):
                initial_dir = None

        if sys.platform == PLATFORM_DARWIN:
            # Activate Finder to bring the dialog in front, close any Finder
            # windows so only the picker is visible, then choose folder.
            if initial_dir:
                default_location = f'default location POSIX file "{initial_dir}"'
            else:
                default_location = ""
            apple_script = (
                'tell application "Finder"\n'
                "    activate\n"
                "    close every window\n"
                "end tell\n"
                "delay 0.1\n"
                f"set theFolder to choose folder {default_location}\n"
                "return POSIX path of theFolder"
            )
            result = subprocess.run(
                ["osascript", "-e", apple_script],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip().rstrip("/")
            return None

        elif sys.platform == PLATFORM_WIN32:
            selected_path_line = (
                f'$d.SelectedPath = "{initial_dir}"; ' if initial_dir else ""
            )
            ps_script = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                f"{selected_path_line}"
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }"
            )
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                capture_output=True, text=True, timeout=120,
            )
            output = result.stdout.strip()
            return output or None

        else:
            # Linux — try zenity, then kdialog
            zenity_args = ["zenity", "--file-selection", "--directory"]
            kdialog_start = initial_dir or "."
            if initial_dir:
                zenity_args += ["--filename", initial_dir.rstrip("/") + "/"]
            for args in (
                zenity_args,
                ["kdialog", "--getexistingdirectory", kdialog_start],
            ):
                try:
                    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
                    if result.returncode == 0 and result.stdout.strip():
                        return result.stdout.strip()
                    return None  # dialog ran but user cancelled
                except FileNotFoundError:
                    continue

            raise RuntimeError("No supported file dialog found (install zenity or kdialog)")

    async def close_pty_session(self, provider_node_id: str, session_id: str) -> None:
        """Close a PTY session.

        Args:
            provider_node_id: The ID of the local compute node
            session_id: The session ID for the PTY
        """
        pty_key = (provider_node_id, session_id)
        if pty_key in self._pty_sessions:
            pty_info = self._pty_sessions[pty_key]
            pty_info["running"]["value"] = False

            process = pty_info.get("process")  # type: ignore[assignment]
            if process:
                try:
                    if process.isalive():
                        process.terminate(force=True)
                except Exception as e:
                    message = str(e)
                    if "there was no child process" not in message and "waitpid" not in message:
                        logger.warning(f"Error terminating PTY process: {message}")

            del self._pty_sessions[pty_key]

    def list_pty_sessions(self, cn_id: str) -> list[dict]:
        """Return [{shell_id, connection_id, name}] for all active sessions on this node."""
        from .pty_session_manager import session_manager
        result = []
        for (compute_node_id, _pn_id, shell_id), state in session_manager.sessions.items():
            if compute_node_id == cn_id:
                result.append({
                    "shell_id": shell_id,
                    "connection_id": state.connection_id,
                    "compute_node_id": compute_node_id,
                    "name": state.name or shell_id,
                })
        return result

    def reset_all_sessions(self, cn_id: str, pn_id: str | None = None) -> int:
        """Clear all in-memory PTY state for a node. Returns count of sessions cleared."""
        from .pty_session_manager import session_manager
        node_keys = [k for k in session_manager.sessions if k[0] == cn_id]
        for key in node_keys:
            del session_manager.sessions[key]
        if pn_id:
            provider_keys = [k for k in self._pty_sessions if k[0] == pn_id]
            for key in provider_keys:
                del self._pty_sessions[key]
        return len(node_keys)

    def get_pty_session(self, cn_id: str, shell_id: str) -> "PtySession | None":
        """Return a LocalPtySession handle if an active session exists."""
        from .local_pty_session import LocalPtySession
        from .pty_session_manager import session_manager
        for key in session_manager.sessions:
            if key[0] == cn_id and key[2] == shell_id:
                return LocalPtySession(key[0], key[1], key[2], self, session_manager)
        return None
