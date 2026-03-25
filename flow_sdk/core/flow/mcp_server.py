from __future__ import annotations

import asyncio
import json
import logging
import secrets
import sys
import time
from collections.abc import Callable, Coroutine
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
from mcp.types import TextContent
from pydantic_ai.mcp import MCPServerStreamableHTTP

from flow_sdk.config import PLATFORM_WIN32, ComputeProviderType, default_service_config
from flow_sdk import service_log
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.core.entity.entity_env.env_utils import build_sod_key
from flow_sdk.core.flow.flow_source_control import ComputeSourceControl, ComputeSourceControlInitializeOptions
from flow_sdk.core.flow.models.execution.env_context import FlowEnv
from flow_sdk.request_context.methods import get_current_sod_store
from flow_sdk.flowpad_types.compute_types import SendFileEntry
from flow_sdk.utils import ROOT_FOLDER, read_files_in_parallel

# MCP server configuration constants
MCP_DESTINATION_FOLDER = ".mcp_servers"

# Default timeout between progress updates (seconds)
DEFAULT_PROGRESS_TIMEOUT_SECONDS = 300.0  # 5 minutes - same as MCP SDK default


class ProgressAwareTimeout:
    """
    A timeout handler that resets when progress is received.

    The MCP SDK has a read_timeout that applies to the total time waiting for a response.
    However, when a tool sends progress updates, this timeout should be reset on each
    progress notification, as progress indicates the operation is still active.

    This class tracks the last time progress was received and provides methods to check
    if the timeout has been exceeded since the last progress update.
    """

    def __init__(self, timeout_seconds: float = DEFAULT_PROGRESS_TIMEOUT_SECONDS):
        """
        Initialize the progress-aware timeout handler.

        Args:
            timeout_seconds: Maximum seconds to wait between progress updates before timing out.
        """
        self.timeout_seconds = timeout_seconds
        self._last_progress_time = time.monotonic()

    def reset(self) -> None:
        """Reset the timeout timer. Call this when progress is received."""
        self._last_progress_time = time.monotonic()

    def is_timed_out(self) -> bool:
        """Check if the timeout has been exceeded since the last progress update."""
        elapsed = time.monotonic() - self._last_progress_time
        return elapsed >= self.timeout_seconds

    def time_remaining(self) -> float:
        """Get the remaining time before timeout (in seconds)."""
        elapsed = time.monotonic() - self._last_progress_time
        return max(0, self.timeout_seconds - elapsed)


# Type alias for progress callback
ProgressCallbackT = Callable[[float, float | None, str | None], Coroutine[Any, Any, None]]


