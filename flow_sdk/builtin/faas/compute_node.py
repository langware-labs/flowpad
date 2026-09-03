import asyncio
import json
import logging
import os
import platform
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Literal, overload

from fastapi import BackgroundTasks
from pydantic import field_validator

if TYPE_CHECKING:
    # Runtime imports of Project stay function-local (circular import); this is
    # only so the "Project" annotations below resolve for linters/type checkers.
    from flow_sdk.builtin.project import Project

from flow_sdk.api.api_types.api_field import APIField, EntityField, Sharing
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.builtin.faas.analytics import AnalyticsActionsMixin
from flow_sdk.builtin.faas.desktop_actions import DesktopActionsMixin
from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.ops_actions import OpsActionsMixin
from flow_sdk.builtin.faas.pty_actions import PtyActionsMixin
from flow_sdk.builtin.faas.scan_actions import ScanActionsMixin
from flow_sdk.compute.providers import ComputeProvider, get_compute_provider
from flow_sdk.compute.providers.compute_provider import ListDirItem
from flow_sdk.config import ComputeProviderType, StorageProvider, get_os_root_path
from flow_sdk.config import ComputeProviderType as ComputeProviderEnum
from flow_sdk.core import action
from flow_sdk.core.entity import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.compute_types import CLICommand, SendFileEntry
from flow_sdk.flowpad_types.machine_status import MACHINE_STATUS_SCRIPT, MachineStatus, NetworkConnection, ProcessInfo
from flow_sdk.flowpad_types.runtime_environment import ComputeNodeSize, ExecutionEnvironmentStatus, RuntimeEnvironment
from flow_sdk.fs_store.operations.claude_debug_log import clear_debug_errors
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

# Module-level activity registry: key = "{entity_typeid}:{job_name}"
# Prevents duplicate concurrent scan/index jobs on the same compute node.
_COMPUTE_ACTIVITIES: dict[str, "Any"] = {}

# The uname of the singleton "this machine" compute node. INTERNAL to
# ComputeNode.get_local / create_local — no other module should reference the
# literal "local" / "compute_node-@local"; go through get_local() instead.
_LOCAL_UNAME = "local"

# The two terminal tab kinds: close is a full teardown (``_terminal_close``),
# not clear-membership, and target parsing for the legacy terminals/* shim is
# restricted to these.
TERMINAL_TAB_TYPES = frozenset({"shell", "agentic_process"})


def build_dir_zip(local_path: str) -> BytesIO:
    """Zip a local directory tree in memory, entries relative to its root.

    Symlinks are skipped deliberately: following them can pull in files from
    outside the tree (and, for a link to a directory, recurse). Sorted for a
    deterministic archive. Sync + CPU-bound — call it via ``asyncio.to_thread``.
    """
    import zipfile  # noqa: PLC0415

    root = Path(local_path)
    if not root.is_dir():
        raise ValueError(f"copy_folder: not a directory: {local_path}")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(root.rglob("*"), key=str):
            if p.is_file() and not p.is_symlink():
                zf.write(p, p.relative_to(root).as_posix())
    buf.seek(0)
    return buf


