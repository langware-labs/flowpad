import asyncio
import base64
import json
import logging
import os
import platform
import sys
import uuid
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Literal, overload

from pydantic import Field
from starlette.responses import RedirectResponse, StreamingResponse

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.messages import PtyOutputMessage, PtySessionStatusMessage, ResponseMessage
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.faas.pty_replay_buffer import replay_buffer
from flow_sdk.builtin.faas.pty_session_manager import session_manager
from flow_sdk.compute.providers import ComputeProvider, get_compute_provider
from flow_sdk.compute.providers.compute_provider import ListDirItem
from flow_sdk.config import AGENT_MOUNT_FOLDER, ComputeProviderType, StorageProvider
from flow_sdk.config import ComputeProviderType as ComputeProviderEnum
from flow_sdk.core import action
from flow_sdk.core.entity import Entity
from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType, ViewType
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler
from flow_sdk.core.network.connection import Connection
from flow_sdk.core.network.connection_manager import get_connection_handler
from flow_sdk.core.resource_management.scan.system_profile import (
    get_resource_summary as _get_resource_summary,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    list_projects_fast as _list_projects_fast,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    scan_item as _scan_item,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    scan_project as _scan_project,
)
from flow_sdk.core.resource_management.scan.system_profile import (
    scan_resources as _scan_resources,
)
from flow_sdk.core.resource_management.scan.system_profile.types import SystemProfile
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.compute_types import CLICommand, SendFileEntry
from flow_sdk.flowpad_types.machine_status import MACHINE_STATUS_SCRIPT, MachineStatus, NetworkConnection, ProcessInfo
from flow_sdk.flowpad_types.runtime_environment import ComputeNodeSize, ExecutionEnvironmentStatus, RuntimeEnvironment
from flow_sdk.fs_records.claude.claude_debug_log import clear_debug_errors
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

# PTY sessions are now managed entirely by session_manager

# When active PTY sessions reach this count, the oldest _PTY_EVICT_COUNT are closed automatically.
# Prevents OS PTY device exhaustion (macOS default limit: 511).
_PTY_CAP = 70

# Module-level activity registry: key = "{entity_typeid}:{job_name}"
# Prevents duplicate concurrent scan/index jobs on the same compute node.
_COMPUTE_ACTIVITIES: dict[str, "Any"] = {}
_PTY_EVICT_COUNT = 10