class FlowPadMCPServer(MCPServerStreamableHTTP):
    """
    Extended MCP server with progress-aware timeout handling.

    This subclass adds call_tool_with_progress_timeout method that resets
    the timeout whenever progress is received, preventing timeouts when
    tools are actively streaming output but take longer than read_timeout.
    """

    async def call_tool_with_progress_timeout(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        progress_callback: ProgressCallbackT | None = None,
        progress_timeout_seconds: float = DEFAULT_PROGRESS_TIMEOUT_SECONDS,
    ) -> Any:
        """
        Call an MCP tool with progress-aware timeout handling.

        Unlike the standard ClientSession.call_tool which has a fixed read_timeout,
        this method resets the timeout each time a progress notification is received.
        This prevents timeouts when tools are making progress but take longer than
        the read_timeout to complete.

        Args:
            name: The name of the tool to call.
            arguments: The arguments to pass to the tool.
            progress_callback: Optional callback to receive progress updates.
            progress_timeout_seconds: Maximum seconds to wait between progress updates.

        Returns:
            The result of the tool call (structured content or text content).

        Raises:
            TimeoutError: If no progress is received within progress_timeout_seconds.
            RuntimeError: If the server client is not initialized.
            Exception: Any exception from the underlying tool call.
        """
        if not hasattr(self, "_client") or self._client is None:
            raise RuntimeError("MCP server client is not initialized. Use 'async with server:' first.")

        timeout_handler = ProgressAwareTimeout(timeout_seconds=progress_timeout_seconds)
        result_holder: list[Any] = []
        error_holder: list[Exception] = []
        completed = asyncio.Event()

        # Wrap the progress callback to reset timeout on each progress
        async def progress_wrapper(progress: float, total: float | None, message: str | None) -> None:
            timeout_handler.reset()
            if progress_callback is not None:
                await progress_callback(progress, total, message)

        async def call_tool_task():
            """Execute the tool call in a separate task."""
            try:
                # Use a very long read_timeout since we handle timeout ourselves
                # The actual timeout is managed by the progress_timeout_seconds
                result = await self._client.call_tool(
                    name,
                    arguments,
                    read_timeout_seconds=timedelta(hours=24),  # Effectively infinite
                    progress_callback=progress_wrapper,
                )
                result_holder.append(result)
            except Exception as e:
                error_holder.append(e)
            finally:
                completed.set()

        async def timeout_monitor_task():
            """Monitor for timeout between progress updates."""
            while not completed.is_set():
                if timeout_handler.is_timed_out():
                    # Timeout occurred, but we can't cancel the call_tool
                    # Just log and let the caller handle it
                    service_log.warning(
                        f"Progress timeout: No progress received for {progress_timeout_seconds}s "
                        f"while calling tool '{name}'"
                    )
                    error_holder.append(
                        TimeoutError(
                            f"Timed out waiting for progress from tool '{name}'. "
                            f"No progress received for {progress_timeout_seconds} seconds."
                        )
                    )
                    completed.set()
                    return

                # Check every 0.5 seconds or remaining time, whichever is smaller
                wait_time = min(0.5, timeout_handler.time_remaining())
                try:
                    await asyncio.wait_for(completed.wait(), timeout=wait_time)
                    return  # Completed normally
                except asyncio.TimeoutError:
                    continue  # Keep monitoring

        # Run both tasks concurrently
        tool_task = asyncio.create_task(call_tool_task())
        monitor_task = asyncio.create_task(timeout_monitor_task())

        try:
            # Wait for either task to complete
            await completed.wait()
        finally:
            # Clean up tasks
            if not tool_task.done():
                tool_task.cancel()
                try:
                    await tool_task
                except asyncio.CancelledError:
                    pass
            if not monitor_task.done():
                monitor_task.cancel()
                try:
                    await monitor_task
                except asyncio.CancelledError:
                    pass

        # Check for errors
        if error_holder:
            raise error_holder[0]

        # Return the result
        if result_holder:
            mcp_result = result_holder[0]
            # Extract structured content or text content
            if mcp_result.structuredContent:
                result = mcp_result.structuredContent
                # Handle wrapped primitives (MCP SDK wraps primitives in a 'result' key)
                if isinstance(result, dict) and len(result) == 1 and "result" in result:
                    result = result["result"]
                return result
            else:
                # Fall back to text content
                text_parts = [part.text for part in mcp_result.content if isinstance(part, TextContent)]
                return "\n".join(text_parts) if text_parts else ""

        raise RuntimeError("Tool call completed without result or error")


# Folder containing files to copy to sandbox
COPY_TO_SANDBOX_FOLDER = Path(ROOT_FOLDER) / "hub" / "core" / "flow" / "mcp_servers" / "copy_to_sandbox"

# Dynamically load all files from copy_to_sandbox folder
MCP_SERVER_FILES = sorted(COPY_TO_SANDBOX_FOLDER.glob("*.py"))
MCP_SERVER_FILE_NAMES = [f.name for f in MCP_SERVER_FILES]

# Explicit list of MCP servers to start (must exist in MCP_SERVER_FILE_NAMES)
MCP_SERVERS_TO_START = ["shell_mcp.py", "fs_mcp.py"]


