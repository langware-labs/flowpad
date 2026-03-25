"""Abstract base class for compute providers."""

import os
from abc import ABC, abstractmethod
from io import BytesIO
from typing import Any, AsyncIterator, Callable, Literal, Optional, overload

from pydantic import BaseModel

from flow_sdk.flowpad_types import CLICommand, ExecutionEnvironmentStatus, RuntimeEnvironment, SendFileEntry


class ListDirItem(BaseModel):
    """Item in a directory listing."""

    name: str
    remote_path: str
    is_dir: bool


def get_remote_paths_and_data_for_files(
    remote_path_or_files: str | list[SendFileEntry],
    data_or_local_path: str | bytes | BytesIO | None = None,
) -> tuple[list[str], list[bytes]]:
    """Extract remote paths and data from file arguments.

    Args:
        remote_path_or_files: Either a single file path (str) or list of SendFileEntry objects
        data_or_local_path: Data or local file path (only used if remote_path_or_files is str)

    Returns:
        Tuple of (remote_paths, remote_data)
    """
    remote_paths: list[str] = []
    remote_data: list[bytes] = []

    if isinstance(remote_path_or_files, str):
        if data_or_local_path is None:
            raise ValueError(
                "If remote_path_or_files is a file name, data_or_local_path must be provided for file content"
            )

        if isinstance(data_or_local_path, str):
            # Check if it's a file path that exists, otherwise treat as raw content
            if os.path.exists(data_or_local_path):
                with open(data_or_local_path, "rb") as file:
                    remote_paths.append(remote_path_or_files)
                    remote_data.append(file.read())
            else:
                # Treat as raw string content
                remote_paths.append(remote_path_or_files)
                remote_data.append(data_or_local_path.encode("utf-8"))
        elif isinstance(data_or_local_path, bytes):
            remote_paths.append(remote_path_or_files)
            remote_data.append(data_or_local_path)
        elif isinstance(data_or_local_path, BytesIO):
            remote_paths.append(remote_path_or_files)
            remote_data.append(data_or_local_path.read())
        else:
            raise TypeError(f"Unsupported data_or_local_path type: {type(data_or_local_path)}")
    elif isinstance(remote_path_or_files, list):
        if data_or_local_path is not None:
            raise ValueError(
                "If remote_path_or_files is a entry list, data_or_local_path is invalid, it should be None"
            )

        for file in remote_path_or_files:
            if isinstance(file, SendFileEntry):
                remote_paths.append(file.remote_path)
                if file.data is not None:
                    if isinstance(file.data, BytesIO):
                        remote_data.append(file.data.read())
                    elif isinstance(file.data, str):
                        remote_data.append(file.data.encode("utf-8"))
                    else:
                        remote_data.append(file.data)
                else:
                    raise ValueError(f"FileEntry {file.remote_path} does not have data")
            elif isinstance(file, str):
                remote_paths.append(file)
                if os.path.exists(file):
                    with open(file, "rb") as f:
                        remote_data.append(f.read())
                else:
                    raise FileNotFoundError(f"Local compute files operations: File {file} does not exist")
    return remote_paths, remote_data


