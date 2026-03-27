import asyncio
import json
import logging
import os
import platform
import sys
import uuid
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Any, AsyncIterator, Literal, overload

from pydantic import Field
from starlette.responses import RedirectResponse

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.messages import ResponseMessage
from flow_sdk.api.type_id import TypeId
from flow_sdk.compute.providers import ComputeProvider, get_compute_provider
from flow_sdk.compute.providers.compute_provider import ListDirItem
from flow_sdk.config import AGENT_MOUNT_FOLDER, ComputeProviderType, StorageProvider
from flow_sdk.config import ComputeProviderType as ComputeProviderEnum
from flow_sdk.core import action
from flow_sdk.core.entity import Entity
from flow_sdk.core.resource_management.scan.system_profile.types import SystemProfile
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.compute_types import CLICommand, SendFileEntry
from flow_sdk.flowpad_types.machine_status import MACHINE_STATUS_SCRIPT, MachineStatus, NetworkConnection, ProcessInfo
from flow_sdk.flowpad_types.runtime_environment import ComputeNodeSize, ExecutionEnvironmentStatus, RuntimeEnvironment
from flow_sdk.fs_records.claude.claude_debug_log import clear_debug_errors
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.ops_actions import OpsActionsMixin
from flow_sdk.builtin.faas.pty_actions import PtyActionsMixin
from flow_sdk.builtin.faas.scan_actions import ScanActionsMixin

# Module-level activity registry: key = "{entity_typeid}:{job_name}"
# Prevents duplicate concurrent scan/index jobs on the same compute node.
_COMPUTE_ACTIVITIES: dict[str, "Any"] = {}


class ComputeNode(PtyActionsMixin, FsRecordsActionsMixin, OpsActionsMixin, ScanActionsMixin, Entity):
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


    # -- PTY actions (implementations in PtyActionsMixin) -----------------------

    @action.post("terminal-command")
    async def terminal_command(self): return await self._pty_terminal_command()

    @action.get(action_name="list-shell-sessions")
    async def _list_shell_sessions(self): return await self._pty_list_shell_sessions()

    @action.get(action_name="session-transcript")
    async def _session_transcript(self): return await self._pty_session_transcript()

    @action.get(action_name="discovery")
    async def _discovery_action(self): return await self._pty_discovery_action()

    @action.post(action_name="reset-pty")
    async def reset_pty(self): return await self._pty_reset_pty()

    @action.post(action_name="update-shell-session")
    async def _update_shell_session(self): return await self._pty_update_shell_session()

    @action.post("ops")
    async def ops(self): return await self._ops_dispatch()

    # -- ops actions -------------------------------------------------------------

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
    async def scan_resources_action(self): return await self._scan_resources()

    @action.all(action_name="get-resource-summary")
    async def get_resource_summary_action(self): return await self._scan_get_resource_summary()

    @action.all(action_name="scan-item")
    async def scan_item_action(self): return await self._scan_item()

    @action.all(action_name="clear-skill-usage")
    async def clear_skill_usage_action(self): return await self._scan_clear_skill_usage()

    @action.all(action_name="clear-cli-log")
    async def clear_cli_log_action(self): return await self._scan_clear_cli_log()

    @action.all(action_name="list-projects")
    async def list_projects_action(self): return await self._scan_list_projects()

    @action.all(action_name="scan-project")
    async def scan_project_action(self): return await self._scan_project()

    @action.all(action_name="createAgenticProcessor")
    async def create_agentic_processor(self): return await self._scan_create_agentic_processor()

    @action.post(action_name="upsertSessionProcess")
    async def upsert_session_process(self): return await self._scan_upsert_session_process()

    # -- fs-records action (implementation in FsRecordsActionsMixin) -------------

    @action.all(action_name="fs-records", methods=["get", "post", "put", "delete"])
    async def fs_records_action(self): return await self._fs_records_action()

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

        # Send command to PTY
        pty = self.get_pty(shell_id)
        if not pty:
            return ApiFailResponse(message=f"PTY session not found: {shell_id}")
        await pty.send(command.encode())

        return ApiSuccessResponse(
            data={
                "shell_id": shell_id,
                "claude_session_id": claude_session_id,
                "status": "elevated",
            }
        )

    @action.post(action_name="clear-debug-errors")
    async def clear_debug_errors_action(self) -> "ApiResponse":
        """Delete all Claude debug logs and error records."""
        result = clear_debug_errors()
        return ApiSuccessResponse(data=result)

    @action.get(action_name="get-cwd")
    async def get_cwd_action(self) -> "ApiResponse":
        """Return the current working directory."""
        cmd = await self.run_command("pwd", background=False)
        cwd = (cmd.all_stdout or "").strip()
        return ApiSuccessResponse(data={"cwd": cwd})

    @action.get(action_name="git-ops")
    async def git_ops_action(self) -> "ApiResponse":
        """Unified gateway for git operations. Delegates to GitRepo.dispatch().

        Routing (via sub_path):
            GET /git-ops/status              ?workdir=...  → git status
            GET /git-ops/branch              ?workdir=...  → current branch
            GET /git-ops/is-init             ?workdir=...  → is git repo
            GET /git-ops/is-linked-worktree  ?workdir=...  → is linked worktree
        """
        request_info = get_current_request_info()
        segments = [s for s in (request_info.sub_path or "").strip("/").split("/") if s]
        workdir = request_info.get_param("workdir") if request_info else None
        if not workdir:
            return ApiFailResponse(message="workdir parameter is required")

        from flow_sdk.builtin.faas.git_repo import GitRepo
        return await GitRepo(workdir, self).dispatch(segments[0] if segments else "")

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