def _create_shell_tool_call_with_progress(mcp_server: FlowPadMCPServer):
    """Create a process_tool_call callback that streams progress for shell MCP tool calls.

    This factory function captures the MCP server instance and returns a callback
    that uses the FlowPadMCPServer.call_tool_with_progress_timeout method for
    progress-aware timeout handling.
    """

    async def process_shell_tool_call(ctx, direct_call_tool, name: str, tool_args: dict):
        # Get callback handler from compute session deps
        deps = ctx.deps
        callback_handler = getattr(deps, "callback_handler", None)

        # Check if server's client is initialized
        if not hasattr(mcp_server, "_client") or mcp_server._client is None:
            # Server not initialized, fall back to direct call
            return await direct_call_tool(name, tool_args)

        # Create progress callback that extracts stdout/stderr from JSON and forwards to callback handler
        async def progress_callback(progress: float, total: float | None, message: str | None) -> None:
            if message and callback_handler:
                try:
                    data = json.loads(message)
                    # Extract stdout and stderr from the progress JSON
                    stdout = data.get("stdout", "")
                    stderr = data.get("stderr", "")
                    # Forward any output to the callback handler using proper shell-output element type
                    if stdout:
                        await callback_handler.on_shell_output(stdout, "stdout")
                    if stderr:
                        await callback_handler.on_shell_output(stderr, "stderr")
                except json.JSONDecodeError:
                    # If not JSON, forward as chat (non-shell progress message)
                    await callback_handler.on_new_chunk(message)

        # Call the tool using progress-aware timeout handling
        # This ensures that progress updates reset the timeout, preventing timeouts
        # when tools are actively streaming output but take longer than read_timeout
        return await mcp_server.call_tool_with_progress_timeout(
            name=name,
            arguments=tool_args,
            progress_callback=progress_callback,
        )

    return process_shell_tool_call