class ComputeProvider(ABC):
    """Abstract base class for compute providers.

    Provides interface for creating, managing, and executing code on compute nodes.
    Implementations can target different backends: local machine, cloud sandbox, containers, etc.
    """

    def __init__(self):
        """Initialize the compute provider."""
        self.running_commands: dict[str, CLICommand] = {}
        self.default_working_dir: str = "."

    @property
    def path_sep(self) -> str:
        """Get the path separator for this provider."""
        return os.sep

    def path_join(self, *args: str) -> str:
        """Join path components using the provider's path separator.

        Args:
            *args: Path components to join

        Returns:
            Joined path string
        """
        if not args:
            raise ValueError("path_join requires at least one path component")
        first, *rest = args
        path: str = str(os.path.join(first, *rest))
        if os.sep != self.path_sep:
            path = path.replace(os.sep, self.path_sep)
        return path

    @abstractmethod
    async def create_node(self, name: str, runtime: RuntimeEnvironment, node_size=None) -> str:
        """Create a new compute node.

        Args:
            name: Name for the compute node
            runtime: Runtime environment configuration

        Returns:
            Provider-specific node ID
        """

    def get_template_version(self) -> Optional[str]:
        """Get template version for this provider (e.g., E2B sandbox version)."""
        return None

    @abstractmethod
    async def startup(self, provider_node_id: str, config: Optional[dict] = None) -> bool:
        """Start up the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            config: Optional configuration dict

        Returns:
            True if startup succeeded
        """

    @abstractmethod
    async def shutdown(self, provider_node_id: str) -> None:
        """Shut down the compute node.

        Args:
            provider_node_id: Provider-specific node ID
        """

    @abstractmethod
    async def pause(self, provider_node_id: str) -> None:
        """Pause the compute node.

        Args:
            provider_node_id: Provider-specific node ID
        """

    @abstractmethod
    async def resume(self, provider_node_id: str) -> None:
        """Resume the compute node.

        Args:
            provider_node_id: Provider-specific node ID
        """

    @abstractmethod
    async def get_node_status(self, provider_node_id: str) -> ExecutionEnvironmentStatus:
        """Get the status of the compute node.

        Args:
            provider_node_id: Provider-specific node ID

        Returns:
            ExecutionEnvironmentStatus
        """

    def get_host(self, provider_node_id: str, port: int) -> str:
        """Get the host address to connect to the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            port: Port number to access

        Returns:
            Host address (e.g., "localhost:8000")
        """
        raise NotImplementedError("get_host not implemented")

    @abstractmethod
    async def exists(self, provider_node_id: str, remote_paths: str | list[str]) -> bool:
        """Check if files exist on the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            remote_paths: File path(s) to check

        Returns:
            True if all files exist
        """

    @abstractmethod
    async def write_files(
        self,
        provider_node_id: str,
        remote_path_or_files: str | list[SendFileEntry],
        data_or_local_path: str | bytes | BytesIO | None = None,
    ) -> list[str]:
        """Write files to the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            remote_path_or_files: Remote file path(s) or SendFileEntry list
            data_or_local_path: Data or local file path (if remote_path_or_files is str)

        Returns:
            List of written file paths
        """

    @overload
    async def read_files(
        self,
        provider_node_id: str,
        remote_paths: str | list[str],
        file_format: Literal["text"] = "text",
    ) -> dict[str, str]: ...

    @overload
    async def read_files(
        self,
        provider_node_id: str,
        remote_paths: str | list[str],
        file_format: Literal["stream"],
    ) -> dict[str, AsyncIterator[bytes]]: ...

    @overload
    async def read_files(
        self,
        provider_node_id: str,
        remote_paths: str | list[str],
        file_format: Literal["text", "stream"] = "text",
    ) -> dict[str, str] | dict[str, AsyncIterator[bytes]]: ...

    @abstractmethod
    async def read_files(
        self,
        provider_node_id: str,
        remote_paths: str | list[str],
        file_format: Literal["text", "stream"] = "text",
    ) -> dict[str, str] | dict[str, AsyncIterator[bytes]]:
        """Read files from the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            remote_paths: File path(s) to read
            file_format: "text" for string content, "stream" for binary iterator

        Returns:
            Dict mapping file paths to content (str or AsyncIterator[bytes])
        """

    @abstractmethod
    async def list_dir(self, provider_node_id: str, remote_paths: str | list[str]) -> dict[str, list[ListDirItem]]:
        """List directory contents on the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            remote_paths: Directory path(s) to list

        Returns:
            Dict mapping directory paths to lists of items
        """

    @abstractmethod
    async def delete_files(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        """Delete files on the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            remote_paths: File path(s) to delete
        """

    @abstractmethod
    async def create_folders(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        """Create directories on the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            remote_paths: Directory path(s) to create
        """

    @abstractmethod
    async def set_env(self, provider_node_id: str, name: str, value: Optional[str]) -> None:
        """Set or remove an environment variable on the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            name: Environment variable name
            value: Value to set, or None to remove
        """

    @abstractmethod
    async def run_command(
        self,
        provider_node_id: str,
        command: str,
        session_id: Optional[str] = None,
        background: bool = False,
        env: Optional[dict[str, str]] = None,
    ) -> CLICommand:
        """Execute a command on the compute node.

        Args:
            provider_node_id: Provider-specific node ID
            command: Shell command to execute
            session_id: Optional session ID for grouped commands
            background: Whether to run in background
            env: Environment variables for the command

        Returns:
            CLICommand object for tracking execution
        """

    @abstractmethod
    async def get_machine_status(self, provider_node_id: str) -> dict:
        """Get machine status (CPU, memory, processes, network).

        Args:
            provider_node_id: Provider-specific node ID

        Returns:
            Dict with machine status information
        """

    @abstractmethod
    async def get_or_create_pty_session(
        self,
        provider_node_id: str,
        session_id: str,
        on_output: Callable[[bytes], None],
        rows: int = 24,
        cols: int = 80,
        working_dir: str | None = None,
    ) -> dict[str, Any]:
        """Get or create a PTY session.

        Args:
            provider_node_id: Provider-specific node ID
            session_id: Session identifier
            on_output: Callback for PTY output (data: bytes) -> None
            rows: Terminal rows
            cols: Terminal columns
            working_dir: Optional working directory for the PTY session

        Returns:
            Dict with session info (pid, etc.)
        """

    @abstractmethod
    async def send_pty_input(
        self,
        provider_node_id: str,
        session_id: str,
        data: bytes,
        cols: int,
        rows: int,
    ) -> None:
        """Send input to PTY session.

        Args:
            provider_node_id: Provider-specific node ID
            session_id: Session identifier
            data: Input bytes to send
            cols: Terminal columns (for resize)
            rows: Terminal rows (for resize)
        """

    @abstractmethod
    async def resize_pty(
        self,
        provider_node_id: str,
        session_id: str,
        cols: int,
        rows: int,
    ) -> None:
        """Resize PTY terminal.

        Args:
            provider_node_id: Provider-specific node ID
            session_id: Session identifier
            cols: New column count
            rows: New row count
        """

    @abstractmethod
    def is_pty_alive(self, provider_node_id: str, session_id: str) -> bool:
        """Return True if the PTY session process is still running (cross-platform)."""
        return False

    async def close_pty_session(
        self,
        provider_node_id: str,
        session_id: str,
    ) -> None:
        """Close PTY session.

        Args:
            provider_node_id: Provider-specific node ID
            session_id: Session identifier
        """