class ComputeNode(
    PtyActionsMixin,
    FsRecordsActionsMixin,
    OpsActionsMixin,
    ScanActionsMixin,
    AnalyticsActionsMixin,
    DesktopActionsMixin,
    Entity,
):
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

    @field_validator("node_provider_type", mode="before")
    @classmethod
    def _tolerate_unknown_provider(cls, value: Any) -> Any:
        """A provider this build no longer knows (e.g. the removed desktop ``docker``)
        hydrates as ``None`` instead of failing every ``ComputeNode`` query. Using
        such a node still raises a clear error in ``compute_provider``."""
        if isinstance(value, str) and value not in {p.value for p in ComputeProviderType}:
            logging.warning("compute node: unknown provider %r on hydration; treating as unset", value)
            return None
        return value

    # Which of a project's declared secrets this node may see, per project.
    #
    # Value-free by construction — the token IS the env var name and the project
    # is the namespace, so this can travel with a shared node without carrying
    # anything secret. Which is the point: secrets are ON the node, so whoever
    # gets the node gets them, with no extra consent step; resolution still
    # happens on the receiver's machine from their own store.
    #
    # A project key that is ABSENT means "all of that project's secrets" — so
    # nothing changes for anyone who never opens the attach UI. An explicit
    # empty list means none.
    attached_secrets: dict[str, list[str]] = APIField(default_factory=dict)
    # Override Entity's fs_storage fields with compute node defaults
    fs_storage_provider: StorageProvider | None = EntityField(default=StorageProvider.SANDBOX, sharing=Sharing.PRIVATE)
    fs_storage_mount_path: str | None = APIField(default=None, sharing=Sharing.PRIVATE)
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
        """Remove a completed activity from the registry and wake its waiters."""
        activity = _COMPUTE_ACTIVITIES.pop(f"{self.typeid}:{job_name}", None)
        if activity is not None:
            activity.released.set()

    def _running_activity(self, job_name: str):
        """The activity holding ``job_name``, or None when the slot is free.

        "Holding" is the same predicate `_start_activity` refuses on, so a
        caller that waits on this and a caller that claims cannot disagree
        about whether the slot is taken.
        """
        existing = _COMPUTE_ACTIVITIES.get(f"{self.typeid}:{job_name}")
        if existing is None or existing.is_timed_out or existing.is_complete:
            return None
        return existing

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

    # ──────────────────────────────────────────────────────────────────────
    # The singleton @local compute node
    #
    # `@local` is the one compute node that represents "this machine". The
    # entire local stack (PTY/shell, agentic processes, the file explorer, the
    # app host) addresses it by uname, never by a cached id — so if the row goes
    # missing (e.g. a project-delete cascade or a compute-node sweep deletes it
    # out from under a running session) every one of those callers breaks.
    #
    # get_local() / create_local() are the SINGLE source of truth for resolving
    # and minting it. Resolution is hardened (stable id → cache-invalidate retry
    # → legacy uname → self-heal create) so callers can stop hand-rolling their
    # own fallbacks and can drop their None-handling. The uname literal is an
    # implementation detail of these two methods.
    # ──────────────────────────────────────────────────────────────────────

    @classmethod
    def _local_id(cls) -> str:
        """Deterministic per-machine id for the @local compute node. Single
        source of truth (shared with bootstrap's @local user/project/workspace):
        ``flow_sdk.utils.machine_id.local_entity_id``."""
        from flow_sdk.utils.machine_id import local_entity_id  # noqa: PLC0415

        return local_entity_id("compute_node")

    @classmethod
    async def _get_local_legacy(cls) -> "ComputeNode | None":
        """Resolve a pre-stable-id @local row by ``uname='local'``, tolerating
        duplicate rows (returns the first) the way bootstrap's
        ``get_local_entity`` does."""
        try:
            return await cls.get_by_uname(_LOCAL_UNAME)
        except Exception as exc:  # noqa: BLE001
            if "Multiple rows were found" in str(exc):
                try:
                    rows = await cls.get_all({"match": {"uname": _LOCAL_UNAME}})
                    if rows:
                        logging.warning(
                            "[compute-node] %d @local rows found; using first %s",
                            len(rows),
                            rows[0].id,
                        )
                        return rows[0]
                except Exception as list_exc:  # noqa: BLE001
                    logging.error("[compute-node] duplicate @local resolve failed: %s", list_exc)
            else:
                logging.error("[compute-node] legacy @local lookup failed: %s", exc)
        return None

    @classmethod
    async def get_local(cls, *, create: bool = True) -> "ComputeNode | None":
        """Return the singleton @local compute node — the one robust way to get it.

        Resolution order, hardened against every way the row can go missing:
          1. deterministic stable id (the common, cheap path)
          2. cache-invalidating retry by id (a transient contention/cache miss
             under heavy parallel writes can hide a row that is actually there)
          3. legacy ``uname='local'`` row (databases written before stable-id),
             with duplicate-row dedup
          4. self-heal: ``create_local()`` when ``create`` is True

        With ``create=True`` (the default) this NEVER returns ``None`` — callers
        can drop their None-handling and stop hand-rolling fallbacks. Pass
        ``create=False`` for read-only callers that must not mint a node as a
        side effect (e.g. detaching it during project deletion).
        """
        local_id = cls._local_id()
        node = await cls.get_by_id(local_id)
        if node is None:
            try:
                from flow_sdk.core.cache.entity_cache import uname_cache  # noqa: PLC0415

                uname_cache.invalidate("compute_node", _LOCAL_UNAME)
            except Exception:  # noqa: BLE001
                pass
            node = await cls.get_by_id(local_id)
        if node is None:
            node = await cls._get_local_legacy()
        if node is None and create:
            node = await cls.create_local()
        return node

    @classmethod
    async def create_local(cls, *, owner: "Any | None" = None) -> "ComputeNode":
        """Mint (or, under a race, adopt) the singleton @local compute node.

        Deterministic id + ``uname='local'``; SANDBOX storage mounted at the OS
        root so the whole local filesystem is browsable; owner defaults to the
        @local desktop user when one is resolvable.

        Deliberately does NOT attach the node to any project. It is a shared,
        machine-level singleton, not a project-owned child — attaching it as a
        child created an ``is_child`` edge that project deletion cascaded
        through, deleting the node out from under every live session.
        """
        os_root = get_os_root_path()
        local_id = cls._local_id()

        if owner is None:
            try:
                from flow_sdk.builtin.user import User  # noqa: PLC0415

                owner = await User.get_by_uname(_LOCAL_UNAME)
            except Exception:  # noqa: BLE001
                owner = None

        node = cls(
            id=local_id,
            type="compute_node",
            uname=_LOCAL_UNAME,
            name="@local",
            runtime=RuntimeEnvironment(name="local_desktop_runtime"),
            node_provider_type=ComputeProviderType.LOCAL_MACHINE,
            fs_storage_provider=StorageProvider.SANDBOX,
            fs_storage_mount_path=os_root,
            visitor_role="owner",
            # Stable per-process provider id, needed for PTY ops. Set up-front so
            # the create is a single atomic write (no follow-up save).
            node_provider_id=f"name_{uuid.uuid4()}",
        )
        try:
            await node.save(owner=owner)
        except Exception as save_error:  # noqa: BLE001
            # Concurrent creator minted the same deterministic id — adopt it.
            if "already exist" in str(save_error).lower():
                existing = await cls.get_by_id(local_id) or await cls.get_by_prop("uname", _LOCAL_UNAME, "compute_node")
                if existing:
                    logging.info("[compute-node] @local create raced; adopting %s", existing.id)
                    return existing
            raise
        await node.set_visitor_role("owner")
        logging.info("[compute-node] created @local singleton %s mount=%s", node.id, os_root)
        return node

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

    def get_command_executor(self):
        """This node as a :class:`CommandExecutor` — argv in, exit codes and IO out.

        **The only way to obtain an executor.** Nothing else constructs one, so
        "where does this command run" is always answerable from the call site
        rather than defaulting silently to the server's own disk. Built fresh per
        call; it holds no state beyond this node.
        """
        from flow_sdk.builtin.faas.command_executor import ComputeNodeCommandExecutor  # noqa: PLC0415

        return ComputeNodeCommandExecutor(self)

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

    async def extract_zip(self, zip_path: str, dest_dir: str) -> None:
        """Extract a zip already present on this node; raise on a non-zero exit.

        The command shape (and its quoting) belongs to the provider — never
        interpolate these values into a command by hand.
        """
        await self.create_folders(dest_dir)
        cmd = await self.run_command(self.compute_provider.extract_archive_command(zip_path, dest_dir))
        await cmd.wait()
        if cmd.exit_code != 0:
            raise RuntimeError(
                f"extract_zip failed (exit {cmd.exit_code}) extracting {zip_path} into {dest_dir}: {cmd.all_stderr}"
            )

    async def copy_folder(self, local_path: str, remote_path: str) -> None:
        """Copy a local directory tree INTO this compute node at ``remote_path``.

        The canonical dir transfer: zip the tree, write the archive into the node,
        extract it, drop the archive. The zip is built off the event loop — for a
        repo-sized tree the walk + DEFLATE would otherwise stall every other
        request on this worker.
        """
        buf = await asyncio.to_thread(build_dir_zip, local_path)
        provider = self.compute_provider
        remote_zip = provider.path_join(provider.get_temp_folder(), f"flowpad-copy-{uuid.uuid4().hex}.zip")
        await self.write_files([SendFileEntry(remote_path=remote_zip, data=buf)])
        try:
            await self.extract_zip(remote_zip, remote_path)
        finally:
            try:
                await self.delete_files([remote_zip])
            except Exception:
                logging.debug("copy_folder: failed to clean up %s", remote_zip, exc_info=True)

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

        Returns a SHA256 hash of ``platform.system | platform.machine |
        OS-specific stable UUID``. **No MAC address** (it changes under
        MAC randomization, Docker veth, VPN, dock/undock) — the OS UUID
        is the stable component.

        Mirrors the OS-UUID derivation in ``flow_sdk/utils/machine_id.py``
        (Linux /etc/machine-id, macOS IOPlatformUUID, Windows MachineGuid).
        This runs a small script on the **remote** compute node, so it
        can't share code with the local helper — keep the two derivation
        sources in sync if either changes.

        Returns:
            64-character hex string representing the machine ID
        """
        machine_id_script = """