@dataclass
class MCPConnector:
    compute_node: ComputeNode

    _source_control: ComputeSourceControl | None = None

    _mcp_server_token: str | None = None
    _shell_mcp_server: FlowPadMCPServer | None = None
    _fs_mcp_server: FlowPadMCPServer | None = None

    _shell_mcp_server_port: int = 8101
    _fs_mcp_server_port: int = 8102
    _mcp_initialized: bool = False

    @asynccontextmanager
    async def initialize(
        self,
        initialize_options: ComputeSourceControlInitializeOptions | None = None,
        env: "list[FlowEnv] | None" = None,
    ):
        try:
            if self._mcp_server_token is None:
                await self._initialize_mcp_server_token()
            async with self.compute_node.ready_session():
                mcp_opened = False
                if self._mcp_initialized:
                    mcp_opened = await self.is_mcp_opened()
                    self._mcp_initialized = mcp_opened
                if not mcp_opened:
                    await self._open_mcp_servers()
                    self._mcp_initialized = True
                async with self.source_control.initialize(initialize_options, env):
                    yield
        except asyncio.CancelledError:
            service_log.info("MCP connector initialization cancelled gracefully")
            raise  # Re-raise to propagate cancellation

    async def _initialize_mcp_server_token(self):
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value:
            self._mcp_server_token = "local_machine_mcp_token"
            return
        # TODO [FLOWPAD-1051] Decouple sod storage from MCP server token - MCPConnector should get the token in init
        sod_driver = get_current_sod_store()
        mcp_server_sod_key = build_sod_key(self.compute_node.typeid, "mcp_server_sod")
        try:
            self._mcp_server_token = await sod_driver.read_sod(mcp_server_sod_key)
        except KeyError:
            self._mcp_server_token = secrets.token_urlsafe(32)
            await sod_driver.write_sod(mcp_server_sod_key, self._mcp_server_token)

    async def reopen_mcp_servers(self):
        await self._close_mcp_servers()
        await self._open_mcp_servers()

    async def _close_mcp_servers(self):
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            cmd = await self.compute_node.run_command("taskkill /F /IM fastmcp.exe")
        elif self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value:
            # On local machine, only kill fastmcp processes to avoid killing the parent backend server
            # Using pkill with pattern matching is safer than lsof + kill which can hit parent processes
            cmd = await self.compute_node.run_command("pkill -9 -f 'fastmcp run' || true")
        else:
            # On remote compute nodes (e.g., E2B), it's safe to kill by port since backend runs separately
            cmd = await self.compute_node.run_command(
                f"lsof -t -i tcp:{self._shell_mcp_server_port}-{self._fs_mcp_server_port} | xargs kill -9"
            )
        await cmd.wait()
        self._shell_mcp_server = None
        self._fs_mcp_server = None

    async def test_mcp_health_no_auth(self, port: int) -> bool:
        """Test if MCP server responds without authentication"""
        try:
            url = f"{self.compute_node.get_host(port)}/mcp"
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(url)
                # Any response means server is running and reachable
                # 401 = needs auth (expected), 405 = method not allowed, etc.
                service_log.info(f"MCP server on port {port} health check (no auth): {response.status_code}")
                return True
        except httpx.TimeoutException as e:
            service_log.info(f"MCP request timeout on port {port} health check failed (no auth): {e}")
            return False
        except httpx.ConnectError as e:
            service_log.info(f"MCP request connection error: on port {port} health check error (no auth): {e}")
            return False
        except Exception as e:
            service_log.info(f"MCP access error: on port {port} health check error (no auth): {e}")
            return False

    async def test_mcp_health_auth(self, port: int) -> bool:
        """Test if MCP server responds with authentication"""
        try:
            url = f"{self.compute_node.get_host(port)}/mcp"
            headers = self._mcp_server_headers if self._mcp_server_token else {}
            headers.update({"Accept": "application/json, text/event-stream"})
            async with httpx.AsyncClient(timeout=2.0) as client:
                # First request to get mcp-session-id
                response = await client.get(url, headers=headers)
                mcp_session_id = response.headers.get("mcp-session-id", None)
                headers.update({"mcp-session-id": mcp_session_id}) if mcp_session_id else None
                service_log.info(f"MCP server mcp-session-id on port {port}: {mcp_session_id}")
                # Second request with mcp-session-id
                response = await client.get(url, headers=headers)
                # With auth, for a healthy server we expect 2xx response
                if 200 <= response.status_code < 300:
                    service_log.info(f"MCP server on port {port} health check (with auth): {response.status_code}")
                    return True
                service_log.info(f"MCP server on port {port} health check failed (with auth): {response.status_code}")
                return False
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            service_log.info(f"MCP server on port {port} health check failed (with auth): {e}")
            return False
        except Exception as e:
            service_log.info(f"MCP server on port {port} health check error (with auth): {e}")
            return False

    async def check_mcp_connection(self, port: int) -> None:
        """Validate MCP server connectivity - raises exceptions on failure"""
        # First validate no-auth endpoint responds
        no_auth_works = await self.test_mcp_health_no_auth(port)
        if not no_auth_works:
            raise ConnectionError(f"MCP server on port {port} not responding to health check (no auth)")

        # Then validate auth endpoint responds
        auth_works = await self.test_mcp_health_auth(port)
        if not auth_works:
            raise ConnectionError(f"MCP server on port {port} not responding to health check (with auth)")

        service_log.info(f"MCP server on port {port} connection validated successfully")

    async def is_mcp_opened(self) -> bool:
        """Check if MCP servers are running by testing connectivity and file existence"""
        try:
            # Check MCP server connectivity for both shell and fs servers
            for port in [self._shell_mcp_server_port, self._fs_mcp_server_port]:
                await self.check_mcp_connection(port)

            # Also check if all required MCP server files exist on the compute node
            for server_file_name in MCP_SERVER_FILE_NAMES:
                file_path = self.compute_node.compute_provider.path_join(
                    self.compute_node.compute_provider.default_working_dir, MCP_DESTINATION_FOLDER, server_file_name
                )
                # Use a simple command to check if file exists
                cmd = await self.compute_node.run_command(f"test -f {file_path}")
                await cmd.wait()
                if cmd.exit_code != 0:
                    service_log.info(f"MCP server file {file_path} not found on compute node")
                    return False

            service_log.info("All MCP servers are running and files exist on compute node")
            return True

        except ConnectionError as e:
            service_log.info(f"MCP server connectivity check failed: {e}")
            return False
        except Exception as e:
            service_log.info(f"Error checking MCP server status: {e}")
            return False

    async def _open_mcp_servers(self):
        # Copy mcp server files to the node
        service_log.info("Opening MCP servers")
        server_files_data = await read_files_in_parallel([str(path) for path in MCP_SERVER_FILES])
        await self.compute_node.write_files(
            [
                SendFileEntry(
                    path=self.compute_node.compute_provider.path_join(
                        self.compute_node.compute_provider.default_working_dir, MCP_DESTINATION_FOLDER, server_file.name
                    ),
                    data=server_file_data,
                )
                for server_file, server_file_data in zip(MCP_SERVER_FILES, server_files_data)
            ]
        )

        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value:
            await self._close_mcp_servers()
        # Run fastmcp servers (only the ones explicitly listed in MCP_SERVERS_TO_START)
        await asyncio.gather(
            *[
                self._run_mcp_server_on_node(
                    mcp_server_port,
                    self.compute_node.compute_provider.path_join(
                        MCP_DESTINATION_FOLDER,
                        mcp_server_name,
                    ),
                )
                for mcp_server_port, mcp_server_name in zip(
                    [self._shell_mcp_server_port, self._fs_mcp_server_port],
                    MCP_SERVERS_TO_START,
                )
            ]
        )

    async def _run_mcp_server_on_node(self, mcp_server_port: int, mcp_server_file_path: str):
        if self.compute_node.node_provider_type == ComputeProviderType.LOCAL_MACHINE.value and sys.platform == PLATFORM_WIN32:
            command_str = (
                f"powershell -Command \"$env:FLOWPAD_MCP_TOKEN='{self._mcp_server_token}';"
                + " fastmcp run "
                + f" {mcp_server_file_path}"
                + f" --transport streamable-http --host 0.0.0.0 --port {mcp_server_port}"
            ).strip()
        else:
            command_str = (
                f"FLOWPAD_MCP_TOKEN={self._mcp_server_token}"
                + " fastmcp run "
                + f" {mcp_server_file_path}"
                + f" --transport streamable-http --host 0.0.0.0 --port {mcp_server_port}"
            ).strip()
        cmd = await self.compute_node.run_command(command_str)

        async for line in cmd.stderr_stream():
            if "Application startup complete." in line:
                break

    @property
    def _mcp_server_headers(self):
        assert self._mcp_server_token is not None, "MCP server token is not set"
        return {"Authorization": f"Bearer {self._mcp_server_token}"}

    def shell_mcp_server(self, env: dict[str, str | dict | list] | None = None):
        # Note: shell mcp server is cached so env is not updated. Currently, we don't need to update it.
        env = env or {}
        if self._shell_mcp_server is None:
            shell_mcp_headers = self._mcp_server_headers.copy()

            # Convert env values to JSON strings for HTTP headers
            # Values can be strings, dicts (OAuth tokens), or other types
            # Only serialize dict/list/None, pass strings through as-is
            def serialize_value(v):
                if isinstance(v, (dict, list)) or v is None:
                    return json.dumps(v)
                return str(v)

            shell_mcp_headers.update({f"x-flow-env-{k.lower()}": serialize_value(v) for k, v in env.items()})
            # Create server first, then create process_tool_call callback that references it
            # The callback captures the server reference and will access _client when invoked
            # (after the server is entered and _client is initialized)
            # Use FlowPadMCPServer which has call_tool_with_progress_timeout method
            server = FlowPadMCPServer(
                url=f"{self.compute_node.get_host(self._shell_mcp_server_port)}/mcp",
                headers=shell_mcp_headers,
            )
            # Set the process_tool_call after construction to enable progress streaming
            server.process_tool_call = _create_shell_tool_call_with_progress(server)
            self._shell_mcp_server = server
        return self._shell_mcp_server

    @property
    def fs_mcp_server(self):
        if self._fs_mcp_server is None:
            self._fs_mcp_server = FlowPadMCPServer(
                url=f"{self.compute_node.get_host(self._fs_mcp_server_port)}/mcp", headers=self._mcp_server_headers
            )
        return self._fs_mcp_server

    @property
    def source_control(self):
        if self._source_control is None:
            self._source_control = ComputeSourceControl(compute_node=self.compute_node)
        return self._source_control

    def get_host(self, port: int) -> str:
        return self.compute_node.get_host(port)