class ComputeNode(Entity):
    _api_visible = True
    type: str = APIField(default=BuiltinEntityType.COMPUTE_NODE.value)
    name: str = APIField(default="")
    runtime: RuntimeEnvironment = APIField(default_factory=RuntimeEnvironment)
    node_provider_type: ComputeProviderType | None = APIField(default=None)
    node_provider_id: str | None = APIField(default=None)
    node_config: dict[str, Any] | None = APIField(default=None)
    node_size: ComputeNodeSize = APIField(default=ComputeNodeSize.SMALL)
    template_version: str | None = APIField(default=None)
    # Track active PTY sessions for WebSocket notifications
    active_pty_sessions: list[str] = APIField(default_factory=list)
    # Override Entity's fs_storage fields with compute node defaults
    fs_storage_provider: StorageProvider | None = Field(default=StorageProvider.SANDBOX)
    fs_storage_mount_path: str | None = APIField(default=None)
    home_dir: str | None = APIField(default=None)

    def _start_activity(self, job_name: str, total: int = 0, timeout_seconds: int = 600):
        """Register a new in-process activity, raising RuntimeError if one is already running."""
        from flow_sdk.builtin.faas.in_process_activity import InProcessActivity  # noqa: PLC0415

        key = f"{self.typeid}:{job_name}"
        existing = _COMPUTE_ACTIVITIES.get(key)
        if existing is not None and not existing.is_timed_out and not existing.is_complete:
            raise RuntimeError(f"Job '{job_name}' already running")
        activity = InProcessActivity(
            job_name=job_name,
            entity_id=str(self.typeid),
            total=total,
            timeout_seconds=timeout_seconds,
        )
        _COMPUTE_ACTIVITIES[key] = activity
        return activity

    def _complete_activity(self, job_name: str) -> None:
        """Remove a completed activity from the registry."""
        _COMPUTE_ACTIVITIES.pop(f"{self.typeid}:{job_name}", None)

    def model_post_init(self, __context: Any) -> None:
        super().model_post_init(__context)
        # Local compute nodes mount the machine root filesystem
        if self.node_provider_type == ComputeProviderType.LOCAL_MACHINE:
            if not self.fs_storage_mount_path:
                self.fs_storage_mount_path = "/"
            if not self.fs_storage_provider or self.fs_storage_provider == StorageProvider.SANDBOX:
                self.fs_storage_provider = StorageProvider.LOCAL
            if not self.home_dir:
                from pathlib import Path as _Path  # noqa: PLC0415

                self.home_dir = str(_Path.home())

    @property
    def compute_provider(self) -> "ComputeProvider":
        if self.node_provider_type is None:
            raise RuntimeError("Compute node provider is not set")
        return get_compute_provider(self.node_provider_type)

    @property
    def provider_type_id_str(self) -> str:
        return f"{self.node_provider_type}:{self.node_provider_id or 'not_set'}"

    def get_host(self, port: int) -> str:
        return self.compute_provider.get_host(self.verified_node_provider_id, port)

    async def setup_node(self, run_startup=True) -> str:
        provider_node_id = await self.compute_provider.create_node(self.name, self.runtime, self.node_size)
        self.node_provider_id = provider_node_id
        # Store template version from provider (if available, e.g., E2B)
        self.template_version = self.compute_provider.get_template_version()
        if run_startup:
            await self.startup(self.node_config)
            # Setup LM proxy access with machine-restricted API key
            try:
                await self.setup_lm_proxy_access()
            except Exception as e:
                logging.debug(f"LM proxy access setup skipped (local mode): {e}")
        return provider_node_id

    @property
    def verified_node_provider_id(self) -> str:
        if self.node_provider_id is None:
            raise RuntimeError("Compute node provider ID is not set")
        return self.node_provider_id

    async def wait_for_ready(self) -> bool:
        return await self.compute_provider.wait_for_ready(self.verified_node_provider_id)

    async def get_node_status(self) -> ExecutionEnvironmentStatus:
        return (
            await self.compute_provider.get_node_status(self.node_provider_id)
            if self.node_provider_id is not None
            else ExecutionEnvironmentStatus.NEW
        )

    async def startup(self, config: dict | None = None):
        return await self.compute_provider.startup(self.verified_node_provider_id, config)

    async def resume(self):
        return await self.compute_provider.resume(self.verified_node_provider_id)

    async def pause(self):
        return await self.compute_provider.pause(self.verified_node_provider_id)

    async def run_command(
        self,
        command: str,
        session_id: str | None = None,
        background: bool = True,
        env: list | None = None,
    ) -> CLICommand:
        return await self.compute_provider.run_command(
            self.verified_node_provider_id, command, session_id, background, env
        )

    async def shutdown(self):
        return await self.compute_provider.shutdown(self.verified_node_provider_id)

    async def exists(self, remote_paths: str | list[str]) -> bool:
        return await self.compute_provider.exists(self.verified_node_provider_id, remote_paths)

    async def write_files(
        self,
        remote_path_or_files: str | list[SendFileEntry],
        data_or_local_path: str | bytes | BytesIO | None = None,
    ) -> list[str]:
        return await self.compute_provider.write_files(
            self.verified_node_provider_id, remote_path_or_files, data_or_local_path
        )

    @overload
    async def read_files(
        self, remote_paths: str | list[str], file_format: Literal["text"] = "text"
    ) -> dict[str, str]: ...

    @overload
    async def read_files(
        self, remote_paths: str | list[str], file_format: Literal["stream"]
    ) -> dict[str, AsyncIterator[bytes]]: ...

    @overload
    async def read_files(
        self, remote_paths: str | list[str], file_format: Literal["text", "stream"]
    ) -> dict[str, str] | dict[str, AsyncIterator[bytes]]: ...

    async def read_files(
        self, remote_paths: str | list[str], file_format: Literal["text", "stream"] = "text"
    ) -> dict[str, str] | dict[str, AsyncIterator[bytes]]:
        return await self.compute_provider.read_files(self.verified_node_provider_id, remote_paths, file_format)

    async def list_dir(self, remote_paths: str | list[str]) -> dict[str, list[ListDirItem]]:
        return await self.compute_provider.list_dir(self.verified_node_provider_id, remote_paths)

    async def create_folders(self, remote_paths: str | list[str]) -> None:
        return await self.compute_provider.create_folders(self.verified_node_provider_id, remote_paths)

    async def delete_files(self, remote_paths: str | list[str]) -> None:
        return await self.compute_provider.delete_files(self.verified_node_provider_id, remote_paths)

    async def set_env(self, name: str, value: str | None) -> None:
        """Set or remove an environment variable on the compute node.

        Sets the environment variable persistently so it's available in future shell sessions.

        Args:
            name: The environment variable name
            value: The value to set, or None to remove the variable
        """
        return await self.compute_provider.set_env(self.verified_node_provider_id, name, value)

    @staticmethod
    def get_os_env_var(name: str) -> str | None:
        """Get environment variable from the OS, reading directly from registry on Windows.

        On Windows, os.environ only contains values that were set when the process started.
        Environment variables set via 'setx' are stored in the registry but not visible to
        running processes until they restart. This function reads directly from the registry
        to get the current values.

        On macOS/Linux, falls back to os.getenv() as there's no system-wide registry.

        Args:
            name: The environment variable name to retrieve

        Returns:
            The value if found, None otherwise
        """
        import os
        import platform

        from flow_sdk.config import PLATFORM_WINDOWS

        system = platform.system().lower()

        if system == PLATFORM_WINDOWS:
            try:
                import winreg

                # Read from user environment variables (HKEY_CURRENT_USER\Environment)
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as key:
                    value, _ = winreg.QueryValueEx(key, name)
                    return value if value else None
            except FileNotFoundError:
                # Key or value doesn't exist in registry
                return None
            except Exception:
                # Other error reading registry
                return None

        # Non-Windows: use os.getenv (no registry on macOS/Linux)
        return os.getenv(name)

    async def get_machine_id(self) -> str:
        """Get the unique machine ID of the compute node.

        Returns a SHA256 hash based on platform, architecture, MAC address, and OS-specific UUID.

        Returns:
            64-character hex string representing the machine ID
        """
        machine_id_script = """
import platform, uuid, hashlib, subprocess
parts = [platform.system(), platform.machine(), hex(uuid.getnode())]
try:
    system = platform.system()
    if system == "Linux":
        parts.append(open("/etc/machine-id").read().strip())
    elif system == "Darwin":
        parts.append(subprocess.check_output(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]).decode().split("IOPlatformUUID")[1].split('"')[1])
    elif system == "Windows":
        parts.append(subprocess.check_output(["wmic", "csproduct", "get", "uuid"], shell=True).decode().splitlines()[1].strip())
except Exception:
    pass
print(hashlib.sha256("|".join(parts).encode()).hexdigest())
"""
        temp_folder = self.compute_provider.get_temp_folder()
        script_path = self.compute_provider.path_join(temp_folder, "_machine_id.py")
        await self.write_files(script_path, machine_id_script)
        python_cmd = sys.executable if self.node_provider_type == ComputeProviderEnum.LOCAL_MACHINE.value else "python"
        cmd = await self.run_command(f"{python_cmd} {script_path}", background=False)
        await cmd.wait()
        if cmd.exit_code != 0:
            raise RuntimeError(f"Failed to get machine ID: {cmd.all_stderr}")
        machine_id = cmd.all_stdout.strip()
        if len(machine_id) != 64:
            raise RuntimeError(f"Invalid machine ID format: {machine_id}")
        return machine_id

    async def get_machine_status(self) -> MachineStatus:
        """Get machine status (processes, network, CPU, memory) from this compute node.

        This is a READ-ONLY operation - it does not attempt to resume paused nodes.
        If the node is in an unrecoverable state, it returns ERROR status quickly.

        Returns:
            MachineStatus object with provider status, processes, network, and resource info.
        """
        import json

        # Get provider status with 10s timeout to detect unrecoverable nodes quickly
        try:
            provider_status = await asyncio.wait_for(
                self.get_node_status(),
                timeout=10.0,
            )
        except asyncio.TimeoutError:
            logging.warning(f"Timeout getting provider status for compute node {self.id}")
            return MachineStatus(
                node_provider_status=ExecutionEnvironmentStatus.ERROR,
                status_msg="Unrecoverable node: status check timed out",
            )
        except Exception as e:
            logging.warning(f"Failed to get provider status: {e}")
            provider_status = ExecutionEnvironmentStatus.ERROR

        # Initialize MachineStatus with provider status
        machine_status = MachineStatus(node_provider_status=provider_status)

        # Get configured node info (CPU, memory, size, template version)
        try:
            node_info = self.compute_provider.get_node_info(self.node_size)
            node_info.template_version = self.template_version
            machine_status.node_info = node_info
        except Exception as e:
            logging.warning(f"Failed to get node info: {e}")

        # READ-ONLY: Only collect detailed status if node is READY
        if provider_status == ExecutionEnvironmentStatus.PAUSED:
            machine_status.status_msg = "Node is paused"
            return machine_status
        elif provider_status == ExecutionEnvironmentStatus.ERROR:
            machine_status.status_msg = "Sandbox expired (invalid end_at date). Please create a new agent."
            return machine_status
        elif provider_status == ExecutionEnvironmentStatus.NOT_FOUND:
            machine_status.status_msg = "Node not found"
            return machine_status
        elif provider_status != ExecutionEnvironmentStatus.READY:
            machine_status.status_msg = f"Node not available (status: {provider_status})"
            return machine_status

        # Node is READY - try to run the status script
        try:
            # Ensure sandbox is connected
            await self.startup()

            # Write the script to the provider's temp folder
            temp_folder = self.compute_provider.get_temp_folder()
            script_path = self.compute_provider.path_join(temp_folder, "_machine_status.py")
            await self.write_files(script_path, MACHINE_STATUS_SCRIPT)

            # Run the script
            cmd = await self.run_command(
                f"python3 {script_path}",
                background=False,
            )

            # Wait for command completion
            await cmd.wait(timeout=3.0)

            if cmd.exit_code != 0:
                error_msg = cmd.all_stderr or "Unknown error"
                machine_status.status_msg = f"Script failed: {error_msg}"
            else:
                # Parse the JSON output
                try:
                    status_data = json.loads(cmd.all_stdout)
                    if "error" in status_data:
                        machine_status.status_msg = status_data["error"]
                    else:
                        machine_status.processes = [ProcessInfo(**p) for p in status_data.get("processes", [])]
                        machine_status.network = [NetworkConnection(**n) for n in status_data.get("network", [])]
                        machine_status.cpu_percent = status_data.get("cpu_percent", 0.0)
                        machine_status.memory_percent = status_data.get("memory_percent", 0.0)
                        machine_status.memory_total_gb = status_data.get("memory_total_gb", 0.0)
                        machine_status.memory_available_gb = status_data.get("memory_available_gb", 0.0)
                except json.JSONDecodeError as e:
                    machine_status.status_msg = f"Failed to parse output: {e}"

        except Exception as e:
            logging.warning(f"Error running machine status script: {e}")
            machine_status.status_msg = str(e)

        return machine_status

    async def setup_lm_proxy_access(self) -> str:
        """Setup LM proxy access for this compute node.

        This method:
        1. Gets the unique machine ID from the compute node
        2. Creates an API key restricted to that machine ID
        3. Stores the API key on the node as FLOWPAD_LM_PROXY_KEY environment variable

        Returns:
            The created API key (for logging/debugging purposes only)
        """
        from flow_sdk.builtin.api_key import ApiKey, generate_api_key

        # Get the machine ID from the compute node
        machine_id = await self.get_machine_id()
        logging.info(f"ComputeNode {self.id}: Machine ID obtained: {machine_id[:16]}...")

        # Generate API key
        full_key, prefix = generate_api_key("live")
        key_hash = ApiKey.hash_key(full_key)

        # Create ApiKey entity targeting this compute node
        api_key = ApiKey(
            name=f"lm_proxy_key_{self.id}",
            api_key_hash=key_hash,
            bind_typeid=str(self.typeid),
            is_active=True,
        )
        api_key.add_machine_id(machine_id)
        await api_key.save()

        # Store the API key on the compute node machine
        await self.set_env("FLOWPAD_LM_PROXY_KEY", full_key)
        # Also store the machine ID so the node can send it with requests
        await self.set_env("FLOWPAD_MACHINE_ID", machine_id)
        # Store the backend URL for API access (use service_external_host to support ngrok/localhost scenarios)
        backend_url = self.current_config.service_urls_config.service_external_host
        await self.set_env("FLOWPAD_BACKEND_URL", backend_url)

        # TODO this is temporarily disabled
        # lm_proxy_path = urls_service.api.build_entity_path(self.typeid, None, "lm-proxy")
        # full_lm_proxy_url = f"{backend_url}{lm_proxy_path}"
        # await self.compute_provider.configure_lm_proxy_env(
        #     self.verified_node_provider_id, full_key, backend_url, full_lm_proxy_url, machine_id
        # )

        logging.info(f"ComputeNode {self.id}: LM proxy access configured with key {prefix}...")
        return full_key

    async def send(self, msg_str: str) -> None:
        return await self.compute_provider.send(self.verified_node_provider_id, msg_str)

    async def _setup_op(self) -> ApiResponse:
        """Setup the compute node."""
        try:
            # Reload the node from DB to ensure all fields are hydrated
            hydrated: ComputeNode = await ComputeNode.get_by_id(self.id)
            if not hydrated:
                return ApiFailResponse(message="Compute node not found in DB.")
            provider_node_id = await hydrated.setup_node()
            await hydrated.save()
            return ApiSuccessResponse(data=provider_node_id)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _startup_op(self) -> ApiResponse:
        """Start the compute node."""
        if not self.node_provider_id:
            provider_node_id = await self.setup_node()
            self.node_provider_id = provider_node_id
            await self.save()
        try:
            if not isinstance(self.node_provider_id, str):
                return ApiFailResponse(message="Failed to setup compute node. No provider node ID returned.")
            result = await self.compute_provider.startup(self.node_provider_id, self.node_config)
            if not result:
                return ApiFailResponse(message="Failed to start compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _shutdown_op(self) -> ApiResponse:
        """Shutdown the compute node."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to shutdown")
        try:
            result = await self.compute_provider.shutdown(self.node_provider_id)
            if not result:
                return ApiFailResponse(message="Failed to shutdown compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _pause_op(self) -> ApiResponse:
        """Pause the compute node immediately (user-initiated pause)."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to pause")
        try:
            # Use immediate=True for user-initiated pause via API
            result = await self.compute_provider.pause(self.node_provider_id, immediate=True)
            if not result:
                return ApiFailResponse(message="Failed to pause compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _setup_lm_proxy_op(self) -> ApiResponse:
        """Setup LM proxy access for the compute node."""
        try:
            # Reload the node from DB to ensure all fields are hydrated
            hydrated: ComputeNode = await ComputeNode.get_by_id(self.id)
            if not hydrated:
                return ApiFailResponse(message="Compute node not found in DB.")
            api_key = await hydrated.setup_lm_proxy_access()
            return ApiSuccessResponse(data={"message": "LM proxy access configured", "key_prefix": api_key[:8] + "..."})
        except Exception as e:
            import traceback

            logging.error(f"_setup_lm_proxy_op error: {e}\n{traceback.format_exc()}")
            return ApiFailResponse(message=str(e))

    async def _resume_op(self) -> ApiResponse:
        """Resume the compute node."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to resume")
        try:
            result = await self.compute_provider.resume(self.node_provider_id)
            if not result:
                return ApiFailResponse(message="Failed to resume compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _get_metrics_op(self) -> ApiResponse:
        """Get metrics for the compute node (E2B only)."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")
        try:
            metrics = await self.compute_provider.get_metrics(self.node_provider_id)
            return ApiSuccessResponse(data=metrics)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _get_logs_op(self) -> ApiResponse:
        """Get logs for the compute node (E2B only)."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")
        try:
            request_info = get_current_request_info()
            limit = 100
            if request_info and request_info.request:
                body = await request_info.get_post_data()
                if isinstance(body, dict):
                    limit = body.get("limit", 100)

            logs = await self.compute_provider.get_logs(self.node_provider_id, limit)
            return ApiSuccessResponse(data=logs)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _command_op(self) -> ApiResponse | StreamingResponse:
        """Execute a command on the compute node."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to execute command on")
        try:
            request_info = get_current_request_info()
            if not request_info or not request_info.request:
                return ApiFailResponse(message="No request info or request object available")

            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid command data (expected JSON object body)")

            command = body.get("command")
            if not command:
                return ApiFailResponse(message="No command provided")

            session_id = body.get("session_id")
            stream = body.get("stream", True)  # Enable streaming by default for real-time output

            # Generate unique group_id for this command execution
            # This is used by FlowStreamProcessor on the frontend to merge streaming FlowData chunks
            # that belong to the same logical group (stdout/stderr/exit-code for this command)
            temp_flow_data = FlowData(flow_value="", attributes={})
            group_id = temp_flow_data.generate_group_id()

            # If streaming requested, use streaming path
            if stream:
                stream_handler = StreamingResponseHandler()
                cmd_task = asyncio.create_task(
                    self._execute_streaming_command(command, session_id, group_id, stream_handler)
                )
                return self._create_command_streaming_response(cmd_task, stream_handler)

            # Non-streaming path (current behavior)
            # Try to execute command, with automatic recovery if sandbox is not found
            # Use background=False for interactive terminal commands to ensure output is captured
            try:
                cmd = await self.compute_provider.run_command(
                    self.node_provider_id, command, session_id, background=False
                )
            except Exception as exec_error:
                error_msg = str(exec_error)
                # Check if sandbox/node was not found or is paused
                if "not found" in error_msg.lower() or "paused" in error_msg.lower():
                    try:
                        # Try to resume the compute node
                        await self.resume()
                        # Retry command execution
                        cmd = await self.compute_provider.run_command(
                            self.node_provider_id, command, session_id, background=False
                        )
                    except Exception as resume_error:
                        return ApiFailResponse(
                            message=f"Compute node unavailable. Please ask the agent to start a new session."
                            f" Error: {str(resume_error)}"
                        )
                else:
                    raise exec_error

            if not cmd:
                return ApiFailResponse(message="Failed to execute command")

            # Wait for command completion with longer timeout for interactive terminals
            is_complete = await cmd.wait(timeout=30.0)
            if not is_complete:
                return ApiFailResponse(message="Command did not complete within timeout")

            # Return result as XML FlowData using new format
            # Build XML response with proper channel chunks
            xml_chunks = []

            # Send stdout chunk with channel attribute if there's stdout
            if cmd.all_stdout:
                stdout_flow_data = FlowData(
                    flow_value=cmd.all_stdout,
                    attributes={
                        "element-type": FlowElementType.SHELL_OUTPUT,
                        "data-type": FlowDataType.TEXT,
                        "group-id": group_id,
                        "channel": "stdout",
                    },
                    focus="shell",
                )
                xml_chunks.append(stdout_flow_data.to_xml)

            # Send stderr chunk with channel attribute if there's stderr
            if cmd.all_stderr:
                stderr_flow_data = FlowData(
                    flow_value=cmd.all_stderr,
                    attributes={
                        "element-type": FlowElementType.SHELL_OUTPUT,
                        "data-type": FlowDataType.TEXT,
                        "group-id": group_id,
                        "channel": "stderr",
                    },
                    focus="shell",
                )
                xml_chunks.append(stderr_flow_data.to_xml)

            # Send group-level final chunk with exit-code (no channel attribute)
            final_flow_data = FlowData(
                flow_value="",  # Empty content - data is in attributes
                attributes={
                    "element-type": FlowElementType.SHELL_OUTPUT,
                    "data-type": FlowDataType.TEXT,
                    "group-id": group_id,
                    "exit-code": str(cmd.exit_code),
                    "stdout": cmd.all_stdout,  # Fallback for clients
                    "stderr": cmd.all_stderr,  # Fallback for clients
                    "final": "true",  # Flag indicating group completion
                },
            )
            xml_chunks.append(final_flow_data.to_xml)

            return ApiSuccessResponse(data="".join(xml_chunks))
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _execute_streaming_command(
        self, command: str, session_id: str | None, group_id: str, callback_handler: StreamingResponseHandler
    ) -> None:
        """Execute command in background and stream output chunks to callback handler."""
        try:
            # Ensure shell focus before streaming output
            await callback_handler.on_focus(ViewType.SHELL)

            # Run command in background mode for streaming
            cmd = await self.compute_provider.run_command(self.node_provider_id, command, session_id, background=True)

            # Stream stdout chunks using FlowData with channel attribute
            async def stream_stdout():
                async for line in cmd.stdout_stream():
                    stdout_flow_data = FlowData(
                        flow_value=line,
                        attributes={
                            "element-type": FlowElementType.SHELL_OUTPUT,
                            "data-type": FlowDataType.TEXT,
                            "group-id": group_id,
                            "channel": "stdout",
                        },
                        focus="shell",
                    )
                    logging.info(f"[STREAM_STDOUT] Sending: {stdout_flow_data.to_xml[:200]}")
                    await callback_handler.on_flow_data(stdout_flow_data)

            # Stream stderr chunks using FlowData with channel attribute
            async def stream_stderr():
                async for line in cmd.stderr_stream():
                    stderr_flow_data = FlowData(
                        flow_value=line,
                        attributes={
                            "element-type": FlowElementType.SHELL_OUTPUT,
                            "data-type": FlowDataType.TEXT,
                            "group-id": group_id,
                            "channel": "stderr",
                        },
                        focus="shell",
                    )
                    logging.info(f"[STREAM_STDERR] Sending: {stderr_flow_data.to_xml[:200]}")
                    await callback_handler.on_flow_data(stderr_flow_data)

            # Run both streams concurrently
            await asyncio.gather(stream_stdout(), stream_stderr())

            # Wait for command completion
            await cmd.wait(timeout=30.0)

            # Send group-level final chunk with exit-code (no channel attribute)
            final_flow_data = FlowData(
                flow_value="",  # Empty content - data is in attributes
                attributes={
                    "element-type": FlowElementType.SHELL_OUTPUT,
                    "data-type": FlowDataType.TEXT,
                    "group-id": group_id,
                    "exit-code": str(cmd.exit_code),
                    "final": "true",  # Flag indicating group completion
                },
            )
            logging.info(f"Sending final FlowData: {final_flow_data.to_xml[:200]}")
            await callback_handler.on_flow_data(final_flow_data)

            logging.info("Sending end-of-stream signal")
            # Signal end of stream
            await callback_handler.on_flow_data(None)

        except Exception as e:
            logging.error(f"Error in _execute_streaming_command: {e}")
            # Send error as flow data
            error_flow_data = FlowData(
                flow_value=str(e),
                attributes={
                    "element-type": FlowElementType.SHELL_OUTPUT,
                    "data-type": FlowDataType.TEXT,
                    "group-id": group_id,
                    "error": "true",
                },
            )
            await callback_handler.on_flow_data(error_flow_data)
            # Signal end of stream even on error
            await callback_handler.on_flow_data(None)

    @staticmethod
    def _create_command_streaming_response(
        cmd_task: asyncio.Task[None],
        stream_handler: StreamingResponseHandler,
    ) -> StreamingResponse:
        """Create streaming response for command execution."""

        async def stream_response():
            counter = 0
            try:
                async for xml_chunk in stream_handler:
                    counter += 1
                    logging.debug(f"Yielding chunk {counter}: {xml_chunk[:100]}")
                    yield xml_chunk
            except Exception as e:
                logging.error(f"Error in stream_response iteration: {e}")

            # Ensure task completes
            if not cmd_task.done():
                logging.info("Waiting for command task to complete...")
                await cmd_task

            logging.info(f"Command task completed, total chunks: {counter}")

        return StreamingResponse(
            stream_response(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    @action.post("terminal-command")
    async def terminal_command(self):
        """Dispatch terminal operations via /terminal-command/<op> API.

        Operations:
        - start: Start a new PTY session
        - attach: Reattach to existing PTY session (with replay)
        - input: Send input to PTY session
        - resize: Resize PTY terminal
        - close: Close PTY session
        - list: List all active PTY sessions for this compute node
        """
        logging.info("[PTY] terminal_command action called")
        request_info = get_current_request_info()
        if not request_info or not request_info.sub_path:
            logging.error("[PTY] No operation specified in sub_path")
            return ApiFailResponse(message="No operation specified")

        op = request_info.sub_path.strip("/").lower()
        logging.info(f"[PTY] Terminal operation: {op}")

        try:
            body = await request_info.get_post_data()
            logging.info(f"[PTY] Request body: {body}")

            if op == "start":
                result = await self._start_pty_session(body)
            elif op == "attach":
                result = await self._attach_pty_session(body)
            elif op == "input":
                result = await self._send_pty_input(body)
            elif op == "resize":
                result = await self._resize_pty(body)
            elif op == "close":
                result = await self._close_pty_session(body)
            elif op == "list":
                result = await self._list_pty_sessions()
            elif op == "rename":
                result = await self._rename_pty_session(body)
            elif op == "ping":
                result = await self._ping_pty_session(body)
            else:
                result = ApiFailResponse(message=f"Unknown terminal operation: {op}")

            logging.info(f"[PTY] Returning result: {result}")
            return result
        except Exception as e:
            logging.error(f"[PTY] Error in terminal_command: {str(e)}", exc_info=True)
            return ApiFailResponse(message=str(e))

    async def _start_pty_session(self, body: dict) -> ApiResponse:
        """Start a new PTY session via REST API.

        This is the REST API handler that validates inputs and delegates to start_machine_pty_session.
        """
        logging.info(f"[PTY] _start_pty_session called with body: {body}")
        request_info = get_current_request_info()

        # Get request_message_id from context or body (for REST API calls)
        request_message_id = None
        if request_info and request_info.request_message_id:
            request_message_id = request_info.request_message_id
        elif body.get("message_id"):
            request_message_id = body.get("message_id")
        else:
            import uuid

            request_message_id = str(uuid.uuid4())

        shell_id = body.get("shell_id")
        name = body.get("name")
        try:
            cols = int(body.get("cols", 80))
        except (TypeError, ValueError):
            cols = 80
        try:
            rows = int(body.get("rows", 24))
        except (TypeError, ValueError):
            rows = 24

        # Validate required fields
        if not self.node_provider_id:
            logging.error("[PTY] No node_provider_id set")
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="Compute node provider ID not set",
            )
            return ApiFailResponse(message="Compute node provider ID not set", data=response_msg.model_dump())

        if not shell_id:
            logging.error("[PTY] Missing shell_id")
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="shell_id required",
            )
            return ApiFailResponse(message="shell_id required", data=response_msg.model_dump())

        # Get connection_id from request context or body
        request_connection_id = None
        if request_info and request_info.request_connection_id:
            request_connection_id = request_info.request_connection_id
        elif body.get("connection_id"):
            request_connection_id = body.get("connection_id")

        if not request_connection_id:
            logging.error("[PTY] No WebSocket connection available")
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="No WebSocket connection available. Provide connection_id in body for REST API calls.",
            )
            return ApiFailResponse(message="No WebSocket connection available", data=response_msg.model_dump())

        working_dir = body.get("working_dir")

        # Delegate to start_machine_pty_session for the actual work
        try:
            success = await self.start_machine_pty_session(
                shell_id=shell_id,
                connection_id=request_connection_id,
                rows=rows,
                cols=cols,
                name=name,
                working_dir=working_dir,
            )
        except Exception as e:
            logging.error(f"[PTY] Failed to create PTY session: {e}", exc_info=True)
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"Failed to create PTY session: {e}",
            )
            return ApiFailResponse(message=f"Failed to create PTY session: {e}", data=response_msg.model_dump())

        if success:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                content=f"[PTY] Session started: shell_id: {shell_id}",
            )
            return ApiSuccessResponse(
                message=f"[PTY] Session started: shell_id: {shell_id}",
                data=response_msg.model_dump(),
            )
        else:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="Failed to create PTY session",
            )
            return ApiFailResponse(message="Failed to create PTY session", data=response_msg.model_dump())

    async def _notify_pty_session_created(self, session_id: str) -> None:
        """Send DataOp notification to all watchers when a new PTY session is created.

        Uses the resource_tracker / watch_registry to find watchers and broadcast
        the DataOp update notification via WebSocket.
        """
        from flow_sdk.api.messages import DataOpMessage, OperationType
        from flow_sdk.core.network.resource_tracker import handle_entity_op

        data_op_msg = DataOpMessage(
            op=OperationType.UPDATE,
            to_entity=self.typeid,
            data=self.model_dump(),
        )

        try:
            await handle_entity_op(data_op_msg)
        except Exception as e:
            logging.warning(f"[PTY] Failed to send DataOp notification: {e}")

    async def start_machine_pty_session(
        self,
        shell_id: str,
        connection_id: str | None = None,
        rows: int = 24,
        cols: int = 80,
        name: str | None = None,
        working_dir: str | None = None,
        on_exit: Callable[[int | None], None] | None = None,
    ) -> bool:
        """Start a PTY session for machine use with proper output routing.

        Unlike directly calling compute_provider.get_or_create_pty_session(), this method:
        1. Sets up proper output routing to WebSocket clients
        2. Registers the session in session_manager
        3. Adds the session to active_pty_sessions
        4. Sends DataOp notifications to all watchers (clients should watch the compute node)

        Args:
            shell_id: Unique shell ID for the PTY session
            connection_id: WebSocket connection ID for output routing (optional, client can attach later)
            rows: Terminal rows (default 24)
            cols: Terminal columns (default 80)
            name: Optional display name for the session
            working_dir: Optional working directory for the PTY session.
            on_exit: Optional callback fired when the PTY process exits (receives exit code).

        Returns:
            True if session was created successfully, False otherwise
        """
        import uuid

        if not self.node_provider_id:
            logging.error("[PTY] No node_provider_id set for machine PTY session")
            return False

        logging.info(f"[PTY] Starting machine PTY session: {shell_id}")

        pty_key = (self.id, self.node_provider_id, shell_id)

        # Check if session already exists
        existing_session = await session_manager.get_session(pty_key)
        if existing_session:
            logging.info(f"[PTY] Machine session already exists: {pty_key}, attaching connection")
            await session_manager.attach_session(pty_key, connection_id)
            return True

        # Evict oldest sessions when the cap is reached, to prevent PTY device exhaustion.
        node_sessions = [k for k in session_manager.sessions if k[0] == self.id]
        if len(node_sessions) >= _PTY_CAP:
            evict_keys = node_sessions[:_PTY_EVICT_COUNT]
            logging.warning(f"[PTY] Cap ({_PTY_CAP}) reached — evicting {len(evict_keys)} oldest sessions")
            for evict_key in evict_keys:
                evict_shell_id = evict_key[2]
                try:
                    from flow_sdk.builtin.shell import Shell as ShellEntity

                    entity = await ShellEntity.get_by_id(evict_shell_id)
                    if entity:
                        entity.status = "closed"
                        await entity.save()
                except Exception:
                    pass
                await session_manager.close_session(evict_key)
                replay_buffer.clear(evict_key)

        # Create output callback that sends data over WebSocket
        main_loop = asyncio.get_event_loop()
        request_message_id = str(uuid.uuid4())

        # Mutable holder for session_state, populated after generate_session()
        session_state_holder: list = []

        def on_pty_output(data: bytes):
            logging.info(f"[PTY] on_pty_output (machine): {len(data)} bytes for session {shell_id}")
            current_pty_key = (self.id, self.node_provider_id, shell_id)

            # Append to replay buffer (returns OutputChunk with seq and timestamp)
            chunk_record = replay_buffer.append(current_pty_key, data)
            seq = chunk_record.seq
            chunk_timestamp = chunk_record.timestamp
            logging.info(f"[PTY] on_pty_output (machine): appended to replay buffer, seq={seq}")

            # Write to PTY stream file for persistence
            if session_state_holder:
                ss = session_state_holder[0]
                if ss.pty_stream_file:
                    ss.pty_stream_file.write(data)

            async def get_and_send():
                current_session = await session_manager.get_session(current_pty_key)
                if current_session and current_session.connection_ids:
                    for current_connection_id in current_session.connection_ids:
                        await self._send_pty_output_to_client(
                            request_message_id,
                            current_connection_id,
                            self.node_provider_id,
                            shell_id,
                            data,
                            seq,
                            chunk_timestamp,
                        )
                    logging.info(
                        f"[PTY] on_pty_output (machine): sent to {len(current_session.connection_ids)} client(s)"
                    )
                elif not current_session:
                    logging.debug(f"[PTY] on_pty_output (machine): session {current_pty_key} not found in manager")

            if not main_loop.is_closed():
                asyncio.run_coroutine_threadsafe(get_and_send(), main_loop)

        # Create PTY via provider with proper output callback
        try:
            provider_session_data = await self.compute_provider.get_or_create_pty_session(
                self.node_provider_id,
                shell_id,
                on_output=on_pty_output,
                rows=rows,
                cols=cols,
                working_dir=working_dir,
                on_exit=on_exit,
            )
            logging.info(f"[PTY] Machine PTY session created: {pty_key}")
        except Exception as e:
            logging.error(f"[PTY] Failed to create machine PTY session: {e}", exc_info=True)
            return False

        # Register session in session_manager
        session_state = await session_manager.generate_session(pty_key, self.id, connection_id, cols, rows)
        session_state.provider_session_data = provider_session_data
        if name:
            session_state.name = name

        # Create or update ShellRecord and wire PtyStreamFile
        try:
            from flow_sdk.builtin.faas.pty_stream_file import PtyStreamFile
            from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus

            existing_record = ShellRecord.discover_one(shell_id)
            if not existing_record:
                record = ShellRecord(
                    id=shell_id,
                    pty_pid=shell_id,
                    workdir=working_dir,
                    name=name,
                    state=ShellStatus.RUNNING,
                )
                record.save()
            else:
                # Recovery case: update process_id and touch
                pid = provider_session_data.get("pid") if isinstance(provider_session_data, dict) else None
                object.__setattr__(existing_record, "process_id", str(pid) if pid is not None else None)
                dirty = object.__getattribute__(existing_record, "_dirty_keys")
                dirty.add("process_id")
                existing_record.touch()
                record = existing_record

            # Create PtyStreamFile at the record's pty_stream_path
            pty_stream_file = PtyStreamFile(path=record.pty_stream_path)
            session_state.pty_stream_file = pty_stream_file

            # Write-through: create/update Shell DB entity
            try:
                from flow_sdk.builtin.shell import Shell

                shell = await Shell.from_record(record, self.typeid)
                if shell and shell.status != ShellStatus.RUNNING.value:
                    shell.status = ShellStatus.RUNNING.value
                    await shell.save()
            except Exception as e_shell:
                logging.warning(f"[PTY] Error creating Shell entity: {e_shell}", exc_info=True)
        except Exception as e:
            logging.warning(f"[PTY] Error creating shell session record: {e}", exc_info=True)

        # Populate the holder so on_pty_output can access session_state
        session_state_holder.append(session_state)

        # Add to active_pty_sessions
        if shell_id not in self.active_pty_sessions:
            self.active_pty_sessions.append(shell_id)

        # Notify all watchers of the new PTY session via DataOp
        # Clients should watch the compute_node to receive these notifications
        await self._notify_pty_session_created(shell_id)
        logging.info(f"[PTY] Machine PTY session fully initialized: {shell_id}")

        return True

    @action.get(action_name="list-shell-sessions")
    async def _list_shell_sessions(self) -> ApiResponse:
        """List active shell session entities (status != closed)."""
        from flow_sdk.builtin.shell import Shell as ShellEntity

        all_sessions = await ShellEntity.get_all()

        # Detect zombie sessions: status=running but no pty_pid means PTY never started or died
        for s in all_sessions:
            if s.status == "running" and not s.pty_pid:
                s.status = "error"
                s.error_message = "PTY session not found"
                await s.save()

        active = [s for s in all_sessions if s.status not in ("closed", "error")]
        result = [s.model_dump(mode="json") for s in active]

        # Enrich with agentic_process_id from AgenticProcess
        try:
            from flow_sdk.builtin.agentic_processor import AgenticProcess

            all_procs = await AgenticProcess.get_all()
            pty_to_proc = {p.pty_pid: p.id for p in all_procs if p.pty_pid}
            if pty_to_proc:
                for r in result:
                    proc_id = pty_to_proc.get(r.get("pty_pid"))
                    if proc_id:
                        r["agentic_process_id"] = proc_id
        except Exception as e:
            logging.debug(f"Failed to enrich shell sessions with process IDs: {e}")

        return ApiSuccessResponse(data=result)

    @action.get(action_name="session-transcript")
    async def _session_transcript(self) -> ApiResponse:
        """Return transcript entries for a Claude session.

        Query params:
          - session_id (required): The Claude session UUID
          - project (optional): Absolute project path for O(1) lookup
        """
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

        request_info = get_current_request_info()
        session_id = request_info.request.query_params.get("session_id")
        if not session_id:
            return ApiFailResponse(message="session_id query parameter required")

        project = request_info.request.query_params.get("project")
        kwargs = {}
        if project:
            kwargs["project"] = project

        record = ClaudeSessionRecord.discover_one(session_id, **kwargs)
        if not record:
            return ApiSuccessResponse(data=[])

        return ApiSuccessResponse(data=record.to_transcript_dicts())

    @action.get(action_name="discovery")
    async def _discovery_action(self) -> ApiResponse:
        """Run discovery on a record type and return the result.

        URL: GET /api/v1/graph/compute_node/@local/discovery/<record_type>
        Query params:
          - uuid (optional): Specific record UUID to discover
          - project (optional): Project path for O(1) lookup (used by ClaudeSessionRecord)
        """
        import asyncio

        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info available")

        record_type = (request_info.sub_path or "").strip("/").lower()
        if not record_type:
            return ApiFailResponse(message="Record type required in URL path (e.g. /discovery/claude_session)")

        # Resolve Record class from the global type registry (supports all registered types)
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        cls = _SR.get_record_cls(record_type)
        if cls is None:
            # Lazy-import well-known record types that aren't loaded at startup.
            # Importing the module triggers __init_subclass__ → SchemaRegistry registration.
            if record_type == "claude_session":
                from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord  # noqa: PLC0415

                cls = ClaudeSessionRecord
            else:
                return ApiFailResponse(message=f"Unknown record type: {record_type!r}")

        uuid = request_info.request.query_params.get("uuid") if request_info.request else None
        project = request_info.request.query_params.get("project") if request_info.request else None
        kwargs = {}
        if project:
            kwargs["project"] = project

        loop = asyncio.get_event_loop()

        try:
            if uuid:
                record = await loop.run_in_executor(None, lambda: cls.discover_one(uuid, **kwargs))
                if not record:
                    # Return 200 with null data — the session file may not exist yet
                    # during normal startup (race condition), so this is not an error.
                    return ApiSuccessResponse(data=None)
                await loop.run_in_executor(None, lambda: record.discovery(force=True))
                return ApiSuccessResponse(data=record.meta_dict())
            else:
                records = await loop.run_in_executor(None, lambda: cls.discover())
                for rec in records:
                    await loop.run_in_executor(None, lambda r=rec: r.discovery(force=True))
                return ApiSuccessResponse(data=[r.meta_dict() for r in records])
        except Exception as exc:
            logging.warning("discovery action error for %r uuid=%r: %s", record_type, uuid, exc)
            return ApiSuccessResponse(data=None)

    @action.post(action_name="reset-pty")
    async def reset_pty(self) -> ApiResponse:
        """Clear all in-memory PTY state for this compute node (mimics server restart).

        Wipes:
        - session_manager sessions for this node
        - replay_buffer entries for this node
        - compute_provider._pty_sessions for this node
        - active_pty_sessions list on this entity

        Shell entities in the DB retain their status; _open_shell will detect
        the dead PTY via is_pty_alive() and reset them on the next resume().
        """
        node_keys = [k for k in session_manager.sessions if k[0] == self.id]
        for key in node_keys:
            replay_buffer.clear(key)
            del session_manager.sessions[key]

        if self.node_provider_id:
            provider_keys = [k for k in self.compute_provider._pty_sessions if k[0] == self.node_provider_id]
            for key in provider_keys:
                del self.compute_provider._pty_sessions[key]

        self.active_pty_sessions.clear()

        logging.info(
            "[reset_pty] Cleared %d session(s) for compute node %s",
            len(node_keys),
            self.id,
        )
        return ApiSuccessResponse(data={"cleared": len(node_keys)})

    @action.post(action_name="update-shell-session")
    async def _update_shell_session(self) -> ApiResponse:
        """Update a shell session record's display properties.

        Accepts shell_id (required) and optional fields: tab_order (int),
        name (str). Updates the record on disk and returns
        the updated record data.
        """
        from flow_sdk.fs_records.shell_record import ShellRecord

        request_info = get_current_request_info()
        body = await request_info.get_post_data()
        shell_id = body.get("shell_id")
        if not shell_id:
            return ApiFailResponse(message="shell_id is required")

        record = ShellRecord.discover_one(shell_id)
        if not record:
            return ApiFailResponse(message="Shell session not found")

        if "tab_order" in body:
            object.__setattr__(record, "tab_order", body["tab_order"])
            dirty = object.__getattribute__(record, "_dirty_keys")
            dirty.add("tab_order")
        if "name" in body:
            object.__setattr__(record, "name", body["name"])
            dirty = object.__getattribute__(record, "_dirty_keys")
            dirty.add("name")
        record.save()

        # Write-through: update Shell DB entity
        try:
            from flow_sdk.builtin.shell import Shell

            shell_entity = await Shell.get_one({"id": shell_id})
            if shell_entity:
                shell_entity.sync_from_record(record)
                await shell_entity.save()
        except Exception as e:
            logging.warning(f"[PTY] Failed to update Shell entity: {e}")

        return ApiSuccessResponse(data=record.meta_dict())

    @action.post(action_name="elevate-shell-session")
    async def _elevate_shell_session(self) -> ApiResponse:
        """Elevate a running shell session to a Claude CLI session.

        This is the shell-session-based elevation path. It differs from the
        existing `elevate-pty` action which promotes a PTY into an AgenticProcess.
        This action instead:
        1. Generates a claude_session_id
        2. Updates the ShellRecord to ELEVATED status
        3. Sends a `claude` CLI command to the PTY's stdin

        POST body:
            shell_id: str - The shell session to elevate
            model: str | None - Claude model to use
            permission_mode: str - "bypassPermissions" (default) or other
            resume_session_id: str | None - Session to resume instead of starting new
        """
        from uuid import uuid4

        from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        body = await request_info.get_post_data()
        shell_id = body.get("shell_id")
        if not shell_id:
            return ApiFailResponse(message="shell_id is required")

        record = ShellRecord.discover_one(shell_id)
        if not record:
            return ApiFailResponse(message="Shell session not found")

        if record.status != ShellStatus.RUNNING:
            return ApiFailResponse(message=f"Shell session is not running (status: {record.status})")

        # Generate claude session ID and elevate the record
        claude_session_id = str(uuid4())
        record.elevate(claude_session_id)

        # Build claude CLI command
        model = body.get("model")
        permission_mode = body.get("permission_mode", "bypassPermissions")
        resume_session_id = body.get("resume_session_id")

        parts = ["claude", f"--session-id {claude_session_id}"]
        if model:
            parts.append(f"--model {model}")
        if permission_mode == "bypassPermissions":
            parts.append("--dangerously-skip-permissions")
        if resume_session_id:
            parts.append(f"--resume {resume_session_id}")
        command = " ".join(parts) + "\n"

        # Send command to PTY
        try:
            pty_key = (self.id, self.node_provider_id, shell_id)
            pty_session = await session_manager.get_session(pty_key)
            cols = pty_session.cols if pty_session else 80
            rows = pty_session.rows if pty_session else 24

            await self.compute_provider.send_pty_input(self.node_provider_id, shell_id, command.encode(), cols, rows)
        except Exception as e:
            logging.warning(f"[PTY] Error sending claude command to PTY: {e}")
            return ApiFailResponse(message=f"Failed to send command to PTY: {e}")

        return ApiSuccessResponse(
            data={
                "shell_id": shell_id,
                "claude_session_id": claude_session_id,
                "status": "elevated",
            }
        )

    async def _attach_pty_session(self, body: dict) -> ApiResponse:
        """Reattach to existing PTY session with output replay."""
        logging.info(f"[PTY] _attach_pty_session called with body: {body}")
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")

        request_message_id = request_info.request_message_id
        shell_id = body.get("shell_id")
        since_seq = body.get("since_seq")

        if not self.node_provider_id or not shell_id:
            logging.error("[PTY] Missing required parameters")
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="Missing required parameters (node_provider_id or shell_id)",
            )
            return ApiFailResponse(message="Missing required parameters", data=response_msg.model_dump())

        # Get connection_id from request context
        if not request_info.request_connection_id:
            logging.error("[PTY] No WebSocket connection available")
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="No WebSocket connection available",
            )
            return ApiFailResponse(message="No WebSocket connection available", data=response_msg.model_dump())

        request_connection_id = request_info.request_connection_id
        logging.info(f"[PTY] Attaching with connection_id: {request_connection_id}")

        pty_key = (self.id, self.node_provider_id, shell_id)

        # Get or check session from manager (authorization via existing middleware)
        session = await session_manager.get_session(pty_key)
        if not session:
            # Session not found or expired (expected after server restart)
            logging.debug(f"[PTY] Session {pty_key} not found")
            status_msg = PtySessionStatusMessage(
                shell_id=shell_id,
                status="not_found",
            )
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                content=status_msg,  # Pass instance, not dict
            )
            return ApiSuccessResponse(data=response_msg.model_dump())

        # Snapshot the replay buffer BEFORE attaching the connection.
        # Once attached, live PTY output starts flowing to this connection via
        # on_pty_output.  Taking the snapshot first avoids a race where live
        # output (with high seq) arrives at the client before the replay (low
        # seq), which would cause the client's dedup to reject the replay.
        replay_chunks = []
        if since_seq is not None:
            logging.info(f"[PTY] Snapshotting replay buffer from seq {since_seq}, pty_key={pty_key}")
            buffer_stats = replay_buffer.get_buffer_stats()
            logging.info(f"[PTY] Global buffer stats: {buffer_stats}")
            latest_seq = replay_buffer.get_latest_seq(pty_key)
            logging.info(f"[PTY] Latest seq for key {pty_key}: {latest_seq}")
            replay_chunks = replay_buffer.get_replay(pty_key, since_seq)
            logging.info(f"[PTY] Snapshotted {len(replay_chunks)} chunks for key {pty_key}")

        # Attach to session (updates connection_id — live output starts flowing)
        try:
            await session_manager.attach_session(pty_key, request_connection_id)
            logging.info(f"[PTY] Attached to session {pty_key} with connection_id {request_connection_id}")

        except Exception as e:
            logging.error(f"[PTY] Failed to attach to session: {e}", exc_info=True)
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"Failed to attach to session: {e}",
            )
            return ApiFailResponse(message=f"Failed to attach to session: {e}", data=response_msg.model_dump())

        # Send replay chunks (snapshot was taken before attach to avoid races)
        if replay_chunks:
            handler = get_connection_handler(TypeId(type=Connection.get_type(), id=request_connection_id))
            if handler:
                for i, chunk in enumerate(replay_chunks):
                    pty_msg = PtyOutputMessage(
                        provider_node_id=self.node_provider_id,
                        shell_id=shell_id,
                        data=base64.b64encode(chunk.data).decode("utf-8"),
                        seq=chunk.seq,
                        timestamp_ms=int(chunk.timestamp * 1000),
                    )
                    # Send replay chunk over WebSocket with UNIQUE message_id
                    # This prevents collision with the attach request's pending response
                    replay_msg_id = str(uuid.uuid4())
                    try:
                        logging.info(f"[PTY] Sending replay chunk {i + 1}/{len(replay_chunks)}, seq={chunk.seq}")
                        await handler.send_message(
                            ResponseMessage(
                                session_id=shell_id,
                                message_id=replay_msg_id,
                                response_message_id=replay_msg_id,  # Use unique ID, not request_message_id
                                content=pty_msg,
                            ).model_dump()
                        )
                    except Exception as e:
                        logging.warn(f"[PTY] Failed to send replay chunk {i + 1}: {e}")

        # Send status message
        latest_seq = replay_buffer.get_latest_seq(pty_key)
        status_msg = PtySessionStatusMessage(
            shell_id=shell_id,
            status="reattached",
            latest_seq=latest_seq,
        )

        logging.info(f"[PTY] Session {pty_key} reattached successfully")
        response_msg = ResponseMessage(
            session_id=shell_id,
            message_id=request_message_id,
            response_message_id=request_message_id,
            content=status_msg,  # Pass instance, not dict
        )
        return ApiSuccessResponse(
            message=f"[PTY] Session reattached: shell_id: {shell_id}",
            data=response_msg.model_dump(),
        )

    @staticmethod
    async def _send_pty_output_to_client(
        request_message_id, request_connection_id, provider_node_id, shell_id, data, seq, timestamp: float = 0.0
    ):
        """Send PTY output to a single WebSocket client (no buffer append).

        Args:
            request_message_id: Message ID for the response
            request_connection_id: WebSocket connection ID to send to
            provider_node_id: Provider node ID
            shell_id: PTY shell ID
            data: Raw PTY output bytes
            seq: Sequence number (already assigned by replay buffer)
            timestamp: Unix timestamp (seconds) when chunk was captured
        """
        handler = get_connection_handler(TypeId(type=Connection.get_type(), id=request_connection_id))
        if handler:
            try:
                pty_msg = PtyOutputMessage.from_bytes(provider_node_id, shell_id, data, seq=seq, timestamp=timestamp)
                response_msg = ResponseMessage(
                    session_id=shell_id,
                    message_id=request_message_id,
                    response_message_id=request_message_id,
                    content=pty_msg,
                )
                logging.info(f"[PTY] Sending PTY output to client: seq={seq}, size={len(data)} bytes")
                await handler.send_message(response_msg.model_dump())
            except Exception as e:
                logging.warning(f"Failed to send PTY output to client: {e}")
                response_msg = ResponseMessage(
                    session_id=shell_id,
                    message_id=request_message_id,
                    response_message_id=request_message_id,
                    error=f"Failed to send PTY output: {e}",
                )
                return ApiFailResponse(message=f"Failed to send PTY output: {str(e)}", data=response_msg.model_dump())

    async def _send_pty_input(self, body: dict) -> ApiResponse:
        """Send input to PTY session."""
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")
        request_message_id = request_info.request_message_id

        shell_id = body.get("shell_id")
        data = body.get("data", "")
        try:
            rows = int(body.get("rows", 24))
        except (TypeError, ValueError):
            rows = 24
        try:
            cols = int(body.get("cols", 80))
        except (TypeError, ValueError):
            cols = 80

        if not self.node_provider_id:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="Compute node provider ID not set",
            )
            return ApiFailResponse(message="Compute node provider ID not set", data=response_msg.model_dump())

        if not shell_id:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="shell_id required",
            )
            return ApiFailResponse(message="shell_id required", data=response_msg.model_dump())

        pty_key = (self.id, self.node_provider_id, shell_id)

        session = await session_manager.get_session(pty_key)
        if not session:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"PTY session not found: {shell_id}",
            )
            return ApiFailResponse(message=f"PTY session not found: {shell_id}", data=response_msg.model_dump())

        try:
            # Convert string to bytes
            data_bytes = data.encode("utf-8")
            await self.compute_provider.send_pty_input(self.node_provider_id, shell_id, data_bytes, cols, rows)
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                content="[PTY] Input sent",
            )
            return ApiSuccessResponse(data=response_msg.model_dump())
        except Exception as e:
            logging.error(f"Failed to send PTY input: {e}")
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"Failed to send PTY input: {e}",
            )
            return ApiFailResponse(message=f"Failed to send PTY input: {str(e)}", data=response_msg.model_dump())

    async def _resize_pty(self, body: dict) -> ApiResponse:
        """Resize PTY terminal."""
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")
        request_message_id = request_info.request_message_id

        shell_id = body.get("shell_id")
        try:
            cols = int(body.get("cols", 24))
        except (TypeError, ValueError):
            cols = 80
        try:
            rows = int(body.get("rows", 24))
        except (TypeError, ValueError):
            rows = 24

        if not self.node_provider_id:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="Compute node provider ID not set",
            )
            return ApiFailResponse(message="Compute node provider ID not set", data=response_msg.model_dump())

        if not shell_id or cols is None or rows is None:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="shell_id, cols, and rows required",
            )
            return ApiFailResponse(message="shell_id, cols, and rows required", data=response_msg.model_dump())

        pty_key = (self.id, self.node_provider_id, shell_id)

        session = await session_manager.get_session(pty_key)
        if not session:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"PTY session not found: {shell_id}",
            )
            return ApiFailResponse(message=f"PTY session not found: {shell_id}", data=response_msg.model_dump())

        # Skip resize if dimensions haven't changed — avoids unnecessary SIGWINCH
        # which causes zsh to redraw and produce duplicate content / '%' artifacts on reattach
        if session.cols == cols and session.rows == rows:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                content="[PTY] Size unchanged, skipped",
            )
            return ApiSuccessResponse(data=response_msg.model_dump())

        try:
            await self.compute_provider.resize_pty(self.node_provider_id, shell_id, cols, rows)
            session.cols = cols
            session.rows = rows
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                content="[PTY] Resized",
            )
            return ApiSuccessResponse(data=response_msg.model_dump())
        except Exception as e:
            logging.error(f"Failed to resize PTY: {e}")
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"Failed to resize PTY: {e}",
            )
            return ApiFailResponse(message=f"Failed to resize PTY: {str(e)}", data=response_msg.model_dump())

    async def _close_pty_session(self, body: dict) -> ApiResponse:
        """Close PTY session. Works over both WebSocket and plain HTTP."""
        request_info = get_current_request_info()
        # request_message_id is only present in WebSocket context; None is fine for HTTP callers
        request_message_id = request_info.request_message_id if request_info else None

        shell_id = body.get("shell_id")

        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")

        if not shell_id:
            return ApiFailResponse(message="shell_id required")

        pty_key = (self.id, self.node_provider_id, shell_id)

        # Close via Shell entity first, fallback to direct record manipulation
        try:
            from flow_sdk.builtin.shell import Shell as ShellEntity

            entity = await ShellEntity.get_by_id(shell_id)
            if entity:
                entity.status = "closed"
                await entity.save()
        except Exception:
            pass  # Entity may not exist yet

        # Also update disk record directly (covers migration period)
        try:
            from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus

            record = ShellRecord.discover_one(shell_id)
            if record:
                object.__setattr__(record, "state", ShellStatus.CLOSED)
                dirty = object.__getattribute__(record, "_dirty_keys")
                dirty.add("state")
                record.save()
        except Exception as e:
            logging.warning(f"[PTY] Failed to update ShellRecord on close: {e}")

        # Write-through: update Shell DB entity status to CLOSED
        try:
            from flow_sdk.builtin.shell import Shell

            shell_entity = await Shell.get_one({"id": shell_id})
            if shell_entity:
                await shell_entity.close()
        except Exception as e:
            logging.warning(f"[PTY] Failed to update Shell entity on close: {e}")

        session = await session_manager.get_session(pty_key)
        if not session:
            # Idempotent — record already marked closed above
            if request_message_id:
                return ApiSuccessResponse(
                    data=ResponseMessage(
                        session_id=shell_id,
                        message_id=request_message_id,
                        response_message_id=request_message_id,
                        content="[PTY] Session not found (idempotent)",
                    ).model_dump()
                )
            return ApiSuccessResponse(data={"shell_id": shell_id, "status": "closed"})

        try:
            # Use close_for_connection: only destroy the session if no other
            # connections remain.  This prevents one browser tab's close from
            # killing the PTY for all other tabs.
            connection_id = request_info.request_connection_id if request_info else None
            await session_manager.close_for_connection(pty_key, connection_id)

            # Only clear replay buffer if session was fully destroyed
            remaining = await session_manager.get_session(pty_key)
            if not remaining:
                replay_buffer.clear(pty_key)

            logging.info(f"[PTY] Session close requested: {pty_key}, destroyed={remaining is None}")
            if request_message_id:
                return ApiSuccessResponse(
                    data=ResponseMessage(
                        session_id=shell_id,
                        message_id=request_message_id,
                        response_message_id=request_message_id,
                        content="[PTY] Session closed",
                    ).model_dump()
                )
            return ApiSuccessResponse(data={"shell_id": shell_id, "status": "closed"})
        except Exception as e:
            logging.error(f"Failed to close PTY: {e}")
            if request_message_id:
                return ApiFailResponse(
                    message=f"Failed to close PTY: {str(e)}",
                    data=ResponseMessage(
                        session_id=shell_id,
                        message_id=request_message_id,
                        response_message_id=request_message_id,
                        error=f"Failed to close PTY: {e}",
                    ).model_dump(),
                )
            return ApiFailResponse(message=f"Failed to close PTY: {str(e)}")

    async def _list_pty_sessions(self) -> ApiResponse:
        """List all active PTY sessions for this compute node."""
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")
        request_message_id = request_info.request_message_id

        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")

        # Find all sessions for this compute node
        active_sessions = []
        for (compute_node_id, node_provider_id, shell_id), session_state in session_manager.sessions.items():
            if compute_node_id == self.id and node_provider_id == self.node_provider_id:
                active_sessions.append(
                    {
                        "shell_id": shell_id,
                        "connection_id": session_state.connection_id,
                        "compute_node_id": compute_node_id,
                        "name": session_state.name or shell_id,  # Use stored name or fallback to shell_id
                    }
                )

        # Enrich sessions with agentic_process_id when an AgenticProcess owns the PTY
        if active_sessions:
            from flow_sdk.builtin.agentic_processor import AgenticProcess

            try:
                all_procs = await AgenticProcess.get_all()
                pty_to_proc = {p.pty_pid: p.id for p in all_procs if p.pty_pid}
                for s in active_sessions:
                    proc_id = pty_to_proc.get(s["shell_id"])
                    if proc_id:
                        s["agentic_process_id"] = proc_id
            except Exception as e:
                logging.warning(f"[PTY] Failed to enrich sessions with agentic_process_id: {e}")

        logging.info(f"[PTY] Found {len(active_sessions)} active sessions for compute node {self.node_provider_id}")

        # Return sessions directly without ResponseMessage wrapping to avoid content field conversion issues
        response_msg = ResponseMessage(
            message_id=request_message_id,
            response_message_id=request_message_id,
            content={"sessions": active_sessions},
        )
        return ApiSuccessResponse(data=response_msg.model_dump())

    async def _rename_pty_session(self, body: dict) -> ApiResponse:
        """Update the display name of an active PTY session."""
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")
        request_message_id = request_info.request_message_id

        shell_id = body.get("shell_id")
        name = body.get("name")
        if not self.node_provider_id or not shell_id or not name:
            return ApiFailResponse(message="Missing shell_id or name")

        pty_key = (self.id, self.node_provider_id, shell_id)
        session_state = await session_manager.get_session(pty_key)
        if not session_state:
            return ApiFailResponse(message=f"Session not found: {shell_id}")

        session_state.name = name
        response_msg = ResponseMessage(
            message_id=request_message_id,
            response_message_id=request_message_id,
            content={"shell_id": shell_id, "name": name},
        )
        return ApiSuccessResponse(data=response_msg.model_dump())

    async def _ping_pty_session(self, body: dict) -> ApiResponse:
        """Check whether a PTY session's process is still alive (cross-platform)."""
        shell_id = body.get("shell_id")
        if not shell_id or not self.node_provider_id:
            return ApiFailResponse(message="shell_id required")
        alive = self.compute_provider.is_pty_alive(self.node_provider_id, shell_id)
        return ApiSuccessResponse(data={"alive": alive})

    @action.post("ops")
    async def ops(self):
        """Dispatch compute operations via /ops/<op> API. sub_path is the operation (startup, shutdown, etc.)."""
        request_info = get_current_request_info()
        if not request_info or not request_info.sub_path:
            return ApiFailResponse(message="No operation specified")

        op = request_info.sub_path.strip("/").lower()
        try:
            if op == "setup":
                return await self._setup_op()
            elif op == "startup":
                return await self._startup_op()
            elif op == "shutdown":
                return await self._shutdown_op()
            elif op == "pause":
                return await self._pause_op()
            elif op == "resume":
                return await self._resume_op()
            elif op == "command":
                return await self._command_op()
            elif op == "setup-lm-proxy":
                return await self._setup_lm_proxy_op()
            elif op == "metrics":
                return await self._get_metrics_op()
            elif op == "logs":
                return await self._get_logs_op()
            else:
                return ApiFailResponse(message=f"Unknown operation: {op}")
        except Exception as e:
            return ApiFailResponse(message=str(e))

    @action.all(action_name="get-host")
    def get_host_action(self, port: int, redirect: bool = True):
        """Get the host URL for a given port on this compute node.

        Args:
            port: The port number (must be between 1024 and 65535)
            redirect: If True, returns a redirect response. If False, returns JSON with URL.

        Returns:
            RedirectResponse or ApiResponse with host URL
        """
        int_port = int(port)
        if not 1024 <= int_port <= 65535:
            return ApiFailResponse(message="Invalid port")

        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")

        host = self.get_host(int_port)

        if not redirect:
            return ApiResponse(data={"url": host, "port": int_port})

        return RedirectResponse(url=host)

    @action.all(action_name="get-machine-status")
    async def get_machine_status_action(self) -> ApiResponse:
        """Get machine status (processes, network, CPU, memory) from this compute node.

        This is a READ-ONLY operation - it does not attempt to resume paused nodes.
        If the node is in an unrecoverable state, it returns ERROR status quickly.

        Returns:
            ApiResponse with MachineStatus data
        """
        if not self.node_provider_id:
            machine_status = MachineStatus(
                node_provider_status=ExecutionEnvironmentStatus.NOT_FOUND,
                status_msg="Compute node provider ID not set",
            )
            return ApiSuccessResponse(data=machine_status.model_dump())

        machine_status = await self.get_machine_status()
        return ApiSuccessResponse(data=machine_status.model_dump())

    @action.all(action_name="get-system-profile")
    async def get_system_profile_action(self) -> ApiResponse:
        """Get system profile (Claude Code environment info) from this compute node.

        Returns a simplified local system profile with platform info.
        Production runs a full system_profile script on the compute node;
        the local desktop version returns basic platform data directly.

        Returns:
            ApiResponse with SystemProfile data
        """
        from datetime import datetime

        try:
            profile = SystemProfile(
                generated=datetime.now().isoformat(),
                machine=platform.node(),
            )
            return ApiSuccessResponse(data=profile.model_dump())
        except Exception as e:
            logging.exception(f"ComputeNode {self.id} get-system-profile error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="open-external")
    async def open_external_action(self) -> ApiResponse:
        """Open a file or directory in the system's default application.

        This is useful for opening files like settings.json, CLAUDE.md, or commands
        in the user's preferred editor directly from the FlowPad UI.

        POST body:
            path: Absolute path to the file or directory to open

        Returns:
            ApiResponse with success status
        """
        import subprocess

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            path = body.get("path")
            if not path:
                return ApiFailResponse(message="path field is required")

            raw_path = str(path).strip()
            if not raw_path:
                return ApiFailResponse(message="path field is required")

            # Accept both absolute OS paths and relative desktop paths.
            # Relative paths are resolved against workspace/root fallbacks so
            # callers can pass project names like "my_first_project".
            expanded_path = os.path.expanduser(raw_path)
            if os.path.isabs(expanded_path):
                candidate_paths = [expanded_path]
            else:
                relative_path = expanded_path.lstrip("/\\")
                candidate_paths = [
                    os.path.join(AGENT_MOUNT_FOLDER, relative_path),
                    os.path.join(os.sep, relative_path),
                    os.path.abspath(expanded_path),
                ]

            seen = set()
            resolved_path = None
            for candidate in candidate_paths:
                normalized_candidate = os.path.normpath(candidate)
                if normalized_candidate in seen:
                    continue
                seen.add(normalized_candidate)
                if os.path.exists(normalized_candidate):
                    resolved_path = normalized_candidate
                    break

            if not resolved_path:
                return ApiFailResponse(message=f"Path does not exist: {raw_path}")

            # Open with system default application
            system = platform.system()
            if system == "Darwin":  # macOS
                subprocess.Popen(["open", resolved_path])
            elif system == "Windows":
                os.startfile(resolved_path)  # type: ignore
            else:  # Linux and other Unix-like
                subprocess.Popen(["xdg-open", resolved_path])

            return ApiSuccessResponse(data={"opened": resolved_path})

        except Exception as e:
            logging.exception(f"Failed to open external file: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="open-terminal")
    async def open_terminal_action(self) -> ApiResponse:
        """Open an OS terminal and run a command, optionally in a specific directory.

        POST body:
            command: The command to execute in the terminal
            cwd: Optional working directory to open the terminal in

        Returns:
            ApiResponse with success status
        """
        import subprocess

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            command = body.get("command")
            if not command:
                return ApiFailResponse(message="command field is required")

            cwd = body.get("cwd")
            system = platform.system()

            if system == "Darwin":
                # On macOS, open a new Terminal tab and run the command.
                # Escape double-quotes and backslashes for embedding in AppleScript strings.
                def _escape_applescript(s: str) -> str:
                    return s.replace("\\", "\\\\").replace('"', '\\"')

                escaped_command = _escape_applescript(command)
                if cwd:
                    escaped_cwd = _escape_applescript(cwd)
                    shell_cmd = f'cd \\"{escaped_cwd}\\" && {escaped_command}'
                else:
                    shell_cmd = escaped_command

                apple_script = f'tell application "Terminal"\n  activate\n  do script "{shell_cmd}"\nend tell'
                subprocess.Popen(["osascript", "-e", apple_script])
            elif system == "Windows":
                args = ["cmd", "/c", "start", "cmd", "/k", command]
                subprocess.Popen(args, cwd=cwd)
            else:
                # Linux - try common terminal emulators
                for term in ["gnome-terminal", "xterm", "konsole"]:
                    import shutil

                    if shutil.which(term):
                        if term == "gnome-terminal":
                            subprocess.Popen([term, "--", "bash", "-c", command], cwd=cwd)
                        else:
                            subprocess.Popen([term, "-e", command], cwd=cwd)
                        break
                else:
                    return ApiFailResponse(message="No supported terminal emulator found")

            return ApiSuccessResponse(data={"command": command, "cwd": cwd})

        except Exception as e:
            logging.exception(f"Failed to open terminal: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="pick-folder")
    async def pick_folder_action(self) -> ApiResponse:
        """Open a native OS folder-picker dialog and return the selected path.

        Returns:
            ApiSuccessResponse with {"path": "/selected/path"} or {"path": null} if cancelled.
        """
        try:
            selected_path = await self.compute_provider.pick_folder(self.verified_node_provider_id)
            return ApiSuccessResponse(data={"path": selected_path})
        except Exception as e:
            logging.exception(f"Failed to open folder picker: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="get-json-file")
    async def get_json_file_action(self) -> ApiResponse:
        """Read a JSON file and return its parsed contents.

        Query params:
            path: Absolute path to the JSON file

        Returns:
            ApiResponse with parsed JSON data
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        path = request_info.get_param("path")
        if not path:
            return ApiFailResponse(message="path parameter is required")

        try:
            # Read the file
            file_contents = await self.read_files(path)
            if path not in file_contents:
                return ApiFailResponse(message=f"File not found: {path}")

            content = file_contents[path]
            if not content:
                return ApiFailResponse(message=f"File is empty: {path}")

            # Parse JSON
            data = json.loads(content)
            return ApiSuccessResponse(data=data)

        except json.JSONDecodeError as e:
            return ApiFailResponse(message=f"Invalid JSON in file: {e}")
        except Exception as e:
            logging.exception(f"ComputeNode {self.id} get-json-file error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="save-json-file")
    async def save_json_file_action(self) -> ApiResponse:
        """Write JSON data to a file.

        POST body:
            path: Absolute path to the JSON file
            data: JSON data to write

        Returns:
            ApiResponse with success/failure status
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            path = body.get("path")
            if not path:
                return ApiFailResponse(message="path field is required")

            data = body.get("data")
            if data is None:
                return ApiFailResponse(message="data field is required")

            # Serialize JSON with pretty formatting
            json_content = json.dumps(data, indent=2)

            # Write the file
            await self.write_files(path, json_content)

            return ApiSuccessResponse(data={"message": f"File saved: {path}"})

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} save-json-file error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="generate-amd-plan")
    async def generate_amd_plan_action(self) -> ApiResponse:
        """Generate an AMD execution plan from user content.

        This is a stub implementation for the desktop version.
        The production version uses AgenticProcessor with planner skills.

        POST body:
            content: The content to create a plan for

        Returns:
            ApiResponse with stub message
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            content = body.get("content")
            if not content:
                return ApiFailResponse(message="content field is required")

            return ApiFailResponse(
                message="AMD plan generation is not available in desktop mode. Use AgenticProcessor for task execution."
            )

        except Exception as e:
            logging.exception(f"Failed to generate AMD plan: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="scan-resources")
    async def scan_resources_action(self) -> ApiResponse:
        """Scan specific resource type with optional time window filtering.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty results since system_profile scripts
        are not available in desktop mode.

        Query params:
            type: Resource type (hook, mcp_server, session, etc.)
            time_start: ISO timestamp for window start
            time_end: ISO timestamp for window end
            parent_id: Parent resource ID for child resources
            limit: Max items (default 100)
            offset: Pagination offset (default 0)

        Returns:
            ApiResponse with items, scanned_window, total_count, has_more, resource_type
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        resource_type = request_info.get_param("type")
        if not resource_type:
            return ApiFailResponse(message="type parameter is required")

        limit_str = request_info.get_param("limit")
        offset_str = request_info.get_param("offset")
        limit = int(limit_str) if limit_str else 100
        offset = int(offset_str) if offset_str else 0

        time_start = request_info.get_param("time_start")
        time_end = request_info.get_param("time_end")
        parent_id = request_info.get_param("parent_id")
        time_window = None
        if time_start or time_end:
            time_window = {"start": time_start, "end": time_end}

        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: _scan_resources(
                    resource_type=resource_type,
                    time_window=time_window,
                    parent_id=parent_id,
                    limit=limit,
                    offset=offset,
                ),
            )
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"scan-resources failed: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="get-resource-summary")
    async def get_resource_summary_action(self) -> ApiResponse:
        """Get quick counts per resource type without full scan.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty summary.

        Returns:
            ApiResponse with dict mapping resource_type -> count
        """
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, _get_resource_summary)
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"get-resource-summary failed: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="scan-item")
    async def scan_item_action(self) -> ApiResponse:
        """Scan a specific item type (costOverview, sessions, projects, etc).

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty result.

        Query params:
            type: Item type to scan (e.g., costOverview, sessions, projects)
            limit: Max sessions to analyze (default 100)

        Returns:
            ApiResponse with the scanned item data
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        item_type = request_info.get_param("type")
        if not item_type:
            return ApiFailResponse(message="type parameter is required")

        limit_str = request_info.get_param("limit")
        limit = int(limit_str) if limit_str else 100
        session_id = request_info.get_param("session_id") or None

        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None, lambda: _scan_item(item_type=item_type, limit=limit, session_id=session_id)
            )
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"scan-item failed: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="clear-skill-usage")
    async def clear_skill_usage_action(self) -> ApiResponse:
        """Clear all skill usage counters from ~/.claude.json."""
        try:
            from flow_sdk.core.resource_management.scan.system_profile.settings import clear_skill_usage

            cleared = clear_skill_usage()
            return ApiSuccessResponse(data={"cleared": cleared})
        except Exception as e:
            logging.exception(f"clear-skill-usage failed: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="clear-cli-log")
    async def clear_cli_log_action(self) -> ApiResponse:
        """Clear all CLI invocation log entries."""
        try:
            from flow_sdk.cli.cli_log import clear_log

            count = clear_log()
            return ApiSuccessResponse(data={"cleared": count})
        except Exception as e:
            logging.exception(f"clear-cli-log failed: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="list-projects")
    async def list_projects_action(self) -> ApiResponse:
        """Fast project enumeration.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty project list.

        Returns:
            ApiResponse with projects list and total_count
        """
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, _list_projects_fast)
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"list-projects failed: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="scan-project")
    async def scan_project_action(self) -> ApiResponse:
        """Scan all resources for a specific project.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        Desktop stub: returns empty project scan result.

        Query params:
            project: Project encoded name (required)
            limit: Max sessions (default 100)

        Returns:
            ApiResponse with project scan data
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        project = request_info.get_param("project")
        if not project:
            return ApiFailResponse(message="project parameter is required")

        limit_str = request_info.get_param("limit")
        limit = int(limit_str) if limit_str else 100
        sessions_str = request_info.get_param("sessions")
        include_sessions = sessions_str != "false"

        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: _scan_project(
                    project_encoded_name=project,
                    session_limit=limit,
                    include_sessions=include_sessions,
                ),
            )
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"scan-project failed: {e}")
            return ApiFailResponse(message=str(e))

    @action.all(action_name="createAgenticProcessor")
    async def create_agentic_processor(self) -> ApiResponse:
        """Create an AgenticProcessor bound to this ComputeNode.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        The processor's compute_node_id is set internally and not exposed to frontend.

        Returns:
            AgenticProcessor entity data
        """
        from flow_sdk.builtin.agentic_processor import AgenticProcessor

        try:
            processor = AgenticProcessor()
            # In production, compute_node_id is set on the processor entity.
            # Desktop mode: we don't have that field on the simplified entity,
            # so we just create and save.

            request_info = get_current_request_info()
            await processor.save(owner=request_info.someone_typeid if request_info else None)

            logging.info(f"ComputeNode {self.id} created AgenticProcessor {processor.id}")

            return ApiSuccessResponse(
                data={
                    "id": processor.id,
                    "type": processor.type,
                    "state": processor.state,
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} createAgenticProcessor error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="upsertSessionProcess")
    async def upsert_session_process(self) -> ApiResponse:
        """Find or create an AgenticProcess for a given Claude Code session ID.

        Ported from FlowPad: flowpad/hub/builtin/faas/compute_node.py
        If a process with matching worker_session_id exists, return it.
        Otherwise, create a new AgenticProcessor + AgenticProcess with
        worker_session_id pre-set.

        POST body (camelCase):
            sessionId: str - Claude Code session ID
            workdir: str | None - Working directory
            projectId: str | None - Project ID for context

        Returns:
            AgenticProcess data with { id, type, processor_id, worker_session_id, created }
        """
        from flow_sdk.builtin.agentic_processor import AgenticProcess, AgenticProcessor
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            session_id = body.get("sessionId")
            if not session_id:
                return ApiFailResponse(message="sessionId is required")

            workdir = body.get("workdir")
            project_id = body.get("projectId")

            # Try to find existing process by worker_session_id
            existing = await AgenticProcess.get_all(
                entities_filter=QueryFilter(match=ExpressionNode(worker_session_id=session_id))
            )
            if existing:
                process = existing[0]
                return ApiSuccessResponse(
                    data={
                        "id": process.id,
                        "type": process.type,
                        "processor_id": process.processor_id,
                        "worker_session_id": process.worker_session_id,
                        "created": False,
                    }
                )

            # Resolve workdir + project + project_encoded_name from ClaudeSessionRecord
            project_encoded_name = None
            try:
                from flow_sdk.builtin.project import Project
                from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

                session_rec = ClaudeSessionRecord.discover_one(session_id)
                if session_rec:
                    if session_rec.cwd and not workdir:
                        workdir = session_rec.cwd
                    project_encoded_name = getattr(session_rec, "project_encoded_name", None)
                if workdir and not project_id:
                    projects = await Project.get_all()
                    best, best_len = None, 0
                    for p in projects:
                        mp = getattr(p, "fs_storage_mount_path", None)
                        if mp and workdir.startswith(str(mp)) and len(mp) > best_len:
                            best, best_len = p, len(mp)
                    if best:
                        project_id = best.id
            except Exception:
                pass

            # Create new processor + process
            processor = AgenticProcessor()
            owner = request_info.someone_typeid if request_info else None
            await processor.save(owner=owner)

            context_data = {"compute_node_id": f"{self.type}-{self.id}"}
            if workdir:
                context_data["workdir"] = workdir
            if project_id:
                context_data["project_id"] = project_id

            process = AgenticProcess(
                processor_id=processor.id,
                worker_session_id=session_id,
                use_worker_history=True,
                context_data=context_data,
                compute_node_id=str(self.typeid),
                project_id=project_id or None,
                project_encoded_name=project_encoded_name or None,
            )
            await process.save(owner=owner)

            logging.info(
                f"ComputeNode {self.id} upserted AgenticProcess {process.id} for session {session_id} (created). "
                f"worker_session_id on saved object={process.worker_session_id}"
            )

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": processor.id,
                    "worker_session_id": session_id,
                    "created": True,
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} upsertSessionProcess error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="elevate-pty")
    async def elevate_pty(self) -> ApiResponse:
        """Elevate a pure PTY session into an AgenticProcess.

        Called when a user starts claude manually in a terminal and hooks/MCP
        detect FLOWPAD_PTY_SESSION_ID, or when the frontend wants to promote
        a raw shell session into a tracked process.

        POST body:
            pty_pid: str - The PTY session ID to elevate
            claude_session_id: str | None - Claude --session-id (if known)

        Returns:
            {agentic_process_id, pty_pid, worker_session_id}
        """
        from flow_sdk.builtin.agentic_processor import AgenticProcess, AgenticProcessor
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            pty_pid = body.get("pty_pid")
            if not pty_pid:
                return ApiFailResponse(message="pty_pid is required")

            claude_session_id = body.get("claude_session_id")

            # Verify the PTY session exists
            if pty_pid not in self.active_pty_sessions:
                return ApiFailResponse(message=f"PTY session {pty_pid} not found on this compute node")

            # Check if an AgenticProcess already has this pty_pid
            existing = await AgenticProcess.get_all(entities_filter=QueryFilter(match=ExpressionNode(pty_pid=pty_pid)))
            if existing:
                proc = existing[0]
                return ApiSuccessResponse(
                    data={
                        "agentic_process_id": proc.id,
                        "pty_pid": proc.pty_pid,
                        "worker_session_id": proc.worker_session_id,
                        "created": False,
                    }
                )

            # Create new processor + process linked to this PTY
            processor = AgenticProcessor()
            owner = request_info.someone_typeid if request_info else None
            await processor.save(owner=owner)

            process = AgenticProcess(
                processor_id=processor.id,
                pty_pid=pty_pid,
                worker_session_id=claude_session_id,
                compute_node_id=str(self.typeid),
                context_data={"compute_node_id": f"{self.type}-{self.id}"},
            )
            from flow_sdk.builtin.agentic_processor import ProcessorStatus

            process._set_process_state(status=ProcessorStatus.RUNNING.value)
            await process.save(owner=owner)

            logging.info(f"ComputeNode {self.id} elevated PTY {pty_pid} into AgenticProcess {process.id}")

            return ApiSuccessResponse(
                data={
                    "agentic_process_id": process.id,
                    "pty_pid": pty_pid,
                    "worker_session_id": claude_session_id,
                    "created": True,
                }
            )

        except Exception as e:
            logging.exception(f"ComputeNode {self.id} elevate-pty error: {e}")
            return ApiFailResponse(message=str(e))

    # -- fs-records search helper ------------------------------------------------

    async def _handle_fs_records_search(self, request_info) -> ApiResponse:
        from flow_sdk.core.entity.entity_model import Entity

        qp = request_info.request.query_params
        q = qp.get("q", "").strip()
        limit = max(1, int(qp.get("limit", 20)))
        record_type = qp.get("record_type", "") or None
        status = qp.get("status", "") or None

        if not q:
            # Filter-only browse: list all records of the given type via RecordList
            if record_type:
                import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
                from flow_sdk.fs_store.record_list import RecordList
                from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

                record_cls = _SR.get_record_cls(record_type)
                if record_cls is None:
                    return ApiSuccessResponse(data={"results": [], "query": "", "total": 0, "indexer_ready": True})

                records = list(RecordList(record_class=record_cls))
                results = []
                for rec in records[:limit]:
                    rec_status = getattr(rec, "status", None) or ""
                    if status and rec_status != status:
                        continue
                    results.append(
                        {
                            "record_id": rec.id or "",
                            "record_type": record_type,
                            "name": getattr(rec, "name", None) or getattr(rec, "title", "") or "",
                            "text": "",
                            "status": rec_status,
                            "scope": "",
                            "created_at": "",
                            "modified_at": "",
                            "source_path": rec.source_file or (rec.asset_ref.path if rec.asset_ref else "") or "",
                        }
                    )
                return ApiSuccessResponse(
                    data={"results": results, "query": "", "total": len(results), "indexer_ready": True}
                )
            return ApiSuccessResponse(data={"results": [], "query": q, "total": 0, "indexer_ready": True})

        # Parse optional calibration params
        from flow_sdk.db.drivers.sqlite.sqlite_driver import SearchCalibration

        col_weights_raw = qp.get("col_weights")
        recency_boost_raw = qp.get("recency_boost")
        type_scores_raw = qp.get("type_scores")
        cal = None
        if col_weights_raw or recency_boost_raw or type_scores_raw:
            cal = SearchCalibration(
                col_weights=[float(x) for x in col_weights_raw.split(",")] if col_weights_raw else None,
                recency_boost=float(recency_boost_raw) if recency_boost_raw else None,
                type_scores=json.loads(type_scores_raw) if type_scores_raw else None,
            )

        # FTS5 search
        entities = await Entity.search(query=q, limit=limit, record_type=record_type, calibration=cal)
        results = []
        for ent in entities:
            ent_status = getattr(ent, "status", None) or ""
            if status and ent_status != status:
                continue
            results.append(
                {
                    "record_id": ent.id,
                    "record_type": ent.type or ent.get_type(),
                    "name": getattr(ent, "name", None) or getattr(ent, "title", "") or "",
                    "snippet": getattr(ent, "_fts_snippet", None),
                    "fts_title": getattr(ent, "_fts_title", None),
                    "fts_description": getattr(ent, "_fts_description", None),
                    "status": ent_status,
                    "scope": "",
                    "created_at": str(getattr(ent, "created_date", "") or ""),
                    "modified_at": str(getattr(ent, "updated_date", "") or ""),
                    "source_path": getattr(ent, "source_file", "")
                    or (ent.asset_ref.path if getattr(ent, "asset_ref", None) else "")
                    or "",
                }
            )
        return ApiSuccessResponse(data={"results": results, "query": q, "total": len(results), "indexer_ready": True})

    async def _handle_fs_records_scan(self, request_info) -> ApiResponse:
        """Scan fs_records for stats.

        GET /fs-records/scan           → aggregate stats for all registered types
        GET /fs-records/scan?type=X    → per-type stats + record list

        Both paths broadcast ``progress_report`` FlowData events:
        - sub_activity_name=<type>  → per-record progress within that type
        - sub_activity_name=None    → job-level progress (types completed / total)
        """
        import time

        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        limit_types_raw = qp.get("limit_types", "").strip()
        limit_types = int(limit_types_raw) if limit_types_raw.isdigit() else None
        trigger = qp.get("trigger", "auto").strip() or "auto"

        # Sync claude_error records from debug logs before scanning.
        from flow_sdk.fs_records.claude.claude_error import sync_from_debug_logs  # noqa: PLC0415
        from flow_sdk.fs_store.record import get_default_records_root  # noqa: PLC0415

        await asyncio.to_thread(sync_from_debug_logs, get_default_records_root() / "claude_error")

        if filter_type:
            record_cls = _SR.get_record_cls(filter_type)
            if record_cls is None:
                return ApiFailResponse(
                    message=f"Unknown record type '{filter_type}'. Available: {_SR.get_all_record_types()}",
                    status_code=400,
                )
            try:
                activity = self._start_activity("scan", total=1, timeout_seconds=60)
            except RuntimeError as e:
                return ApiFailResponse(message=str(e), status_code=409)

            try:
                activity.sub_activity_name = filter_type
                sr = await asyncio.to_thread(SchemaRecord._scan_type, record_cls, True)
                # Emit sub-activity completion event
                activity.sub_done = sr.count
                activity.sub_total = sr.count
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(filter_type),
                )
                # Emit job-level completion event
                activity.done = 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
            finally:
                self._complete_activity("scan")

            last_scan_at = SchemaRecord.append_scan(
                trigger=trigger,
                duration_ms=sr.scan_ms,
                total_records=sr.count,
                total_bytes=sr.total_bytes,
                types=[],
                type_name=filter_type,
            )
            return ApiSuccessResponse(
                data={
                    "type": filter_type,
                    "count": sr.count,
                    "total_bytes": sr.total_bytes,
                    "avg_bytes": sr.avg_bytes,
                    "scan_ms": sr.scan_ms,
                    "records": sr.records,
                    "min_bytes": sr.min_bytes,
                    "max_bytes": sr.max_bytes,
                    "last_scan_at": last_scan_at,
                }
            )

        # Aggregate scan across indexed-by-default types only
        all_types = list(_SR.get_default_index_types())
        if limit_types is not None:
            all_types = all_types[:limit_types]

        valid_types = [(tn, _SR.get_record_cls(tn)) for tn in all_types]
        valid_types = [(tn, cls) for tn, cls in valid_types if cls is not None]

        try:
            activity = self._start_activity("scan", total=len(valid_types), timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        t_grand = time.perf_counter()
        type_results = []
        grand_total = 0
        grand_bytes = 0

        try:
            for i, (type_name, record_cls) in enumerate(valid_types):
                activity.sub_activity_name = type_name
                activity.sub_done = 0
                activity.sub_skipped = 0
                activity.sub_errors = 0
                activity.sub_total = 0

                last_progress = None
                total_bytes_for_type = 0
                t0_type = time.perf_counter()

                async for progress in SchemaRecord.scan_type_progress(record_cls):
                    last_progress = progress
                    total_bytes_for_type += progress.size_bytes
                    activity.sub_done = progress.done
                    activity.sub_total = progress.total
                    await broadcast_progress(
                        to_entity=str(self.typeid),
                        flow_data=activity.make_flow_data(type_name),
                    )

                count = last_progress.done if last_progress else 0
                scan_ms_type = round((time.perf_counter() - t0_type) * 1000, 1)
                type_results.append(
                    {
                        "type": type_name,
                        "count": count,
                        "total_bytes": total_bytes_for_type,
                        "avg_bytes": total_bytes_for_type // count if count else 0,
                        "scan_ms": scan_ms_type,
                    }
                )
                grand_total += count
                grand_bytes += total_bytes_for_type

                # Job-level event after each type completes
                activity.done = i + 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
        finally:
            self._complete_activity("scan")

        scan_ms = round((time.perf_counter() - t_grand) * 1000, 1)
        SchemaRecord.append_scan(
            trigger=trigger,
            duration_ms=scan_ms,
            total_records=grand_total,
            total_bytes=grand_bytes,
            types=type_results,
        )
        return ApiSuccessResponse(
            data={
                "types": type_results,
                "grand_total": grand_total,
                "scan_ms": scan_ms,
            }
        )

    async def _handle_fs_records_index_status(self, request_info) -> ApiResponse:
        """Return index freshness info.

        GET /fs-records/index-status
        """
        from dataclasses import asdict  # noqa: PLC0415

        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415

        status = SchemaRecord.get_index_status()
        return ApiSuccessResponse(
            data={
                "never_indexed": status.never_indexed,
                "last_indexed_at": status.last_indexed_at,
                "stale": status.stale,
                "default_types": status.default_types,
                "per_type": [asdict(t) for t in status.per_type],
            }
        )

    async def _handle_fs_records_index_clear(self, request_info) -> ApiResponse:
        """Clear all FTS index data and reset index logs.

        DELETE /fs-records/index
        """
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        types = [filter_type] if filter_type else None
        result = await SchemaRecord.clear_index(types)
        return ApiSuccessResponse(
            data={
                "fts_cleared": result.fts_cleared,
                "entities_cleared": result.entities_cleared,
            }
        )

    async def _handle_fs_records_index(self, request_info) -> ApiResponse:
        """Index fs_records into the Entity DB via Record.sync_to_db().

        POST /fs-records/index                       → index all registered types
        POST /fs-records/index?type=X                → index one type
        POST /fs-records/index?rebuild=true          → clear + re-index
        POST /fs-records/index?limit_per_type=N      → limit records per type
        POST /fs-records/index?limit_types=N         → limit number of types to index

        Broadcasts ``progress_report`` FlowData events during indexing:
        - sub_activity_name=<type>  → per-record progress within that type
        - sub_activity_name=None    → job-level progress (types indexed / total)
        """
        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        trigger = qp.get("trigger", "manual").strip() or "manual"
        rebuild = qp.get("rebuild", "").strip().lower() in ("true", "1")
        limit_per_type_raw = qp.get("limit_per_type", "").strip()
        limit_per_type = int(limit_per_type_raw) if limit_per_type_raw.isdigit() else None
        limit_types_raw = qp.get("limit_types", "").strip()
        limit_types = int(limit_types_raw) if limit_types_raw.isdigit() else None

        if rebuild:
            types = [filter_type] if filter_type else None
            clear_result, index_results = await SchemaRecord.rebuild_index(types=types, trigger=trigger)
            return ApiSuccessResponse(
                data={
                    "cleared": clear_result.fts_cleared,
                    "indexed": sum(r.indexed for r in index_results),
                    "errors": sum(r.errors for r in index_results),
                    "types": [{"type": r.type_name, "indexed": r.indexed, "errors": r.errors} for r in index_results],
                }
            )

        if filter_type:
            record_cls = _SR.get_record_cls(filter_type)
            if record_cls is None:
                return ApiFailResponse(
                    message=f"Unknown record type '{filter_type}'",
                    status_code=400,
                )
            try:
                activity = self._start_activity("index", total=1, timeout_seconds=60)
            except RuntimeError as e:
                return ApiFailResponse(message=str(e), status_code=409)

            try:
                activity.sub_activity_name = filter_type
                last_progress = None
                async for progress in SchemaRecord.index_type_progress(record_cls, limit=limit_per_type):
                    last_progress = progress
                    activity.sub_done = progress.done
                    activity.sub_total = progress.total
                    activity.sub_skipped = progress.skipped
                    activity.sub_errors = progress.errors
                    await broadcast_progress(
                        to_entity=str(self.typeid),
                        flow_data=activity.make_flow_data(filter_type),
                    )
                activity.done = 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
            finally:
                self._complete_activity("index")

            indexed = last_progress.indexed if last_progress else 0
            errors = last_progress.errors if last_progress else 0
            _SR.append_index(
                trigger=trigger,
                duration_ms=0.0,
                total_indexed=indexed,
                types=[],
                type_name=filter_type,
            )
            return ApiSuccessResponse(data={"type": filter_type, "indexed": indexed, "errors": errors})

        # No type, no rebuild: additive index across indexed-by-default types only
        all_types = list(_SR.get_default_index_types())
        if limit_types is not None:
            all_types = all_types[:limit_types]

        valid_types = [(tn, _SR.get_record_cls(tn)) for tn in all_types]
        valid_types = [(tn, cls) for tn, cls in valid_types if cls is not None]

        try:
            activity = self._start_activity("index", total=len(valid_types), timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        total_indexed = 0
        results = []

        try:
            for i, (type_name, record_cls) in enumerate(valid_types):
                activity.sub_activity_name = type_name
                activity.sub_done = 0
                activity.sub_skipped = 0
                activity.sub_errors = 0
                activity.sub_total = 0

                last_progress = None
                async for progress in SchemaRecord.index_type_progress(record_cls, limit=limit_per_type):
                    last_progress = progress
                    activity.sub_done = progress.done
                    activity.sub_total = progress.total
                    activity.sub_skipped = progress.skipped
                    activity.sub_errors = progress.errors
                    await broadcast_progress(
                        to_entity=str(self.typeid),
                        flow_data=activity.make_flow_data(type_name),
                    )

                if last_progress is not None:
                    total_indexed += last_progress.indexed
                    results.append(
                        {
                            "type": type_name,
                            "indexed": last_progress.indexed,
                            "errors": last_progress.errors,
                        }
                    )

                # Job-level event after each type completes
                activity.done = i + 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
        finally:
            self._complete_activity("index")

        _SR.append_index(
            trigger=trigger,
            duration_ms=0.0,
            total_indexed=total_indexed,
            types=results,
        )
        return ApiSuccessResponse(data={"indexed": total_indexed, "types": results})

    # -- shell session record actions --------------------------------------------

    @action.post(action_name="elevate-shell-session")
    async def _elevate_shell_session(self) -> ApiResponse:
        """Elevate a running shell session to a Claude session.

        This is distinct from the ``elevate-pty`` action which creates an
        AgenticProcess from a raw PTY. This action:

        1. Validates the shell session record exists and has status RUNNING
        2. Generates a ``claude_session_id`` and transitions the record to ELEVATED
        3. Builds a ``claude`` CLI command and sends it to the PTY via send_pty_input

        POST body:
            shell_id: str            - The shell session to elevate
            model: str | None        - Optional Claude model to use
            permission_mode: str     - "bypassPermissions" (default) or other
            resume_session_id: str   - Optional Claude session ID to resume
        """
        from uuid import uuid4

        from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus

        request_info = get_current_request_info()
        body = await request_info.get_post_data()

        shell_id = body.get("shell_id")
        if not shell_id:
            return ApiFailResponse(message="shell_id is required")

        record = ShellRecord.discover_one(shell_id)
        if not record:
            return ApiFailResponse(message="Shell session not found")

        if record.status != ShellStatus.RUNNING:
            return ApiFailResponse(message=f"Shell session is not running (status: {record.status})")

        # Generate claude session ID and elevate the record
        claude_session_id = str(uuid4())
        record.elevate(claude_session_id)

        # Build claude CLI command
        cmd_parts = ["claude", f"--session-id {claude_session_id}"]

        model = body.get("model")
        if model:
            cmd_parts.append(f"--model {model}")

        permission_mode = body.get("permission_mode", "bypassPermissions")
        if permission_mode == "bypassPermissions":
            cmd_parts.append("--dangerously-skip-permissions")

        resume_session_id = body.get("resume_session_id")
        if resume_session_id:
            cmd_parts.append(f"--resume {resume_session_id}")

        command = " ".join(cmd_parts) + "\n"

        # Get PTY session state for cols/rows
        pty_key = (self.id, self.node_provider_id, shell_id)
        session_state = await session_manager.get_session(pty_key)
        cols = session_state.cols if session_state else 80
        rows = session_state.rows if session_state else 24

        # Send command to PTY
        await self.compute_provider.send_pty_input(self.node_provider_id, shell_id, command.encode(), cols, rows)

        return ApiSuccessResponse(
            data={
                "shell_id": shell_id,
                "claude_session_id": claude_session_id,
                "status": "elevated",
            }
        )

    # -- fs-records CRUD action --------------------------------------------------

    @action.all(action_name="fs-records", methods=["get", "post", "put", "delete"])
    async def fs_records_action(self) -> ApiResponse:
        """CRUD gateway for filesystem-backed typed records.

        Uses ``RecordList`` for all record types — delegates discovery to
        ``record_class.discover()`` and persistence to ``record.persist()``.

        Routing (via sub_path):
            GET    /fs-records                   → list registered types
            GET    /fs-records/{type}             → list records of type
            GET    /fs-records/{type}/{uid}       → get one record
            POST   /fs-records/{type}             → create record
            PUT    /fs-records/{type}/{uid}       → update record
            DELETE /fs-records/{type}/{uid}       → delete record
        """
        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.fs_store.exceptions import ReadOnlyRecordError  # noqa: PLC0415
        from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        segments = [s for s in (request_info.sub_path or "").strip("/").split("/") if s]
        method = request_info.method  # lowercase string

        # Path-based source file API: /fs-records/file?path=...
        if segments and segments[0] == "file":
            return await self._handle_path_based_source_file(method, request_info)

        # Semantic search: GET /fs-records/search?q=...
        if segments and segments[0] == "search" and method == "get":
            return await self._handle_fs_records_search(request_info)

        # Scan stats: GET /fs-records/scan or /fs-records/scan?type=X
        if segments and segments[0] == "scan" and method == "get":
            return await self._handle_fs_records_scan(request_info)

        # Index: POST /fs-records/index or /fs-records/index?type=X
        if segments and segments[0] == "index" and method == "post":
            return await self._handle_fs_records_index(request_info)

        # Index status: GET /fs-records/index-status
        if segments and segments[0] == "index-status" and method == "get":
            return await self._handle_fs_records_index_status(request_info)

        # Clear index: DELETE /fs-records/index
        if segments and segments[0] == "index" and method == "delete":
            return await self._handle_fs_records_index_clear(request_info)

        # No type segment + GET → list registered type names
        if not segments and method == "get":
            return ApiSuccessResponse(data={"types": _SR.get_all_record_types()})

        if not segments:
            return ApiFailResponse(message="Record type is required in URL path", status_code=400)

        record_type = segments[0]
        uid = segments[1] if len(segments) > 1 else None

        record_cls = _SR.get_record_cls(record_type)
        if record_cls is None:
            return ApiFailResponse(
                message=f"Unknown record type '{record_type}'. Available types: {_SR.get_all_record_types()}",
                status_code=400,
            )

        record_list = RecordList(record_class=record_cls)

        # For write operations, check read-only status via a probe instance.
        # from_dict() bypasses __init__ (which sets _asset_ref), so we must
        # probe with a proper constructor call to get accurate read-only state.
        if method in ("post", "put", "delete"):
            from flow_sdk.fs_store.exceptions import ReadOnlyRecordError

            try:
                probe = record_cls()
                if probe._is_read_only():
                    return ApiFailResponse(
                        message=f"Record type '{record_type}' is read-only",
                        status_code=403,
                    )
            except Exception:
                pass  # if probe fails, fall through and let the real call raise

        try:
            if method == "get":
                # Parse query params into RecordQuery
                qp = request_info.request.query_params
                query = self._parse_record_query(qp)
                include_set = {s.strip() for s in qp.get("include", "").split(",") if s.strip()}

                if uid:
                    rec = await asyncio.to_thread(record_list.get, uid)
                    if rec is None:
                        return ApiFailResponse(message=f"Record '{uid}' not found", status_code=404)
                    item = rec.meta_dict()
                    if include_set:
                        self._embed_includes(item, rec, include_set)
                    return ApiSuccessResponse(data=item)

                if query is not None:
                    results = await asyncio.to_thread(record_list.query, query)
                else:
                    results = await asyncio.to_thread(list, record_list)

                data_list = [r.meta_dict() for r in results]
                if include_set:
                    cache: dict = {}
                    for item, rec in zip(data_list, results):
                        self._embed_includes(item, rec, include_set, cache)
                return ApiSuccessResponse(data=data_list)

            if method == "post":
                body = await request_info.get_post_data()
                if not isinstance(body, dict):
                    return ApiFailResponse(message="Invalid request body (expected JSON object)")
                try:
                    rec = await asyncio.to_thread(record_list.create, body)
                except ValueError as e:
                    return ApiFailResponse(message=str(e), status_code=409)
                try:
                    await rec.sync_to_db()
                except Exception as e:
                    logging.debug(f"[fs-records] sync_to_db skipped on create: {e}")
                await self._broadcast_fs_record_op("create", record_type, rec.id, rec.meta_dict())
                return ApiSuccessResponse(data=rec.meta_dict())

            if method == "put":
                if not uid:
                    return ApiFailResponse(message="Record uid is required for update", status_code=400)
                body = await request_info.get_post_data()
                if not isinstance(body, dict):
                    return ApiFailResponse(message="Invalid request body (expected JSON object)")
                try:
                    rec = await asyncio.to_thread(record_list.update, uid, body)
                except KeyError as e:
                    return ApiFailResponse(message=str(e), status_code=404)
                try:
                    await rec.sync_to_db()
                except Exception as e:
                    logging.debug(f"[fs-records] sync_to_db skipped on update: {e}")
                await self._broadcast_fs_record_op("update", record_type, uid, rec.meta_dict())
                return ApiSuccessResponse(data=rec.meta_dict())

            if method == "delete":
                if not uid:
                    return ApiFailResponse(message="Record uid is required for delete", status_code=400)
                # Remove Entity + FTS before deleting from disk
                from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
                from flow_sdk.db import get_db_driver  # noqa: PLC0415
                from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

                entity = await Entity.get_one(QueryFilter.parse({"id": uid}))
                if entity is not None:
                    driver = get_db_driver()
                    if hasattr(driver, "fts_delete"):
                        await driver.fts_delete(entity.id)
                    await entity.delete()
                # Remove from disk
                deleted = await asyncio.to_thread(record_list.delete, uid)
                if not deleted:
                    return ApiFailResponse(message=f"Record '{uid}' not found", status_code=404)
                await self._broadcast_fs_record_op("delete", record_type, uid)
                return ApiSuccessResponse(data={"deleted": uid})

            return ApiFailResponse(message=f"Unsupported method: {method}")

        except ReadOnlyRecordError as e:
            return ApiFailResponse(message=f"Record is read-only: {e}", status_code=403)
        except Exception as e:
            logging.exception(f"fs-records error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="clear-debug-errors")
    async def clear_debug_errors_action(self) -> "ApiResponse":
        """Delete all Claude debug logs and error records."""
        result = clear_debug_errors()
        return ApiSuccessResponse(data=result)

    @action.get(action_name="git-status")
    async def git_status_action(self) -> "ApiResponse":
        """Return git status for a working directory.

        Query params:
            workdir: Absolute path to the working directory

        Returns:
            ApiResponse with branch, ahead/behind counts, and file list
        """
        request_info = get_current_request_info()
        workdir = request_info.get_param("workdir") if request_info else None
        if not workdir:
            return ApiFailResponse(message="workdir parameter is required")

        async def run_git(*args: str) -> tuple[str, int]:
            try:
                cmd = await self.run_command(
                    f"git -C '{workdir}' " + " ".join(args),
                    background=False,
                )
                return (cmd.all_stdout or "").rstrip(), cmd.exit_code or 0
            except Exception:
                return "", 1

        # Check if it's a git repo
        _, rc = await run_git("rev-parse", "--is-inside-work-tree")
        if rc != 0:
            return ApiSuccessResponse(
                data={"error": "not a git repository", "branch": None, "ahead": 0, "behind": 0, "files": []}
            )

        # Branch name
        branch_out, _ = await run_git("branch", "--show-current")
        branch = branch_out.strip() or None

        # Ahead/behind
        ahead, behind = 0, 0
        ab_out, ab_rc = await run_git("rev-list", "--left-right", "--count", "HEAD...@{upstream}")
        if ab_rc == 0 and ab_out:
            parts = ab_out.split()
            if len(parts) == 2:
                try:
                    ahead, behind = int(parts[0]), int(parts[1])
                except ValueError:
                    pass

        # Numstat for unstaged and staged changes
        def parse_numstat(output: str) -> dict[str, tuple[int, int]]:
            result: dict[str, tuple[int, int]] = {}
            for line in output.splitlines():
                parts = line.split("\t", 2)
                if len(parts) == 3:
                    try:
                        ins = int(parts[0]) if parts[0] != "-" else 0
                        dels = int(parts[1]) if parts[1] != "-" else 0
                        result[parts[2]] = (ins, dels)
                    except ValueError:
                        pass
            return result

        numstat_unstaged_out, _ = await run_git("diff", "--numstat")
        numstat_staged_out, _ = await run_git("diff", "--numstat", "--staged")
        numstat_unstaged = parse_numstat(numstat_unstaged_out)
        numstat_staged = parse_numstat(numstat_staged_out)

        # Porcelain status
        porcelain_out, _ = await run_git("status", "--porcelain=v1")
        files: list[dict] = []
        for line in porcelain_out.splitlines():
            if len(line) < 4:
                continue
            x = line[0]  # staged status
            y = line[1]  # unstaged status
            path_part = line[3:]

            # Handle renames: "old -> new" or "old\0new"
            display_path = path_part
            lookup_path = path_part
            if " -> " in path_part:
                parts = path_part.split(" -> ", 1)
                display_path = f"{parts[0]} → {parts[1]}"
                lookup_path = parts[1]

            # Determine display status: staged takes priority
            if x in ("A", "M", "D", "R", "C") and x != " ":
                status = x
                ins, dels = numstat_staged.get(lookup_path, (None, None))
            elif y in ("M", "D") and y != " ":
                status = y
                ins, dels = numstat_unstaged.get(lookup_path, (None, None))
            elif x == "?" and y == "?":
                status = "?"
                ins, dels = None, None
            else:
                status = (x if x != " " else y) or "?"
                ins, dels = None, None

            files.append(
                {
                    "status": status,
                    "path": display_path,
                    "insertions": ins,
                    "deletions": dels,
                }
            )

        return ApiSuccessResponse(
            data={
                "error": None,
                "branch": branch,
                "ahead": ahead,
                "behind": behind,
                "files": files,
            }
        )

    @staticmethod
    def _embed_includes(
        item: dict,
        rec: "Record",  # noqa: F821
        include_set: set[str],
        cache: dict | None = None,
    ) -> None:
        """Embed related records into a serialized dict based on ?include=... params.

        *cache* deduplicates session lookups when embedding across a list.
        """
        if "claude_session" in include_set:
            ref = rec.session_ref if hasattr(rec, "session_ref") else None
            if ref and ref.id:
                if cache is not None and ref.id in cache:
                    session_dict = cache[ref.id]
                else:
                    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

                    project = rec.data.get("project", "") if rec.data else ""
                    session = ClaudeSessionRecord.discover_one(ref.id, project=project)
                    session_dict = session.meta_dict() if session else None
                    if cache is not None:
                        cache[ref.id] = session_dict
                if session_dict:
                    item["_session"] = session_dict

    @staticmethod
    def _parse_record_query(qp) -> "RecordQuery | None":  # noqa: F821
        """Parse query string parameters into a RecordQuery, or None if no filters."""
        from datetime import datetime

        from flow_sdk.fs_store.record_query import RecordQuery

        ids_raw = qp.get("ids")
        modified_after_raw = qp.get("modified_after")
        parent_id = qp.get("parent_id")
        status = qp.get("status")
        limit_raw = qp.get("limit")
        offset_raw = qp.get("offset")
        sort_by = qp.get("sort_by")
        sort_desc_raw = qp.get("sort_desc")

        if not any([ids_raw, modified_after_raw, parent_id, status, limit_raw, offset_raw, sort_by]):
            return None

        sort_desc = True
        if sort_desc_raw is not None:
            sort_desc = sort_desc_raw.lower() not in ("false", "0", "no")

        return RecordQuery(
            ids=ids_raw.split(",") if ids_raw else None,
            modified_after=datetime.fromisoformat(modified_after_raw) if modified_after_raw else None,
            parent_id=parent_id,
            status=status,
            limit=int(limit_raw) if limit_raw else None,
            offset=int(offset_raw) if offset_raw else 0,
            sort_by=sort_by,
            sort_desc=sort_desc,
        )

    async def _handle_path_based_source_file(
        self,
        method: str,
        request_info,
    ) -> ApiResponse:
        """Handle path-based source file CRUD: /fs-records/file?path=...&json_path=..."""
        from flow_sdk.fs_store.exceptions import ReadOnlyRecordError
        from flow_sdk.fs_store.source_file_registry import (
            is_allowed_source_path,
            resolve_list_class,
        )

        qp = request_info.request.query_params
        source_path = qp.get("path", "")
        json_path = qp.get("json_path")  # None means "all records"

        if not source_path:
            return ApiFailResponse(
                message="Missing required 'path' query parameter",
                status_code=400,
            )

        if not is_allowed_source_path(source_path):
            return ApiFailResponse(
                message=f"Access denied for path: {source_path}",
                status_code=403,
            )

        # Expand ~ to home dir
        expanded_path = str(Path(source_path).expanduser())

        list_class = resolve_list_class(expanded_path)
        if list_class is None:
            return ApiFailResponse(
                message=f"Unknown source file type: {Path(expanded_path).name}",
                status_code=400,
            )

        record_list = list_class(source_file=expanded_path)

        try:
            if method == "get":
                if json_path is not None:
                    rec = self._find_record_by_json_path(record_list, json_path)
                    if rec is None:
                        return ApiFailResponse(
                            message=f"No record at json_path '{json_path}'",
                            status_code=404,
                        )
                    d = rec.meta_dict()
                    d["source_file"] = expanded_path
                    d["json_path"] = rec.json_path
                    return ApiSuccessResponse(data=d)
                # List all records from the file
                results = []
                for rec in record_list:
                    d = rec.meta_dict()
                    d["source_file"] = expanded_path
                    d["json_path"] = rec.json_path
                    results.append(d)
                return ApiSuccessResponse(data=results)

            if method == "put":
                if json_path is None:
                    return ApiFailResponse(
                        message="'json_path' query parameter is required for update",
                        status_code=400,
                    )
                rec = self._find_record_by_json_path(record_list, json_path)
                if rec is None:
                    return ApiFailResponse(
                        message=f"No record at json_path '{json_path}'",
                        status_code=404,
                    )
                body = await request_info.get_post_data()
                if not isinstance(body, dict):
                    return ApiFailResponse(
                        message="Invalid request body (expected JSON object)",
                    )
                updated = record_list.update(rec.type, rec.id, body)
                try:
                    await updated.sync_to_db()
                except Exception as e:
                    logging.debug(f"[fs-records] sync_to_db skipped on source-file update: {e}")
                result_data = updated.meta_dict()
                result_data["source_file"] = expanded_path
                result_data["json_path"] = updated.json_path
                await self._broadcast_fs_record_op(
                    "update",
                    rec.type,
                    rec.id,
                    result_data,
                    source_file=expanded_path,
                )
                return ApiSuccessResponse(data=result_data)

            if method == "delete":
                if json_path is None:
                    return ApiFailResponse(
                        message="'json_path' query parameter is required for delete",
                        status_code=400,
                    )
                rec = self._find_record_by_json_path(record_list, json_path)
                if rec is None:
                    return ApiFailResponse(
                        message=f"No record at json_path '{json_path}'",
                        status_code=404,
                    )
                deleted = record_list.delete_record(rec.type, rec.id)
                if not deleted:
                    return ApiFailResponse(
                        message=f"Failed to delete record at json_path '{json_path}'",
                        status_code=404,
                    )
                await self._broadcast_fs_record_op(
                    "delete",
                    rec.type,
                    rec.id,
                    source_file=expanded_path,
                )
                return ApiSuccessResponse(data={"deleted": json_path})

            return ApiFailResponse(message=f"Unsupported method: {method}")

        except ReadOnlyRecordError as e:
            return ApiFailResponse(message=f"Record is read-only: {e}", status_code=403)
        except Exception as e:
            logging.exception(f"fs-records path-based error: {e}")
            return ApiFailResponse(message=str(e))

    @staticmethod
    def _find_record_by_json_path(record_list, json_path: str):
        """Find a record by its json_path within a JsonFileRecordStore.

        Handles root record matching: json_path="" or "/" both match the root.
        """
        for rec in record_list:
            rec_jp = getattr(rec, "json_path", None)
            if rec_jp is None:
                continue
            # Root record: both "" and "/" should match
            if json_path in ("", "/") and rec_jp in ("", "/"):
                return rec
            if rec_jp == json_path:
                return rec
        return None

    async def _broadcast_fs_record_op(
        self,
        op: str,
        record_type: str,
        uid: str,
        data: dict | None = None,
        *,
        source_file: str | None = None,
    ) -> None:
        """Broadcast a WebSocket DataOp notification for an fs-record CRUD operation.

        This is notification-only — Entity/FTS sync is done by the caller via
        ``rec.sync_to_db()`` on the real saved record before this is called.
        """
        try:
            from flow_sdk.api.messages import DataOpMessage, OperationType
            from flow_sdk.api.type_id import TypeId
            from flow_sdk.core.network.resource_tracker import handle_entity_op

            op_enum = OperationType(op)
            broadcast_data = dict(data) if data else {}
            if source_file:
                broadcast_data["_source_file"] = source_file
            data_op_msg = DataOpMessage(
                op=op_enum,
                to_entity=TypeId(type=record_type, id=uid),
                data=broadcast_data or None,
            )
            await handle_entity_op(data_op_msg)
        except Exception as e:
            logging.warning(f"[fs-records] Failed to broadcast DataOp: {e}")

    @asynccontextmanager
    async def ready_session(self):
        current_status = await self.get_node_status()
        if current_status == ExecutionEnvironmentStatus.READY:
            await self.startup()
        elif current_status == ExecutionEnvironmentStatus.PAUSED:
            await self.resume()
        else:
            await self.setup_node()
            await self.save()
        yield self
        await self.pause()
