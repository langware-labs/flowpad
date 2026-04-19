"""DockerComputeProvider — proxies PTY actions to an in-container flow_sdk worker.

The worker dials OUT to the outer server and registers in `docker_registry`.
This provider looks up the live WorkerConn by machine_id (= ComputeNode's
node_provider_id) and sends the existing `rest_api_msg` envelope carrying
`action="terminal-command"` + sub_path. Output bytes arrive back as
`pty_output_msg` frames, decoded and routed to the registered on_output
callback.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from io import BytesIO
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Literal, Optional

from flow_sdk.compute.providers.compute_provider import ComputeProvider, ListDirItem
from flow_sdk.flowpad_types import CLICommand, SendFileEntry

from . import docker_registry
from .docker_registry import ACTION_TIMEOUT_FAST, ACTION_TIMEOUT_NORMAL

if TYPE_CHECKING:
    from flow_sdk.flowpad_types.runtime_environment import RuntimeEnvironment

service_log = logging.getLogger(__name__)


class DockerComputeProvider(ComputeProvider):
    """Compute provider that proxies to a Docker container running flow_sdk."""

    path_sep = "/"
    default_working_dir = "/root"

    # ---------------------------------------------------------------- node lifecycle

    async def create_node(self, name: str, runtime: "RuntimeEnvironment", node_size: Any = None) -> str:
        raise NotImplementedError(
            "DockerComputeProvider.create_node: containers are managed externally via `flow compute connect`"
        )

    async def startup(self, provider_node_id: str, config: Optional[dict] = None) -> bool:
        return True

    async def shutdown(self, provider_node_id: str) -> None:
        conn = docker_registry.get(provider_node_id)
        if conn is None:
            return
        shell_ids = conn.active_shell_ids()
        if shell_ids:
            await asyncio.gather(
                *(conn.send_action("terminal-command", "close", {"shell_id": sid}, timeout=ACTION_TIMEOUT_FAST)
                  for sid in shell_ids),
                return_exceptions=True,
            )
        await docker_registry.unregister(provider_node_id)

    async def pause(self, provider_node_id: str) -> None:
        pass

    async def resume(self, provider_node_id: str) -> None:
        pass

    async def get_node_status(self, provider_node_id: str) -> Any:
        from flow_sdk.config import ExecutionEnvironmentStatus
        return (ExecutionEnvironmentStatus.READY
                if docker_registry.get(provider_node_id)
                else ExecutionEnvironmentStatus.STOPPED)

    async def get_machine_status(self, provider_node_id: str) -> dict:
        return {}

    def get_host(self, provider_node_id: str, port: int) -> str:
        raise NotImplementedError("DockerComputeProvider.get_host")

    def get_template_version(self) -> Optional[str]:
        return None

    # ---------------------------------------------------------------- PTY

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
        conn = docker_registry.get(provider_node_id)
        if conn is None:
            raise RuntimeError(
                f"Docker worker not connected for node {provider_node_id}. "
                f"Start the worker: docker exec -d <container> flow compute worker"
            )

        conn.register_pty(session_id, on_output)
        try:
            result = await conn.send_action("terminal-command", "start", {
                "shell_id": session_id,
                "rows": rows,
                "cols": cols,
                "working_dir": working_dir,
                "spawn_args": spawn_args,
                "extra_env": extra_env,
            })
        except Exception:
            conn.unregister_pty(session_id)
            raise

        pid = result.get("pid") if isinstance(result, dict) else None
        return {"pid": pid, "provider": "docker", "container": conn.container_name}

    async def send_pty_input(
        self, provider_node_id: str, session_id: str, data: bytes, cols: int, rows: int,
    ) -> None:
        conn = docker_registry.get(provider_node_id)
        if conn is None:
            raise RuntimeError(f"PTY session not found for {provider_node_id}:{session_id}")
        await conn.send_action("terminal-command", "input", {
            "shell_id": session_id,
            "data": base64.b64encode(data).decode(),
            "cols": cols,
            "rows": rows,
        }, timeout=ACTION_TIMEOUT_FAST)

    async def resize_pty(
        self, provider_node_id: str, session_id: str, cols: int, rows: int,
    ) -> None:
        conn = docker_registry.get(provider_node_id)
        if conn is None:
            raise RuntimeError(f"PTY session not found for {provider_node_id}:{session_id}")
        await conn.send_action("terminal-command", "resize", {
            "shell_id": session_id,
            "cols": cols,
            "rows": rows,
        }, timeout=ACTION_TIMEOUT_FAST)

    def is_pty_alive(self, provider_node_id: str, session_id: str) -> bool:
        conn = docker_registry.get(provider_node_id)
        return conn is not None and conn.is_pty_alive(session_id)

    async def close_pty_session(self, provider_node_id: str, session_id: str) -> None:
        conn = docker_registry.get(provider_node_id)
        if conn is None:
            return
        try:
            await conn.send_action("terminal-command", "close", {"shell_id": session_id}, timeout=ACTION_TIMEOUT_FAST)
        except Exception as e:
            service_log.warning(f"[Docker] close_pty_session failed: {e}")
        conn.unregister_pty(session_id)

    def get_pty_session(self, cn_id: str, shell_id: str):
        from flow_sdk.compute.providers.desktop.pty_replay_buffer import replay_buffer
        from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager

        from .docker_pty_session import DockerPtySession

        # Each live worker's machine_id is also its pn_id — probe the small set
        # of registered workers first (O(workers), typically 1–2) and bail out
        # to a scan only if none matches. Avoids the per-call linear scan over
        # every PTY session in the process.
        for machine_id in docker_registry._workers:
            key = (cn_id, machine_id, shell_id)
            if key in session_manager.sessions:
                return DockerPtySession(cn_id, machine_id, shell_id, self, session_manager, replay_buffer)
        for key in session_manager.sessions:
            if key[0] == cn_id and key[2] == shell_id:
                return DockerPtySession(key[0], key[1], key[2], self, session_manager, replay_buffer)
        return None

    # ---------------------------------------------------------------- FS (M2 stubs)

    async def exists(self, provider_node_id: str, remote_paths: str | list[str]) -> bool:
        raise NotImplementedError("DockerComputeProvider.exists")

    async def write_files(
        self,
        provider_node_id: str,
        remote_path_or_files: str | list[SendFileEntry],
        data_or_local_path: str | bytes | BytesIO | None = None,
    ) -> list[str]:
        raise NotImplementedError("DockerComputeProvider.write_files")

    async def read_files(
        self,
        provider_node_id: str,
        remote_paths: str | list[str],
        file_format: Literal["text", "stream"] = "text",
    ) -> dict[str, str] | dict[str, AsyncIterator[bytes]]:
        raise NotImplementedError("DockerComputeProvider.read_files")

    async def list_dir(
        self, provider_node_id: str, remote_paths: str | list[str],
    ) -> dict[str, list[ListDirItem]]:
        raise NotImplementedError("DockerComputeProvider.list_dir")

    async def delete_files(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        raise NotImplementedError("DockerComputeProvider.delete_files")

    async def create_folders(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        raise NotImplementedError("DockerComputeProvider.create_folders")

    async def set_env(self, provider_node_id: str, name: str, value: Optional[str]) -> None:
        raise NotImplementedError("DockerComputeProvider.set_env")

    async def run_command(
        self,
        provider_node_id: str,
        command: str,
        session_id: Optional[str] = None,
        background: bool = False,
        env: Optional[dict[str, str]] = None,
    ) -> CLICommand:
        raise NotImplementedError("DockerComputeProvider.run_command")