def default_mcp_connector() -> MCPConnector:
    return MCPConnector(compute_node=ComputeNode(node_provider_type=default_service_config.default_compute_provider.value))


class MCPConnectorPool:
    def __init__(self, target_pool_size: int):
        self._lock = asyncio.Lock()
        self._pending_connectors: list[MCPConnector] = []
        self._warm_connectors: list[MCPConnector] = []
        if default_service_config.default_compute_provider == ComputeProviderType.LOCAL_MACHINE:
            service_log.info("MCP connector pool is disabled for local machine")
            self._target_pool_size = 0
        else:
            self._target_pool_size = target_pool_size
        self._pending_warmup_tasks: set[asyncio.Task] = set()

    async def get_warm_mcp_connector(self) -> MCPConnector:
        async with self._lock:
            if self._warm_connectors:
                connector = self._warm_connectors.pop()
                logging.info(f"Returning warm MCP connector from pool. Pool size: {len(self._warm_connectors)}")
            else:
                connector = default_mcp_connector()
                logging.info("No warm MCP connectors available, creating new one")
        await self.warmup()
        return connector

    async def _create_and_store_warm_connector(self):
        """Create a warm connector and add it to the pool."""
        try:
            connector = await self._create_warm_connector()
            async with self._lock:
                self._pending_connectors.remove(connector)
                self._warm_connectors.append(connector)
                service_log.debug(f"Added warm connector to pool. Pool size: {len(self._warm_connectors)}")
        except Exception as e:
            service_log.error(f"Failed to create warm connector: {e}")
        finally:
            # Remove this task from pending set
            async with self._lock:
                current_task = asyncio.current_task()
                if current_task is not None:
                    self._pending_warmup_tasks.discard(current_task)

    async def _create_warm_connector(self) -> MCPConnector:
        """Create and initialize a single connector."""
        connector = default_mcp_connector()
        async with self._lock:
            self._pending_connectors.append(connector)
        do_not_warmup_git = ComputeSourceControlInitializeOptions(git_init=False)
        async with connector.initialize(initialize_options=do_not_warmup_git):
            # Just initialize, don't yield
            pass
        return connector

    async def warmup(self):
        """Manually trigger warmup of connectors."""
        async with self._lock:
            current_size = len(self._warm_connectors)
            in_progress = len(self._pending_warmup_tasks)
            total_expected = current_size + in_progress
            needed = max(0, self._target_pool_size - total_expected)

            if needed <= 0:
                return

            service_log.info(f"Manually warming up {needed} MCP connectors")
            # Clean up completed tasks
            completed_tasks = {task for task in self._pending_warmup_tasks if task.done()}
            self._pending_warmup_tasks -= completed_tasks

            # Create new warmup tasks
            for _ in range(needed):
                task = asyncio.create_task(
                    self._create_and_store_warm_connector(),
                    name=f"mcp_create_warm_connector_{len(self._pending_warmup_tasks)}",
                )
                self._pending_warmup_tasks.add(task)

    async def setup(self):
        service_log.info(f"Setting up MCP connector pool. Target size: {self._target_pool_size}")
        await self.warmup()
        service_log.info(f"MCP connector pool setup done. Pool size: {len(self._warm_connectors)}")

    async def cleanup(self):
        async with self._lock:
            for task in self._pending_warmup_tasks:
                task.cancel()
            await asyncio.gather(
                *[connector.compute_node.shutdown() for connector in self._warm_connectors + self._pending_connectors],
                return_exceptions=True,
            )
            self._pending_connectors = []
            self._warm_connectors = []
            self._pending_warmup_tasks = set()


# Global pool instance
mcp_connector_pool = MCPConnectorPool(target_pool_size=default_service_config.mcp_connector_pool_size)
