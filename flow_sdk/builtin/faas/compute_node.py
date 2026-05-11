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

from fastapi import BackgroundTasks
from pydantic import Field
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.messages import ResponseMessage
from flow_sdk.api.type_id import TypeId
from flow_sdk.compute.providers import ComputeProvider, get_compute_provider
from flow_sdk.compute.providers.compute_provider import ListDirItem
from flow_sdk.config import ComputeProviderType, StorageProvider
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

from flow_sdk.builtin.faas.desktop_actions import DesktopActionsMixin
from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.ops_actions import OpsActionsMixin
from flow_sdk.builtin.faas.pty_actions import PtyActionsMixin
from flow_sdk.builtin.faas.scan_actions import ScanActionsMixin

# Module-level activity registry: key = "{entity_typeid}:{job_name}"
# Prevents duplicate concurrent scan/index jobs on the same compute node.
_COMPUTE_ACTIVITIES: dict[str, "Any"] = {}


class ComputeNode(PtyActionsMixin, FsRecordsActionsMixin, OpsActionsMixin, ScanActionsMixin, DesktopActionsMixin, Entity):
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

    def _start_activity(self, job_name: str, timeout_seconds: int = 600):
        """Register a new in-process activity, raising RuntimeError if one is already running."""
        from flow_sdk.builtin.faas.in_process_activity import InProcessActivity  # noqa: PLC0415

        key = f"{self.typeid}:{job_name}"
        existing = _COMPUTE_ACTIVITIES.get(key)
        if existing is not None and not existing.is_timed_out and not existing.is_complete:
            raise RuntimeError(f"Job '{job_name}' already running")
        activity = InProcessActivity(
            job_name=job_name,
            entity_id=str(self.typeid),
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

    @action.get(action_name="list-shells")
    async def _list_shells(self): return await self._pty_list_shells()

    @action.all(action_name="terminals", methods=["get", "post"])
    async def _terminals(self, background_tasks: BackgroundTasks) -> ApiResponse:
        request_info = get_current_request_info()
        sub_path = (request_info.sub_path or "").strip("/").lower() if request_info else ""
        if sub_path == "list":
            if request_info and not request_info.is_get:
                return ApiFailResponse(message="terminals/list requires GET", status_code=405)
            return await self._terminal_list()
        if sub_path == "close":
            if request_info and not request_info.is_post:
                return ApiFailResponse(message="terminals/close requires POST", status_code=405)
            body = await request_info.get_post_data() if request_info else {}
            return await self._terminal_close(body, background_tasks)
        if sub_path.startswith("get_by_worker_id/"):
            if request_info and not request_info.is_get:
                return ApiFailResponse(message="terminals/get_by_worker_id requires GET", status_code=405)
            worker_id = sub_path[len("get_by_worker_id/"):]
            if not worker_id:
                return ApiFailResponse(message="worker id required", status_code=400)
            return await self._scan_get_by_worker_id(worker_id)
        return ApiFailResponse(message=f"unknown terminals sub-path: {sub_path!r}", status_code=400)

    async def _terminal_list(self) -> ApiResponse:
        """Single source of truth for the tab strip.

        Returns two flat, non-overlapping lists. The frontend renders both,
        with no join: each "AI worker" tab comes from ``visible_processes``
        and each "plain terminal" tab comes from ``pure_shells``.

        Wire shape: ``{pure_shells, visible_processes, checked_at}``.
          - ``pure_shells``: Shell entity dicts that are NOT background plumbing
            for any AgenticProcess. A shell is "pure" iff no AgenticProcess
            (visible or not) owns it via ``shell_id``. This deliberately drops
            both visible-process-owned shells (they show up via the process row)
            and invisible-process-owned orphans.
          - ``visible_processes``: AgenticProcess entity dicts with
            ``visible == true``. After ``createProcess`` becomes atomic, every
            visible process has a populated ``shell_id``.
        """
        from flow_sdk.builtin.shell import Shell as ShellEntity
        from flow_sdk.builtin.agentic_process import AgenticProcess

        # 1. Fetch
        all_shells = await ShellEntity.get_all()
        # Reap pass also covers invisible STOPPING rows so they can recover
        # and re-appear when the user opens them. The visible filter is
        # applied below for what we *return*, not for what we *reap*.
        all_processes = await AgenticProcess.get_all()

        # 2. Reap stuck STOPPING — fan out, processes are independent (each owns
        # its own shell + save lock), so concurrent reap is safe.
        reap_results = await asyncio.gather(
            *(proc.reap_if_orphaned() for proc in all_processes),
            return_exceptions=True,
        )
        reaped_any = any(r is True for r in reap_results)

        # 3. Refetch if we reaped, then narrow to visible.
        if reaped_any:
            all_processes = await AgenticProcess.get_all()
        visible_processes = [p for p in all_processes if getattr(p, "visible", False)]

        # 4. Drop background shells: any shell owned by an AgenticProcess
        # (regardless of visibility) is plumbing for that process and is
        # represented by the process row instead. Sidecars are already a
        # subset of "owned by a process" but we keep the explicit set for
        # readability and to honor the unconditional sidecar exclusion.
        owned_shell_ids = {p.shell_id for p in all_processes if getattr(p, "shell_id", None)}
        sidecar_ids = {p.sidecar_shell_id for p in all_processes if getattr(p, "sidecar_shell_id", None)}
        excluded_shell_ids = owned_shell_ids | sidecar_ids

        from flow_sdk.fs_records.shell_record import ShellStatus
        terminal_shell_states = {
            ShellStatus.CLOSING.value,
            ShellStatus.CLOSED.value,
            ShellStatus.ERROR.value,
        }
        pure_shells = [
            s for s in all_shells
            if s.status not in terminal_shell_states
            and s.id not in excluded_shell_ids
        ]

        # 5. Build response with full entity dicts for cache write-through.
        pure_shell_dicts = [s.model_dump(mode="json") for s in pure_shells]
        process_dicts = [p.model_dump(mode="json") for p in visible_processes]

        from datetime import datetime as _dt, timezone as _tz
        return ApiSuccessResponse(data={
            "pure_shells": pure_shell_dicts,
            "visible_processes": process_dicts,
            "checked_at": _dt.now(tz=_tz.utc).isoformat(),
        })

    def _parse_terminal_target(self, raw: Any) -> tuple[str, str] | None:
        if not isinstance(raw, str):
            return None
        target = raw.strip()
        if not target:
            return None
        if ":" in target:
            entity_type, entity_id = target.split(":", 1)
            if entity_type not in {"shell", "agentic_process"} or not entity_id:
                return None
            try:
                TypeId(type=entity_type, id=entity_id)
            except Exception:
                return None
            return entity_type, entity_id
        try:
            typeid = TypeId(target)
        except Exception:
            return None
        if typeid.type not in {"shell", "agentic_process"} or not typeid.id:
            return None
        return typeid.type, typeid.id

    async def _mark_shell_closing(self, shell_id: str) -> bool:
        from flow_sdk.builtin.shell import Shell as ShellEntity
        from flow_sdk.fs_records.shell_record import ShellStatus

        shell = await ShellEntity.get_by_id(shell_id)
        if not shell:
            return False
        if shell.status != ShellStatus.CLOSING.value:
            shell.status = ShellStatus.CLOSING.value
            await shell.save()
        try:
            record = await shell.get_record()
            if record:
                record.sync_from_entity(shell)
        except Exception as e:
            logging.warning(f"[terminals/close] Failed to mark ShellRecord closing for {shell_id}: {e}")
        return True

    async def _terminal_close(self, body: dict, background_tasks: BackgroundTasks) -> ApiResponse:
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.builtin.shell import Shell as ShellEntity
        from flow_sdk.fs_records.agentic_process_lifecycle import ProcessStatus

        targets = body.get("targets") if isinstance(body, dict) else None
        if not isinstance(targets, list):
            return ApiFailResponse(message="terminals/close requires body: { targets: string[] }", status_code=400)

        accepted: list[str] = []
        missing: list[str] = []
        invalid: list[str] = []
        seen: set[str] = set()

        for raw in targets:
            parsed = self._parse_terminal_target(raw)
            if not parsed:
                invalid.append(str(raw))
                continue

            entity_type, entity_id = parsed
            canonical = str(TypeId(type=entity_type, id=entity_id))
            if canonical in seen:
                continue
            seen.add(canonical)

            if entity_type == "agentic_process":
                proc = await AgenticProcess.get_by_id(entity_id)
                if not proc:
                    missing.append(canonical)
                    continue
                shell_id = getattr(proc, "shell_id", None)
                proc.status = ProcessStatus.STOPPING.value
                proc.visible = False
                await proc.save()
                if shell_id:
                    await self._mark_shell_closing(shell_id)
                accepted.append(canonical)
                background_tasks.add_task(self._close_agentic_terminal_background, entity_id)
                continue

            shell = await ShellEntity.get_by_id(entity_id)
            if not shell:
                missing.append(canonical)
                continue
            await self._mark_shell_closing(entity_id)
            accepted.append(canonical)
            background_tasks.add_task(self._close_shell_terminal_background, entity_id)

        return ApiSuccessResponse(data={
            "accepted": accepted,
            "missing": missing,
            "invalid": invalid,
        })

    async def _close_agentic_terminal_background(self, process_id: str) -> None:
        try:
            from flow_sdk.builtin.agentic_process import AgenticProcess

            proc = await AgenticProcess.get_by_id(process_id)
            if proc:
                await proc.close()
        except Exception as e:
            logging.exception(f"[terminals/close] AgenticProcess teardown failed for {process_id}: {e}")

    async def _close_shell_terminal_background(self, shell_id: str) -> None:
        try:
            from flow_sdk.builtin.shell import Shell as ShellEntity

            shell = await ShellEntity.get_by_id(shell_id)
            if shell:
                await shell.close()
        except Exception as e:
            logging.exception(f"[terminals/close] Shell teardown failed for {shell_id}: {e}")
            try:
                from flow_sdk.builtin.shell import Shell as ShellEntity

                shell = await ShellEntity.get_by_id(shell_id)
                if shell:
                    shell.status = "error"
                    shell.error_message = str(e)
                    await shell.save()
            except Exception:
                logging.exception(f"[terminals/close] Failed to persist shell close error for {shell_id}")

    @action.get(action_name="session-transcript")
    async def _session_transcript(self): return await self._pty_session_transcript()

    @action.get(action_name="session-transcript-raw")
    async def _session_transcript_raw(self): return await self._pty_session_transcript_raw()

    @action.get(action_name="discovery")
    async def _discovery_action(self): return await self._pty_discovery_action()

    @action.post(action_name="reset-pty")
    async def reset_pty(self): return await self._pty_reset_pty()

    @action.post(action_name="update-shell")
    async def _update_shell(self): return await self._pty_update_shell()

    @action.post("ops")
    async def ops(self): return await self._ops_dispatch()

    # -- ops actions -------------------------------------------------------------

    @action.all(action_name="get-host")
    def get_host_action(self, port: int, redirect: bool = True): return self._desktop_get_host(port, redirect)

    @action.all(action_name="get-machine-status")
    async def get_machine_status_action(self): return await self._desktop_get_machine_status()

    @action.all(action_name="get-system-profile")
    async def get_system_profile_action(self): return await self._desktop_get_system_profile()

    @action.post(action_name="open-external")
    async def open_external_action(self): return await self._desktop_open_external()

    @action.post(action_name="open-terminal")
    async def open_terminal_action(self): return await self._desktop_open_terminal()

    @action.post(action_name="pick-folder")
    async def pick_folder_action(self): return await self._desktop_pick_folder()

    @action.all(action_name="get-json-file")
    async def get_json_file_action(self): return await self._desktop_get_json_file()

    @action.post(action_name="save-json-file")
    async def save_json_file_action(self): return await self._desktop_save_json_file()

    @action.post(action_name="generate-amd-plan")
    async def generate_amd_plan_action(self): return await self._desktop_generate_amd_plan()

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

    @action.post(action_name="createProcess")
    async def create_process_action(self): return await self._scan_create_process()

    @action.post(action_name="upsertSessionProcess")
    async def upsert_session_process(self): return await self._scan_upsert_session_process()

    @action.get(action_name="findSession")
    async def find_session(self): return await self._scan_find_session()

    # -- fs-records action (implementation in FsRecordsActionsMixin) -------------

    @action.all(action_name="fs-records", methods=["get", "post", "put", "delete"])
    async def fs_records_action(self): return await self._fs_records_action()

    # -- shell record actions ----------------------------------------------------

    @action.post(action_name="clear-debug-errors")
    async def clear_debug_errors_action(self) -> ApiResponse:
        """Delete all Claude debug logs and error records."""
        result = clear_debug_errors()
        return ApiSuccessResponse(data=result)

    @action.post(action_name="search-cloud-errors")
    async def search_cloud_errors_action(self) -> ApiResponse:
        """Proxy error fingerprint search to the Flowpad cloud, then apply results to local records."""
        from flow_sdk.cli.auth.hub_login import get_api_key as get_flowpad_api_key
        from flow_sdk.cloud_client import ApiConfig, FlowpadClient

        request_info = get_current_request_info()
        body = await request_info.get_post_data()

        fingerprints = body.get("fingerprints", [])
        if not fingerprints:
            return ApiFailResponse(message="fingerprints is required")

        flowpad_api_key = get_flowpad_api_key()
        if not flowpad_api_key:
            return ApiFailResponse(message="Not logged in to Flowpad cloud")

        config = ApiConfig()

        try:
            async with FlowpadClient(config) as client:
                client.set_api_key(flowpad_api_key)
                result = await client.post(
                    "/graph/analysis/search",
                    {"analysis_type": "claude_error", "fingerprints": fingerprints, "data": {}},
                )
            await self._apply_cloud_results(result.get("results", []))
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=f"Cloud search error: {e}")

    async def _apply_cloud_results(self, results: list) -> None:
        """Apply cloud search results to local records (mark ignored / save fix suggestions)."""
        from datetime import datetime, timezone

        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord, ErrorStatus, Fix

        if not results:
            return

        now = datetime.now(timezone.utc).isoformat()

        for r in results:
            fp = r.get("fingerprint", "")
            if not fp:
                continue
            rec = ClaudeErrorRecord.get_by_fingerprint(fp)
            if rec is None:
                continue
            if r.get("action") == "ignore":
                rec.error_status = ErrorStatus.IGNORED
                rec.triaged_at = now
                rec.save()
            elif r.get("action") == "fix":
                rec.fix = Fix(
                    instruction=r.get("instruction") or "",
                    message=r.get("message") or "",
                )
                rec.triaged_at = now
                rec.save()

    @action.post(action_name="fix-all-cloud-errors")
    async def fix_all_cloud_errors_action(self) -> ApiResponse:
        """Spawn an AgenticProcess for each error with a saved cloud fix instruction."""
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCliOptions
        from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord, Fix

        request_info = get_current_request_info()
        body = await request_info.get_post_data()
        fingerprints = body.get("fingerprints", [])
        if not fingerprints:
            return ApiFailResponse(message="fingerprints is required")

        spawned = []
        for fp in fingerprints:
            rec = ClaudeErrorRecord.get_by_fingerprint(fp)
            fix = getattr(rec, "fix", None)
            fix_instruction = fix.instruction if isinstance(fix, Fix) else ""
            if rec is None or not fix_instruction:
                spawned.append({"fingerprint": fp, "status": "skipped"})
                continue
            try:
                cmd = ClaudeCliOptions(permission_mode="bypassPermissions")
                agentic_process = AgenticProcess(
                    cli_config=cmd.to_json(),
                )
                await agentic_process.save(owner=request_info.someone_typeid if request_info else None)
                result = await agentic_process.open(instruction=fix_instruction)  # type: ignore[assignment]
                shell_id = agentic_process.shell_id or ""
                spawned.append({
                    "fingerprint": fp,
                    "status": "spawned",
                    "shell_id": shell_id,
                    "worker_session_id": agentic_process.worker_session_id or "",
                })
            except Exception as e:
                spawned.append({"fingerprint": fp, "status": "error", "message": str(e)})

        return ApiSuccessResponse(data={"spawned": spawned})

    @action.get(action_name="get-cwd")
    async def get_cwd_action(self) -> ApiResponse:
        """Return the current working directory."""
        cmd = await self.run_command("pwd", background=False)
        cwd = (cmd.all_stdout or "").strip()
        return ApiSuccessResponse(data={"cwd": cwd})

    @action.get(action_name="worker-history")
    async def worker_history_action(self) -> ApiResponse:
        """Unified Recent Sessions list across every worker (claude, codex, …)."""
        from flow_sdk.fs_records.worker_history import get_worker_history

        request_info = get_current_request_info()
        limit_raw = request_info.get_param("limit") if request_info else None
        try:
            limit = int(limit_raw) if limit_raw else 10
        except (TypeError, ValueError):
            limit = 10
        entries = await asyncio.to_thread(get_worker_history, limit)
        return ApiSuccessResponse(data=[e.model_dump(mode="json") for e in entries])

    @action.get(action_name="git-ops")
    async def git_ops_action(self) -> ApiResponse:
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

        query_params = {k: v for k, v in (request_info.request_parameters or {}).items() if k != "workdir"}
        from flow_sdk.builtin.faas.git_repo import GitRepo
        return await GitRepo(workdir, self).dispatch(segments[0] if segments else "", query_params)

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