import platform, hashlib, subprocess
parts = [platform.system(), platform.machine()]
try:
    system = platform.system()
    if system == "Linux":
        for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            try:
                with open(path) as f:
                    v = f.read().strip()
                if v:
                    parts.append(v); break
            except OSError:
                continue
    elif system == "Darwin":
        out = subprocess.check_output(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]).decode()
        for line in out.splitlines():
            if "IOPlatformUUID" in line:
                pieces = line.split('"')
                if len(pieces) >= 4:
                    parts.append(pieces[3]); break
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

    async def send(self, msg_str: str) -> None:
        return await self.compute_provider.send(self.verified_node_provider_id, msg_str)

    # -- PTY actions (implementations in PtyActionsMixin) -----------------------

    # ── Attached project secrets ──────────────────────────────────────────

    def attached_env_vars(self, project_id: str, declared: list[str] | None = None) -> list[str] | None:
        """Env vars this node may see for ``project_id``.

        ``None`` means "no restriction recorded" — every declared secret. That
        is the back-compat shape: a node that predates attachment, or one nobody
        has curated, behaves exactly as before.
        """
        key = str(project_id or "")
        if not key or key not in (self.attached_secrets or {}):
            return None
        attached = self.attached_secrets[key]
        if declared is None:
            return list(attached)
        return [name for name in attached if name in declared]

    def effective_attached(self, project_id: str, declared: list[str]) -> list[str]:
        """The env vars this node may see, with "absent means all" already
        collapsed.

        The back-compat rule is the security-relevant one, so it is decoded HERE
        and nowhere else — re-deriving `declared if attached is None else attached`
        per call site is how one branch ends up letting a node see more (or less)
        than the others.
        """
        attached = self.attached_env_vars(project_id, declared)
        return list(declared) if attached is None else attached

    async def _set_attached(self, project_id: str, names: list[str]) -> None:
        current = dict(self.attached_secrets or {})
        current[str(project_id)] = sorted(set(names))
        self.attached_secrets = current
        await self.update()

    async def _project_env_vars(self, project_id: str) -> list[str]:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        try:
            project = await Project.get_by_id(str(project_id))
        except Exception:  # noqa: BLE001
            # A key left behind by a deleted project (or a malformed one) is
            # inert, not fatal — the node simply has nothing to attach for it.
            return []
        if project is None:
            return []
        return [row.get("env_var") for row in project.secret_origins if row.get("env_var")]

    async def _recurate(self, project_id: str, env_var: str, *, add: bool) -> "ApiResponse":
        """Attach or detach one secret. Both verbs are the same operation over a
        different final list, so they share the whole body."""
        project_id, env_var = str(project_id or "").strip(), str(env_var or "").strip()
        if not project_id or not env_var:
            return ApiFailResponse(message="project_id and env_var are required")
        declared = await self._project_env_vars(project_id)
        if add and env_var not in declared:
            return ApiFailResponse(message=f"{env_var} is not declared on this project")

        # First curation of a project turns the implicit "all" into an explicit
        # list, so attaching one secret does not silently detach the rest.
        base = self.effective_attached(project_id, declared)
        await self._set_attached(project_id, [*base, env_var] if add else [n for n in base if n != env_var])
        return ApiSuccessResponse(data={"attached": self.attached_env_vars(project_id, declared)})

    @action.post(action_name="attach-secret")
    async def attach_secret(self, project_id: str = "", env_var: str = "") -> "ApiResponse":
        """Let this node see one of a project's declared secrets."""
        return await self._recurate(project_id, env_var, add=True)

    @action.post(action_name="detach-secret")
    async def detach_secret(self, project_id: str = "", env_var: str = "") -> "ApiResponse":
        return await self._recurate(project_id, env_var, add=False)

    @action.post(action_name="attach-all-secrets")
    async def attach_all_secrets(self, project_id: str = "") -> "ApiResponse":
        """Attach everything the project declares RIGHT NOW.

        A snapshot, not a standing '*': a sentinel would silently widen what a
        shared node exposes every time someone declares a new secret, without
        anyone re-confirming.
        """
        project_id = str(project_id or "").strip()
        if not project_id:
            return ApiFailResponse(message="project_id is required")
        declared = await self._project_env_vars(project_id)
        await self._set_attached(project_id, declared)
        return ApiSuccessResponse(data={"attached": self.attached_env_vars(project_id, declared)})

    @action.post(action_name="list-attached-secrets")
    async def list_attached_secrets(self, project_id: str = "") -> "ApiResponse":
        """Every declared secret for the project, flagged attached or not."""
        project_id = str(project_id or "").strip()
        if not project_id:
            return ApiFailResponse(message="project_id is required")
        declared = await self._project_env_vars(project_id)
        attached = self.attached_env_vars(project_id, declared)
        allowed = set(self.effective_attached(project_id, declared))
        return ApiSuccessResponse(
            data={
                "project_id": project_id,
                # True when nothing has been curated yet — the UI shows every row
                # checked rather than pretending someone chose them.
                "all_attached": attached is None,
                "secrets": [{"env_var": name, "attached": name in allowed} for name in declared],
            }
        )

    @action.post("terminal-command")
    async def terminal_command(self):
        return await self._pty_terminal_command()

    @action.get(action_name="list-shells")
    async def _list_shells(self):
        return await self._pty_list_shells()

    @action.get(action_name="terminals")
    async def _terminals(self) -> ApiResponse:
        """``terminals/get_by_worker_id/<id>`` — resolve an AgenticProcess by its
        worker id (``AgenticProcess.getByWorkerId``). The legacy
        ``terminals/list``/``close`` shim was deleted at the Tab cutover; the
        strip lists from the ``Tab`` entity and closes via ``tabs/close``."""
        request_info = get_current_request_info()
        raw_sub_path = (request_info.sub_path or "").strip("/") if request_info else ""
        # Case-fold the ROUTE prefix only — never the id that follows it.
        # Lowercasing the whole sub-path mangled every case-sensitive session id:
        # opencode's are mixed-case (``ses_ff0351c3fffeknxcJAjTQi4uMp``), so the
        # resolver was handed an id the store had never seen and always 404'd.
        prefix = "get_by_worker_id/"
        if raw_sub_path.lower().startswith(prefix):
            worker_id = raw_sub_path[len(prefix):]
            if not worker_id:
                return ApiFailResponse(message="worker id required", status_code=400)
            return await self._scan_get_by_worker_id(worker_id)
        return ApiFailResponse(
            message=f"unknown terminals sub-path: {raw_sub_path!r}", status_code=400
        )

    @action.post(action_name="tabs")
    async def _tabs(self, background_tasks: BackgroundTasks) -> ApiResponse:
        """Compatibility router for ``/compute_node/<id>/tabs/close``.

        The frontend closes concrete chips by ``Tab.close`` now, but older
        callers and backend tests still use the batch target-close endpoint.
        Keep it as a thin wrapper over the same terminal teardown helper so
        shell/process cleanup semantics remain centralized.
        """
        request_info = get_current_request_info()
        sub_path = (request_info.sub_path or "").strip("/").lower() if request_info else ""
        if sub_path != "close":
            return ApiFailResponse(message=f"unknown tabs sub-path: {sub_path!r}", status_code=400)
        body = await request_info.get_post_data() if request_info else {}
        return await self._terminal_close(body or {}, background_tasks)

    def _parse_terminal_target(self, raw: Any) -> tuple[str, str] | None:
        """Parse a tab target (``type-id`` or ``type:id``) restricted to the
        terminal tab kinds (shell / agentic_process)."""
        if not isinstance(raw, str) or not raw.strip():
            return None
        target = raw.strip()
        try:
            if ":" in target:
                entity_type, entity_id = target.split(":", 1)
                typeid = TypeId(type=entity_type, id=entity_id) if entity_type and entity_id else None
            else:
                typeid = TypeId(target)
        except Exception:
            return None
        if typeid is None or not typeid.type or not typeid.id or typeid.type not in TERMINAL_TAB_TYPES:
            return None
        return typeid.type, typeid.id

    async def _mark_shell_closing(self, shell_id: str) -> bool:
        from flow_sdk.builtin.shell import Shell as ShellEntity
        from flow_sdk.builtin.shell import ShellStatus

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
        from flow_sdk.builtin.process_lifecycle import ProcessStatus
        from flow_sdk.builtin.shell import Shell as ShellEntity

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
                # Strip membership is the Tab entity (visible=true), not
                # AgenticProcess.visible. The stopped AP row persists, so the
                # delete→orphan-Tab cleanup never fires; hide the backing Tab
                # now (synchronously) or the chip lingers if the background
                # teardown is slow or fails.
                from flow_sdk.builtin.tab import hide_tabs_for_target

                await hide_tabs_for_target("agentic_process", entity_id)
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

        return ApiSuccessResponse(
            data={
                "accepted": accepted,
                "missing": missing,
                "invalid": invalid,
            }
        )

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

    @action.post(action_name="recover-orphaned-project")
    async def _recover_orphaned_project(self) -> ApiResponse:
        """Resurrect a deleted Project from a dependent's ``workdir`` and rebind
        every dependent's ``project_id`` to the recovered Project.

        Body: ``{ "dangling_id": "<uuid>" }``
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.builtin.project import Project
        from flow_sdk.builtin.shell import Shell as ShellEntity

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        dangling_id = (body or {}).get("dangling_id")
        if not isinstance(dangling_id, str) or not dangling_id:
            return ApiFailResponse(message="dangling_id (str) is required", status_code=400)

        existing = await Project.get_by_id(dangling_id)
        if existing is not None:
            return ApiSuccessResponse(
                data={
                    "project": existing.model_dump(mode="json"),
                    "rebound": 0,
                }
            )

        all_shells, all_processes = await asyncio.gather(
            ShellEntity.get_all(),
            AgenticProcess.get_all(),
        )
        dep_shells = [s for s in all_shells if getattr(s, "project_id", None) == dangling_id]
        dep_procs = [p for p in all_processes if getattr(p, "project_id", None) == dangling_id]
        if not dep_shells and not dep_procs:
            return ApiFailResponse(
                message=f"No dependents reference project {dangling_id}",
                status_code=404,
            )

        workdir = next(
            (getattr(d, "workdir", None) for d in (*dep_shells, *dep_procs) if getattr(d, "workdir", None)),
            None,
        )
        if not workdir:
            return ApiFailResponse(
                message="No dependent has a workdir; cannot recover project",
                status_code=422,
            )

        recovered = await Project.recover_by_path(workdir)
        if recovered is None:
            return ApiFailResponse(
                message=f"Could not recover a project for {workdir}",
                status_code=500,
            )

        rebound = 0
        if recovered.id != dangling_id:
            for s in dep_shells:
                s.project_id = recovered.id
            for p in dep_procs:
                # Force-rebind: every dep_proc here has the dangling FK and may
                # be session-bound — the polite `_bind_project_id` would be
                # silently refused by the freeze for those.
                p._force_rebind_project_id(recovered.id)
            await asyncio.gather(
                *(s.save() for s in dep_shells),
                *(p.save() for p in dep_procs),
            )
            rebound = len(dep_shells) + len(dep_procs)

        return ApiSuccessResponse(
            data={
                "project": recovered.model_dump(mode="json"),
                "rebound": rebound,
            }
        )

    @action.post(action_name="create-project-from-git")
    async def _create_project_from_git(self) -> ApiResponse:
        """Clone a GitOrigin into the desktop workspace and materialize a Project.

        Body:
            { "git_origin": {...},
              "target_name": "<optional override>" }

        Collision policy: if the derived (or supplied) folder name already
        exists under AGENT_MOUNT_FOLDER, refuse and return the next-free
        suggestion in ``data.suggested_name``. The caller re-submits with
        ``target_name`` set to accept the suggestion.
        """
        from flow_sdk.app.actions.oauth_action import _get_github_token_for_current_user
        from flow_sdk.config import AGENT_MOUNT_FOLDER
        from flow_sdk.fs_store.origin.git_origin import GitOrigin
        from flow_sdk.utils.git import derive_repo_leaf_from_url

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        raw_origin = (body or {}).get("git_origin")
        target_name = (body or {}).get("target_name")
        try:
            git_origin = GitOrigin.model_validate(raw_origin)
        except Exception:
            return ApiFailResponse(message="git_origin is required", status_code=400)
        clone_url = git_origin.clone_url()
        branch = git_origin.branch or None
        # A branch ref is passed straight into git's argv as the value of `--branch`.
        # The subprocess call is argv-style (no shell), so this is structurally
        # safe against command injection — but a malformed ref still produces a
        # confusing error, and rejecting it here keeps the failure mode clean.
        if branch is not None:
            import re as _re

            _GIT_REF_RE = _re.compile(r"^(?!-)[A-Za-z0-9._/-]+$")
            if not isinstance(branch, str) or not _GIT_REF_RE.match(branch) or ".." in branch or "@{" in branch:
                return ApiFailResponse(
                    message=f"Invalid branch name: {branch!r}",
                    status_code=400,
                )

        leaf = (target_name or derive_repo_leaf_from_url(clone_url)).strip()
        if not leaf:
            return ApiFailResponse(
                message=f"Could not derive a folder name from URL: {clone_url}",
                status_code=400,
            )

        target_dir = os.path.join(AGENT_MOUNT_FOLDER, leaf)
        suggested = self._next_free_leaf(leaf)
        if suggested != leaf:
            # The caller chose this name and it is taken — refuse; offer the
            # next-free `<leaf>-N` so the dialog can suggest it.
            return ApiFailResponse(
                message=f"'{leaf}' already exists in workspace",
                data={"suggested_name": suggested, "attempted_name": leaf},
                status_code=409,
            )

        # Same credential path `/api/v1/git/remote-access` probes with (see
        # git_remote_access) — no token → anonymous clone. The absent
        # ``target_dir`` is the driver's clone target.
        from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415

        token = await _get_github_token_for_current_user()
        try:
            await get_origin_driver(git_origin.kind).materialize(git_origin, preferred_root=Path(target_dir), token=token)
        except RuntimeError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

        from flow_sdk.builtin.agentic_process.agentic_process import _index_additional_dir  # noqa: PLC0415

        project = await self._materialize_project(target_dir)
        # The sanctioned one-shot scan, not a banned auto-walk: the user asked
        # for this clone, and it has to be searchable when they land in it.
        await _index_additional_dir(target_dir)
        return ApiSuccessResponse(data={"project": project.model_dump(mode="json")})

    @staticmethod
    def _next_free_leaf(leaf: str) -> str:
        """``leaf``, or the next ``leaf-N`` nothing has claimed at all, under
        AGENT_MOUNT_FOLDER — ``fresh_clone_slot`` without the empty-dir reuse.
        All three callers want a path that does not exist: a 409 suggestion, a
        delivered tree moved into place, and the name-availability probe."""
        from flow_sdk.fs_store.origin.git_origin import fresh_clone_slot  # noqa: PLC0415

        return fresh_clone_slot(leaf, reuse_empty=False).name

    @staticmethod
    async def _materialize_project(target_dir: str, project_id: str | None = None) -> "Project":
        """Turn an already-populated directory into a desktop Project: mint it
        and wire it to the desktop.

        Independent of HOW ``target_dir`` got its files (git clone here, or a
        hub-side clone → copy_folder transfer). Indexing is deliberately NOT
        part of it — it is its own step, so a caller driving the box can show a
        slow scan rather than have it hide inside "materializing", and nothing
        walks the tree twice.

        ``project_id`` adopts an id minted elsewhere — the hub mints the Project
        that names the engagement and this box materializes it, so one identity
        spans both sides (and every sandbox the same project is opened in).
        Callers pass an id only through ``_adopted_project_id``, which enforces
        the v4/v5 entity-id policy; a raw id is never adopted here.
        """
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        # Splatted rather than `id=project_id`: the model rejects an explicit
        # None, and "no id" has to mean "mint one".
        project = Project(name=target_dir, **({"id": project_id} if project_id else {}))
        await project.save()
        await project.setup_for_desktop()
        if project_id:
            await ComputeNode._adopt_hub_project_fields(project)
        return project

    @staticmethod
    async def _adopt_hub_project_fields(project: "Project") -> None:
        """Bring the SHARED project's own state onto this box.

        Minting above gives the row an identity and a folder — and nothing else.
        Everything the author set (the language it is worked in, its helpdesk
        config, its context folders) lives on the HUB row under the SAME id; the
        same-id invariant is what makes this a lookup rather than a guess.
        Without it the box opens a project that matches only in name — a Hebrew
        project hands its recipient an English app.

        The adopt itself is NOT reimplemented here: ``materialize_remote_
        membership_entity`` is the one seam that already mirrors a hub
        membership container locally (idempotent upsert, hub ``created_by`` and
        dates preserved through ``remote_reflection`` rather than stamped with
        the local sync user, plus context-folder and secret-origin
        materialization). This is the same adopt the invitation-accept path
        performs — a sandbox handover is the same event reached a different way,
        so it must not grow a second, subtly different copy. Which fields cross
        is that seam's ``_MIRRORED_FIELDS`` allow-list, deliberately explicit.

        Best-effort — a box with no cloud login, or an id that was never
        published, keeps the freshly minted row rather than failing a launch the
        user has already paid for.
        """
        try:
            from flow_sdk.app.actions.membership_sync import materialize_remote_membership_entity  # noqa: PLC0415
            from flow_sdk.builtin.project import Project  # noqa: PLC0415
            from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
            from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

            creds = load_credentials()
            if not creds or not creds.api_key:
                return
            async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                hub_project = await client.get(f"/graph/project/{project.id}")
            if not isinstance(hub_project, dict) or not hub_project.get("id"):
                return
            await materialize_remote_membership_entity(Project, hub_project)
        except Exception as err:  # noqa: BLE001
            logging.warning("[sandbox] could not adopt hub fields for project %s: %s", project.id, err)

    @staticmethod
    def _adopted_project_id(raw: object) -> str | None:
        """The entity-id adoption gate for an id arriving from off-box.

        Returns the id when it conforms (UUID v4/v5), ``None`` when absent.
        Raises for anything else rather than silently minting a fresh one: the
        hub asked for THIS id, and a project that comes back under a different
        one would set the default to something the hub cannot address.
        """
        from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415

        if raw in (None, ""):
            return None
        candidate = str(raw)
        if not is_valid_entity_id(candidate):
            raise ValueError(f"project_id must be a UUID v4 or v5 entity id: {candidate}")
        return candidate

    async def _place_project(self, leaf: str, raw_project_id: object, deliver) -> ApiResponse:
        """Put a project at a free slot under ``AGENT_MOUNT_FOLDER`` and mint it.

        Everything the ways of getting a project onto this box agree on: where it
        lands, that a name clash auto-suffixes rather than fails (the caller has
        already paid for a sandbox), the v4/v5 adoption gate for an id minted
        off-box, and the ``{project, path}`` answer. ``deliver`` is the only
        difference between them — move a staged tree in, or create the directory.

        ``path`` rides in the response because the caller's next step is usually
        to attach this checkout to another project as a context folder, and only
        this side knows where it landed.
        """
        from flow_sdk.config import AGENT_MOUNT_FOLDER  # noqa: PLC0415

        try:
            project_id = self._adopted_project_id(raw_project_id)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)

        target_dir = os.path.join(AGENT_MOUNT_FOLDER, self._next_free_leaf(leaf))
        deliver(target_dir)
        project = await self._materialize_project(target_dir, project_id)
        return ApiSuccessResponse(data={"project": project.model_dump(mode="json"), "path": target_dir})

    @action.post(action_name="materialize-project")
    async def _materialize_project_action(self) -> ApiResponse:
        """Materialize a Project from a directory delivered into this node (e.g.
        by the hub's setup-git via ``copy_folder`` into a staging path).

        Body: ``{ "staging_path": "<abs source dir>", "name": "<optional>",
        "project_id": "<optional uuid v4/v5>" }``. Moves the staged tree under
        ``AGENT_MOUNT_FOLDER/<leaf>`` and mints the Project — indexing is the
        caller's own step. Keeps ``AGENT_MOUNT_FOLDER`` placement on the box
        side so the hub never needs the box's home path. A name clash
        auto-suffixes (``<leaf>-N``) rather than 409-ing: the launch path has
        already committed to a desktop, so failing it over a folder name would
        strand the user.

        ``path`` rides in the response next to the project because the caller's
        next step is usually to attach this checkout to another project as a
        context folder, and only this side knows where it landed.
        """
        import shutil  # noqa: PLC0415

        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else {}) or {}
        staging_path = body.get("staging_path")
        if not staging_path or not os.path.isdir(staging_path):
            return ApiFailResponse(
                message="staging_path is required and must be an existing directory", status_code=400
            )
        leaf = (str(body.get("name") or os.path.basename(staging_path.rstrip("/")))).strip()
        if not leaf:
            return ApiFailResponse(message="could not derive a project name", status_code=400)

        def deliver(target_dir: str) -> None:
            os.makedirs(os.path.dirname(target_dir), exist_ok=True)
            shutil.move(staging_path, target_dir)

        return await self._place_project(leaf, body.get("project_id"), deliver)

    @action.post(action_name="init-empty-project")
    async def _init_empty_project_action(self) -> ApiResponse:
        """Mount a project on this node that has no repository behind it.

        Body: ``{ "name": "<leaf>", "project_id": "<optional uuid v4/v5>" }`` →
        ``{ project, path }`` — the same shape ``materialize-project`` answers
        with, so a caller sequences the two identically.

        The sibling of materialize for a project that was never cloned from
        anywhere: same placement, same adoption gate, same minting; it creates
        the directory instead of moving a delivered tree, and runs no index —
        there is nothing in it yet to find.

        The identity is what makes this more than ``mkdir``. A project's id is
        resolved from the record whose canonical cwd matches the path (see
        ``project_type_info``: ``derived_identity(existing_project_record_id)``),
        so minting the row against this directory is what makes a later scan of
        it resolve to THIS project rather than mint a second one.
        """
        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else {}) or {}
        leaf = str(body.get("name") or "").strip()
        if not leaf:
            return ApiFailResponse(message="name is required", status_code=400)

        # `_next_free_leaf` already proved the path is free, so this only has to
        # create it (parents included).
        return await self._place_project(leaf, body.get("project_id"), lambda target_dir: os.makedirs(target_dir))

    @action.post(action_name="validate-project-name")
    async def _validate_project_name_action(self) -> ApiResponse:
        """Is this project name free on this node, and if not, what is?

        Body: ``{ "name": "<leaf>" }`` → ``{ available, suggested }``.

        Pure question, no side effects: a provisioning caller asks BEFORE it
        clones so the user can pick another name while it is still cheap, rather
        than discovering the clash after a repo has already been copied in.
        ``suggested`` is the same ``<leaf>-N`` the materialize path would take.
        """
        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else {}) or {}
        name = str(body.get("name") or "").strip()
        if not name:
            return ApiFailResponse(message="name is required", status_code=400)

        suggested = self._next_free_leaf(name)
        return ApiSuccessResponse(data={"available": suggested == name, "suggested": suggested})

    @action.post(action_name="set-default-project")
    async def _set_default_project_action(self) -> ApiResponse:
        """Name the project this box should OPEN on, for the next bootstrap only.

        Body: ``{ "project_id": "<uuid v4/v5>" }``.

        The provisioning side (today: the hub, after cloning a repo in) is the
        only one that knows which of several projects the user actually asked
        for. It is an opening instruction, not a stored preference: bootstrap
        hands it out once and forgets it, so a later refresh cannot re-assert it
        over whatever the user has since selected.

        Called AGAIN, by the hub, whenever it hands the box to someone it has not
        sent there yet — a shared sandbox's second reader is invisible from here
        (one gate secret, every visitor). See ``flow_sdk/server/state.py`` and
        ``ComputeNode._rearm_opening_project_for`` on the hub.
        """
        from flow_sdk.server.state import set_pending_default_project  # noqa: PLC0415

        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else {}) or {}
        try:
            project_id = self._adopted_project_id(body.get("project_id"))
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        if not project_id:
            return ApiFailResponse(message="project_id is required", status_code=400)

        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        # Refuse an id this box doesn't have: bootstrap would silently drop it,
        # and the caller would believe the sandbox was going to open there.
        project = await Project.get_by_id(project_id)
        if project is None:
            return ApiFailResponse(message=f"No project {project_id} on this node", status_code=404)

        set_pending_default_project(project_id)
        logging.info(f"[provisioning] next bootstrap will open project {project_id}")
        return ApiSuccessResponse(data={"project_id": project_id})

    @action.all(action_name="llm-endpoint", methods=["get", "post", "delete"])
    async def _llm_endpoint_action(self) -> ApiResponse:
        """GET status / POST bind / DELETE unbind of the hub ``LLMEndpoint`` this box's
        harnesses route through -- see ``cli_drivers/hub_endpoint_binding`` for the
        payload and status shapes. The hub calls this right after a verified login."""
        from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (  # noqa: PLC0415
            HubEndpointBindError,
            bind_hub_llm_endpoint,
            hub_llm_endpoint_status,
            select_llm_source,
            unbind_hub_llm_endpoint,
        )

        request_info = get_current_request_info()
        method = (request_info.request.method if request_info and request_info.request else "GET").upper()
        try:
            if method == "GET":
                return ApiSuccessResponse(data=await hub_llm_endpoint_status())
            if method == "POST":
                body = (await request_info.get_post_data() if request_info else {}) or {}
                # ``select`` is the USER picking a source; the bare POST is the HUB binding this
                # box and 409s without a hub key. Keeping them apart is what lets someone choose
                # their own OpenRouter key on a box that has never talked to a hub.
                if (request_info.sub_path or "").strip("/") == "select":
                    return ApiSuccessResponse(data=await select_llm_source(body))
                return ApiSuccessResponse(data=await bind_hub_llm_endpoint(body))
            if method == "DELETE":
                return ApiSuccessResponse(data=await unbind_hub_llm_endpoint())
            return ApiFailResponse(message=f"Method {method} not supported", status_code=405)
        except HubEndpointBindError as exc:
            return ApiFailResponse(message=str(exc), status_code=exc.status_code)

    @action.post(action_name="find-local-repo")
    async def _find_local_repo(self) -> ApiResponse:
        """Locate a local clone whose ``origin`` matches a GitOrigin.

        Body: ``{ "git_origin": {...} }``. Returns
        ``{ found: bool, local_path: str | null }``. The url-only counterpart of
        the task-scoped ``find-project`` endpoint — lets the receiver of a shared
        repo attach to a clone they already have instead of re-cloning it.
        """
        from flow_sdk.fs_store.origin.git_origin import GitOrigin
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        try:
            git_origin = GitOrigin.model_validate((body or {}).get("git_origin"))
        except Exception:
            return ApiFailResponse(message="git_origin is required", status_code=400)
        local = git_origin.local_checkout()
        return ApiSuccessResponse(data={"found": local is not None, "local_path": str(local) if local else None})

    @action.get(action_name="session-transcript")
    async def _session_transcript(self):
        return await self._pty_session_transcript()

    @action.get(action_name="session-transcript-raw")
    async def _session_transcript_raw(self):
        return await self._pty_session_transcript_raw()

    @action.get(action_name="discovery")
    async def _discovery_action(self):
        return await self._pty_discovery_action()

    @action.post(action_name="reset-pty")
    async def reset_pty(self):
        return await self._pty_reset_pty()

    @action.post(action_name="update-shell")
    async def _update_shell(self):
        return await self._pty_update_shell()

    @action.post("ops")
    async def ops(self):
        return await self._ops_dispatch()

    # -- ops actions -------------------------------------------------------------

    @action.all(action_name="get-host")
    def get_host_action(self, port: int, redirect: bool = True):
        return self._desktop_get_host(port, redirect)

    @action.all(action_name="get-machine-status")
    async def get_machine_status_action(self):
        return await self._desktop_get_machine_status()

    @action.all(action_name="get-system-profile")
    async def get_system_profile_action(self):
        return await self._desktop_get_system_profile()

    @action.post(action_name="open-external")
    async def open_external_action(self):
        return await self._desktop_open_external()

    @action.post(action_name="open-terminal")
    async def open_terminal_action(self):
        return await self._desktop_open_terminal()

    @action.post(action_name="pick-folder")
    async def pick_folder_action(self):
        return await self._desktop_pick_folder()

    @action.all(action_name="get-json-file")
    async def get_json_file_action(self):
        return await self._desktop_get_json_file()

    @action.post(action_name="save-json-file")
    async def save_json_file_action(self):
        return await self._desktop_save_json_file()

    @action.post(action_name="generate-amd-plan")
    async def generate_amd_plan_action(self):
        return await self._desktop_generate_amd_plan()

    @action.all(action_name="scan-resources")
    async def scan_resources_action(self):
        return await self._scan_resources()

    @action.all(action_name="get-resource-summary")
    async def get_resource_summary_action(self):
        return await self._scan_get_resource_summary()

    @action.all(action_name="scan-item")
    async def scan_item_action(self):
        return await self._scan_item()

    @action.all(action_name="get-cost-overview")
    async def get_cost_overview_action(self):
        return await self._analytics_cost_overview()

    @action.all(action_name="get-claude-context")
    async def get_claude_context_action(self):
        return await self._analytics_claude_context()

    @action.all(action_name="clear-skill-usage")
    async def clear_skill_usage_action(self):
        return await self._scan_clear_skill_usage()

    @action.all(action_name="clear-cli-log")
    async def clear_cli_log_action(self):
        return await self._scan_clear_cli_log()

    @action.all(action_name="list-projects")
    async def list_projects_action(self):
        return await self._scan_list_projects()

    @action.all(action_name="scan-project")
    async def scan_project_action(self):
        return await self._scan_project()

    @action.post(action_name="createProcess")
    async def create_process_action(self):
        return await self._scan_create_process()

    @action.post(action_name="upsertSessionProcess")
    async def upsert_session_process(self):
        return await self._scan_upsert_session_process()

    @action.get(action_name="findSession")
    async def find_session(self):
        return await self._scan_find_session()

    @action.post(action_name="os-status-batch")
    async def _os_status_batch(self) -> ApiResponse:
        """Batched os-status snapshot for many AgenticProcesses.

        Collapses what would otherwise be N parallel GETs (the SDK's
        per-process auto-recovery sweep) into a single round-trip. Each
        per-process payload is identical to what the per-AP ``os-status``
        action returns; the SDK fans the results back out to each
        ``AgenticProcess`` instance to drive ``reconnect()`` decisions.

        Body: ``{ "process_ids": ["<id>", ...] }``
        Response: ``{ "statuses": { "<id>": <payload>, ... }, "missing": [...] }``
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        raw_ids = body.get("process_ids") if isinstance(body, dict) else None
        if not isinstance(raw_ids, list):
            return ApiFailResponse(
                message="os-status-batch requires body: { process_ids: string[] }",
                status_code=400,
            )

        # De-dup + drop empties without changing input order.
        seen: set[str] = set()
        ids: list[str] = []
        for raw in raw_ids:
            if not isinstance(raw, str) or not raw:
                continue
            if raw in seen:
                continue
            seen.add(raw)
            ids.append(raw)

        if not ids:
            return ApiSuccessResponse(data={"statuses": {}, "missing": []})

        fetched = await asyncio.gather(
            *(AgenticProcess.get_by_id(i) for i in ids),
            return_exceptions=True,
        )

        missing: list[str] = []
        resolved: list[tuple[str, AgenticProcess]] = []
        for pid, proc in zip(ids, fetched):
            if isinstance(proc, Exception) or proc is None:
                missing.append(pid)
            else:
                resolved.append((pid, proc))

        payloads = await asyncio.gather(
            *(proc._collect_os_status_payload() for _, proc in resolved),
            return_exceptions=True,
        )

        statuses: dict[str, dict] = {}
        for (pid, _), payload in zip(resolved, payloads):
            if isinstance(payload, Exception):
                missing.append(pid)
                continue
            statuses[pid] = payload

        return ApiSuccessResponse(data={"statuses": statuses, "missing": missing})

    # -- fs-records action (implementation in FsRecordsActionsMixin) -------------

    @action.all(action_name="fs-records", methods=["get", "post", "put", "delete"])
    async def fs_records_action(self):
        return await self._fs_records_action()

    @action.get(action_name="asset-usage")
    async def asset_usage_action(self) -> ApiResponse:
        """GET /asset-usage?skill=<name> — sessions in which this asset was used
        (FSIndexer scan of transcripts + analyzer). Powers the asset IDE usage tab."""
        return await self._handle_asset_usage(get_current_request_info())

    @action.post(action_name="commit-asset")
    async def commit_asset_action(self) -> ApiResponse:
        """POST /commit-asset {workdir, file} — version-bump + commit an asset
        edited on disk (the cycle's commit step). Returns {committed, hash?, version?}."""
        return await self._handle_commit_asset(get_current_request_info())

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
        from flow_sdk.fs_store.operations.claude_error import ErrorStatus, Fix, get_by_fingerprint

        if not results:
            return

        now = datetime.now(timezone.utc).isoformat()

        for r in results:
            fp = r.get("fingerprint", "")
            if not fp:
                continue
            rec = get_by_fingerprint(fp)
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
        from flow_sdk.builtin.agent_registry import get_agent_local_deployment
        from flow_sdk.fs_store.operations.claude_error import Fix, get_by_fingerprint

        request_info = get_current_request_info()
        body = await request_info.get_post_data()
        fingerprints = body.get("fingerprints", [])
        if not fingerprints:
            return ApiFailResponse(message="fingerprints is required")

        # Loop-invariant: resolving the agent costs a lookup and a deployment
        # upsert, so it happens once rather than once per fingerprint.
        deployment = await get_agent_local_deployment("cloud-error-fixer")
        spawned = []
        for fp in fingerprints:
            rec = get_by_fingerprint(fp)
            fix = getattr(rec, "fix", None)
            fix_instruction = fix.instruction if isinstance(fix, Fix) else ""
            if rec is None or not fix_instruction:
                spawned.append({"fingerprint": fp, "status": "skipped"})
                continue
            try:
                rec_label = (getattr(rec, "name", None) or "").strip()
                # Identity from the named `cloud-error-fixer` Agent; the run
                # itself still goes through .open(), which is what attaches the
                # Shell the caller reports back as shell_id.
                agentic_process = await deployment.create_process(
                    fix_instruction,
                    name=f"Fix: {rec_label}" if rec_label else "Cloud fix",
                )
                await agentic_process.save(owner=request_info.someone_typeid if request_info else None)
                await agentic_process.open(instruction=fix_instruction)
                shell_id = agentic_process.shell_id or ""
                spawned.append(
                    {
                        "fingerprint": fp,
                        "status": "spawned",
                        "shell_id": shell_id,
                        "worker_session_id": agentic_process.worker_session_id or "",
                    }
                )
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
        from flow_sdk.builtin.worker_history import get_worker_history

        request_info = get_current_request_info()
        limit_raw = request_info.get_param("limit") if request_info else None
        try:
            limit = int(limit_raw) if limit_raw else 10
        except (TypeError, ValueError):
            limit = 10
        # Optional active scope — a comma-separated list of project_ids. When
        # present the limit is applied per-project, so a scoped client sees that
        # project's sessions instead of whatever survived a global top-N cut.
        project_ids_raw = request_info.get_param("project_ids") if request_info else None
        project_ids = {p for p in project_ids_raw.split(",") if p.strip()} if project_ids_raw else None
        entries = await get_worker_history(limit, project_ids)
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
        return await self._git_ops_dispatch(method="GET")

    @action.post(action_name="git-ops")
    async def git_ops_post_action(self) -> ApiResponse:
        """Mutating git operations (e.g. ``push``). Delegates to GitRepo.dispatch().

        Routing (via sub_path):
            POST /git-ops/push          body { workdir } → commit-all + pull --rebase + push
            POST /git-ops/init          body { workdir } → git init + Flowpad config (idempotent)
            POST /git-ops/restore-file  { workdir, file, hash } → checkout file at revision
            POST /git-ops/discard-file  { workdir, file, status } → undo a file's pending change
            POST /git-ops/stage-file    { workdir, file } → stage just this file
            POST /git-ops/unstage-file  { workdir, file } → unstage just this file
        """
        return await self._git_ops_dispatch(method="POST")

    async def _git_ops_dispatch(self, method: str) -> ApiResponse:
        """Shared git-ops gateway. Reads params from BOTH the query string and the
        request body, because the action registry routes every git-ops request
        (GET and POST) through a single handler — params like ``file``/``hash``
        arrive on the query string for reads and in the body for mutations, and
        either must reach ``GitRepo.dispatch``. The real HTTP method (not the
        decorator's) gates mutating sub-paths.
        """
        request_info = get_current_request_info()
        segments = [s for s in (request_info.sub_path or "").strip("/").split("/") if s]
        body = {}
        if request_info:
            try:
                body = (await request_info.get_post_data()) or {}
            except Exception:  # noqa: BLE001 — GET requests have no JSON body
                body = {}
        # query ∪ body (body wins on conflict); covers reads and mutations alike.
        params = {**(request_info.request_parameters or {}), **(body or {})} if request_info else {}
        workdir = params.get("workdir")
        if not workdir:
            return ApiFailResponse(message="workdir parameter is required")
        real_method = request_info.request.method if request_info and request_info.request else method
        query_params = {k: v for k, v in params.items() if k != "workdir"}
        from flow_sdk.builtin.faas.git_repo import GitRepo

        return await GitRepo(workdir, self).dispatch(segments[0] if segments else "", query_params, method=real_method)

    @asynccontextmanager
    async def ready_session(self):
        """Bring the node up. Deliberately does NO secret work in any branch.

        Loading is bound to Project.initialize, not to a state transition.
        Resolving again on resume would be exactly the re-resolution "trust what
        is there" rules out — and there is nothing on the node to refresh
        anyway, since values are only ever a per-command prefix.
        """
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
