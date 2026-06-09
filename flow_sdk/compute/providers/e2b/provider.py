"""E2B cloud-sandbox compute provider.

Ported from the legacy flowpad/hub/core/faas/compute/providers/e2b_provider.py
into flow_sdk. Implements the same ComputeProvider ABC as LocalComputeProvider so
PTY routing, replay buffer, and websocket plumbing all work unchanged.

Lifecycle: one E2B Sandbox per ComputeNode (provider_node_id), shared by all
PTY sessions on that node. Sandbox is killed when the last PTY closes.
"""
from __future__ import annotations

import asyncio
import logging
import os
from io import BytesIO
from typing import Any, AsyncIterator, Callable, Literal, Optional, cast

from flow_sdk.compute.providers.compute_provider import (
    ComputeProvider,
    ListDirItem,
    get_remote_paths_and_data_for_files,
)
from flow_sdk.flowpad_types import (
    CLICommand,
    ExecutionEnvironmentStatus,
    RuntimeEnvironment,
    SendFileEntry,
)

try:
    from e2b import AsyncSandbox, CommandExitException, PtySize, SandboxState
    from e2b.sandbox.filesystem.filesystem import FileType, WriteEntry

    E2B_AVAILABLE = True
except ImportError:
    AsyncSandbox = None  # type: ignore[assignment,misc]
    CommandExitException = Exception  # type: ignore[assignment,misc]
    PtySize = None  # type: ignore[assignment,misc]
    SandboxState = None  # type: ignore[assignment,misc]
    FileType = None  # type: ignore[assignment,misc]
    WriteEntry = None  # type: ignore[assignment,misc]
    E2B_AVAILABLE = False


service_log = logging.getLogger(__name__)

E2B_API_KEY_ENV = "E2B_KEY"
# E2B kills idle sandboxes after this many seconds. The keepalive task below
# extends it well before expiry, so the value just needs to be a comfortable
# margin > KEEPALIVE_INTERVAL.
E2B_SANDBOX_LIVE_TIMEOUT = 1800  # 30 min
E2B_KEEPALIVE_INTERVAL = 600     # extend timeout every 10 min
E2B_HOME_PATH = "/home/user"


def get_e2b_api_key() -> str | None:
    return os.getenv(E2B_API_KEY_ENV)


class E2BComputeProvider(ComputeProvider):
    """Compute provider backed by E2B cloud sandboxes.

    One AsyncSandbox per provider_node_id (the ComputeNode's node_provider_id).
    Multiple PTY sessions reuse the same sandbox via repeated sandbox.pty.create().
    """

    default_working_dir: str = E2B_HOME_PATH

    @property
    def path_sep(self) -> str:
        return "/"

    def __init__(self):
        super().__init__()
        if not E2B_AVAILABLE:
            raise RuntimeError(
                "E2B SDK not installed. Install with: pip install e2b"
            )
        self._sandboxes: dict[str, AsyncSandbox] = {}
        # (provider_node_id, session_id) -> {"sandbox", "pty", "running", "on_output", "rows", "cols"}
        self._pty_processes: dict[tuple[str, str], dict[str, Any]] = {}
        # provider_node_id -> background asyncio.Task that periodically extends
        # the sandbox timeout. Cancelled in shutdown().
        self._keepalive_tasks: dict[str, asyncio.Task] = {}

    # ---------------------------------------------------------------- lifecycle

    async def reset(self) -> None:
        for pty_info in self._pty_processes.values():
            pty_info["running"]["value"] = False
        self._pty_processes.clear()

        for task in self._keepalive_tasks.values():
            if not task.done():
                task.cancel()
        self._keepalive_tasks.clear()

        for sandbox in list(self._sandboxes.values()):
            try:
                await sandbox.kill()
            except Exception as e:
                service_log.warning(f"[E2B] Error killing sandbox during reset: {e}")
        self._sandboxes.clear()

    async def create_node(self, name: str, runtime: RuntimeEnvironment, node_size: Any = None) -> str:
        api_key = get_e2b_api_key()
        if not api_key:
            raise RuntimeError(f"{E2B_API_KEY_ENV} not set")
        try:
            sandbox = await AsyncSandbox.create(
                timeout=E2B_SANDBOX_LIVE_TIMEOUT,
                api_key=api_key,
                metadata={"environment": "desktop"},
            )
            self._sandboxes[sandbox.sandbox_id] = sandbox
            return sandbox.sandbox_id
        except Exception as e:
            service_log.error(f"[E2B] Failed to create sandbox: {e}")
            raise

    async def startup(self, provider_node_id: str, config: Optional[dict] = None) -> bool:
        # provider_node_id is opaque for E2B (lazy boot). For the @sandbox
        # ComputeNode we don't have a real sandbox_id at registration time —
        # the sandbox is created on first PTY attach. Treat startup as a no-op.
        return True

    async def shutdown(self, provider_node_id: str) -> None:
        task = self._keepalive_tasks.pop(provider_node_id, None)
        if task and not task.done():
            task.cancel()
        sandbox = self._sandboxes.pop(provider_node_id, None)
        if sandbox is not None:
            try:
                await sandbox.kill()
                service_log.info(f"[E2B] Sandbox {sandbox.sandbox_id} killed")
            except Exception as e:
                service_log.warning(f"[E2B] Error killing sandbox {provider_node_id}: {e}")

    async def pause(self, provider_node_id: str) -> None:
        # Not supported in MVP.
        return None

    async def resume(self, provider_node_id: str) -> None:
        # Not supported in MVP.
        return None

    async def get_node_status(self, provider_node_id: str) -> ExecutionEnvironmentStatus:
        # If we never booted a sandbox for this node, treat as READY (lazy boot).
        sandbox = self._sandboxes.get(provider_node_id)
        if sandbox is None:
            return ExecutionEnvironmentStatus.READY
        try:
            info = await AsyncSandbox.get_info(
                sandbox_id=sandbox.sandbox_id,
                api_key=get_e2b_api_key(),
            )
            if info.state == SandboxState.RUNNING:
                return ExecutionEnvironmentStatus.READY
            return ExecutionEnvironmentStatus.PAUSED
        except Exception as e:
            error_msg = str(e).lower()
            if "not found" in error_msg or "404" in error_msg:
                return ExecutionEnvironmentStatus.NOT_FOUND
            service_log.error(f"[E2B] Error getting status for {provider_node_id}: {e}")
            return ExecutionEnvironmentStatus.ERROR

    async def get_machine_status(self, provider_node_id: str) -> dict:
        # Minimal stub; E2B exposes metrics separately. Return empty for now.
        return {}

    # ---------------------------------------------------------------- networking

    def get_host(self, provider_node_id: str, port: int) -> str:
        sandbox = self._sandboxes.get(provider_node_id)
        sandbox_id = sandbox.sandbox_id if sandbox is not None else provider_node_id
        return f"https://{port}-{sandbox_id}.e2b.dev"

    # ---------------------------------------------------------------- helpers

    async def _get_or_boot_sandbox(self, provider_node_id: str) -> AsyncSandbox:
        """Return a running sandbox for this node, booting one if needed.

        Validates a cached sandbox is still alive before returning it; if E2B
        has reaped it (timeout / external kill), drops the stale ref and boots
        a fresh one so callers never get back a dead sandbox.
        """
        sandbox = self._sandboxes.get(provider_node_id)
        if sandbox is not None:
            try:
                info = await AsyncSandbox.get_info(
                    sandbox_id=sandbox.sandbox_id,
                    api_key=get_e2b_api_key(),
                )
                if info.state == SandboxState.RUNNING:
                    return sandbox
                service_log.warning(
                    f"[E2B] Cached sandbox {sandbox.sandbox_id} is in state {info.state}; rebooting"
                )
            except Exception as e:
                service_log.warning(
                    f"[E2B] Cached sandbox {sandbox.sandbox_id} unreachable ({e}); rebooting"
                )
            # Drop stale ref + cancel its keepalive
            self._sandboxes.pop(provider_node_id, None)
            task = self._keepalive_tasks.pop(provider_node_id, None)
            if task and not task.done():
                task.cancel()

        api_key = get_e2b_api_key()
        if not api_key:
            raise RuntimeError(f"{E2B_API_KEY_ENV} not set")

        sandbox = await AsyncSandbox.create(
            timeout=E2B_SANDBOX_LIVE_TIMEOUT,
            api_key=api_key,
            metadata={"environment": "desktop"},
        )
        service_log.info(
            f"[E2B] Sandbox booted for node {provider_node_id}: {sandbox.sandbox_id}"
        )
        self._sandboxes[provider_node_id] = sandbox
        # Start a keepalive task that extends the sandbox timeout periodically
        # so it doesn't get reaped during a long terminal session.
        self._keepalive_tasks[provider_node_id] = asyncio.create_task(
            self._keepalive_loop(provider_node_id, sandbox.sandbox_id),
            name=f"e2b_keepalive_{provider_node_id}",
        )
        return sandbox

    async def _keepalive_loop(self, provider_node_id: str, sandbox_id: str) -> None:
        """Periodically extend the sandbox's auto-kill timeout."""
        try:
            while True:
                await asyncio.sleep(E2B_KEEPALIVE_INTERVAL)
                sandbox = self._sandboxes.get(provider_node_id)
                if sandbox is None or sandbox.sandbox_id != sandbox_id:
                    return  # sandbox was rotated; let the new task take over
                try:
                    await sandbox.set_timeout(E2B_SANDBOX_LIVE_TIMEOUT)
                    service_log.debug(
                        f"[E2B] Keepalive extended timeout to {E2B_SANDBOX_LIVE_TIMEOUT}s for {sandbox_id}"
                    )
                except Exception as e:
                    service_log.warning(f"[E2B] Keepalive failed for {sandbox_id}: {e}")
        except asyncio.CancelledError:
            pass

    # ---------------------------------------------------------------- files

    async def exists(self, provider_node_id: str, remote_paths: str | list[str]) -> bool:
        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]
        return all(await asyncio.gather(*(sandbox.files.exists(p) for p in remote_paths)))

    async def write_files(
        self,
        provider_node_id: str,
        remote_path_or_files: str | list[SendFileEntry],
        data_or_local_path: str | bytes | BytesIO | None = None,
    ) -> list[str]:
        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        remote_paths, remote_data = get_remote_paths_and_data_for_files(
            remote_path_or_files, data_or_local_path
        )
        write_entries = [
            cast(WriteEntry, {"path": p, "data": d}) for p, d in zip(remote_paths, remote_data)
        ]
        await sandbox.files.write_files(write_entries)
        return remote_paths

    async def read_files(
        self,
        provider_node_id: str,
        remote_paths: str | list[str],
        file_format: Literal["text", "stream"] = "text",
    ) -> dict[str, str] | dict[str, AsyncIterator[bytes]]:
        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]
        try:
            content = await asyncio.gather(
                *(sandbox.files.read(p, format=file_format) for p in remote_paths)
            )
            return {p: c for p, c in zip(remote_paths, content)}
        except Exception as e:
            raise FileNotFoundError(f"Error reading files {remote_paths}: {e}")

    async def list_dir(
        self, provider_node_id: str, remote_paths: str | list[str]
    ) -> dict[str, list[ListDirItem]]:
        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]
        try:
            list_dir_entries = await asyncio.gather(*(sandbox.files.list(p) for p in remote_paths))
            result: dict[str, list[ListDirItem]] = {}
            for path, entries in zip(remote_paths, list_dir_entries):
                base_path = path.rstrip("/")
                result[path] = [
                    ListDirItem(
                        name=entry.name,
                        remote_path=f"{base_path}/{entry.name}" if base_path else entry.name,
                        is_dir=entry.type == FileType.DIR,
                    )
                    for entry in entries
                ]
            return result
        except Exception as e:
            raise FileNotFoundError(f"Error listing dirs {remote_paths}: {e}")

    async def delete_files(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]
        await asyncio.gather(*(sandbox.files.remove(p) for p in remote_paths))

    async def create_folders(self, provider_node_id: str, remote_paths: str | list[str]) -> None:
        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        if isinstance(remote_paths, str):
            remote_paths = [remote_paths]
        await asyncio.gather(
            *(sandbox.files.make_dir(p) for p in remote_paths), return_exceptions=True
        )

    # ---------------------------------------------------------------- env / commands

    async def set_env(self, provider_node_id: str, name: str, value: Optional[str]) -> None:
        if value is None:
            cmd = (
                f"grep -q '^export {name}=' ~/.bashrc "
                f"&& sed -i '/^export {name}=/d' ~/.bashrc || true"
            )
        else:
            escaped = value.replace("'", "'\\''")
            cmd = (
                f"touch ~/.bashrc; sed -i '/^export {name}=/d' ~/.bashrc; "
                f"echo \"export {name}='{escaped}'\" >> ~/.bashrc"
            )
        result = await self.run_command(provider_node_id, cmd, background=False)
        if result.exit_code != 0:
            service_log.warning(
                f"[E2B] set_env {name} returned exit_code={result.exit_code}, stderr={result.all_stderr}"
            )

    async def run_command(
        self,
        provider_node_id: str,
        command: str,
        session_id: Optional[str] = None,
        background: bool = False,
        env: Optional[dict[str, str]] = None,
    ) -> CLICommand:
        import uuid

        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        message_id = str(uuid.uuid4())
        cmd = CLICommand(command, message_id=message_id)
        self.running_commands[message_id] = cmd

        env_prefix = ""
        if env:
            assignments = []
            for k, v in env.items():
                escaped = v.replace("'", "'\\''")
                assignments.append(f"{k}='{escaped}'")
            env_prefix = " ".join(assignments) + " "
        full_command = env_prefix + command if env_prefix else command

        try:
            process = await sandbox.commands.run(
                full_command,
                on_stdout=lambda data: self._handle_stdout(message_id, data),
                on_stderr=lambda data: self._handle_stderr(message_id, data),
                timeout=None,
                background=background,
                cwd=self.default_working_dir,
            )
            if background:
                async def handle_output():
                    try:
                        await process.wait()
                        cmd.mark_complete(process.exit_code)
                    except CommandExitException as e:
                        cmd.mark_complete(e.exit_code)
                    except Exception as e:
                        service_log.warning(f"[E2B] Error waiting on background command: {e}")
                        cmd.mark_complete(-1)

                asyncio.create_task(handle_output(), name=f"e2b_run_command_{message_id}")
            else:
                cmd.mark_complete(process.exit_code)
        except CommandExitException as e:
            cmd.mark_complete(e.exit_code)
        except Exception as e:
            service_log.error(f"[E2B] Error running command on {provider_node_id}: {e}")
            cmd.mark_complete(-1)

        return cmd

    def _handle_stdout(self, message_id: str, data: str):
        cmd = self.running_commands.get(message_id)
        if cmd is not None:
            cmd.append_stdout(data)

    def _handle_stderr(self, message_id: str, data: str):
        cmd = self.running_commands.get(message_id)
        if cmd is not None:
            cmd.append_stderr(data)

    # ---------------------------------------------------------------- pty

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
        # spawn_args / extra_env / working_dir are not directly supported by
        # E2B's pty.create today. We accept them for signature compatibility
        # with LocalComputeProvider; working_dir can be applied via an initial
        # `cd` injected by the shell init (see InteractiveTerminal SHELL_INIT).
        if spawn_args:
            service_log.debug(f"[E2B] Ignoring spawn_args for sandbox PTY: {spawn_args}")
        if extra_env:
            service_log.debug(f"[E2B] Ignoring extra_env for sandbox PTY (use set_env instead)")

        pty_key = (provider_node_id, session_id)
        existing = self._pty_processes.get(pty_key)
        if existing is not None and existing["running"]["value"]:
            return {
                "pid": existing["pty"].pid,
                "provider": "e2b",
                "sandbox_id": existing["sandbox"].sandbox_id,
            }

        sandbox = await self._get_or_boot_sandbox(provider_node_id)
        running_flag = {"value": True}

        def on_pty_output(data: bytes):
            if running_flag["value"]:
                try:
                    on_output(data)
                except Exception as e:
                    service_log.warning(f"[E2B] Error in PTY output callback: {e}")

        pty = await sandbox.pty.create(
            size=PtySize(rows=rows, cols=cols),
            on_data=on_pty_output,
            timeout=0,
        )
        service_log.info(
            f"[E2B] PTY created pid={pty.pid} session={session_id} sandbox={sandbox.sandbox_id}"
        )

        self._pty_processes[pty_key] = {
            "sandbox": sandbox,
            "pty": pty,
            "running": running_flag,
            "on_output": on_output,
            "rows": rows,
            "cols": cols,
        }
        return {
            "pid": pty.pid,
            "provider": "e2b",
            "sandbox_id": sandbox.sandbox_id,
        }

    async def send_pty_input(
        self,
        provider_node_id: str,
        session_id: str,
        data: bytes,
        cols: int,
        rows: int,
    ) -> None:
        pty_info = self._pty_processes.get((provider_node_id, session_id))
        if pty_info is None:
            raise RuntimeError(f"PTY session not found for {provider_node_id}:{session_id}")
        try:
            await pty_info["sandbox"].pty.send_stdin(pty_info["pty"].pid, data)
        except Exception as e:
            service_log.warning(f"[E2B] send_stdin failed: {e}")
            await self._cleanup_pty_session(provider_node_id, session_id, reason=f"send_stdin: {e}")
            raise RuntimeError(f"Failed to send input to PTY: {e}") from e

    async def resize_pty(
        self, provider_node_id: str, session_id: str, cols: int, rows: int
    ) -> None:
        pty_info = self._pty_processes.get((provider_node_id, session_id))
        if pty_info is None:
            raise RuntimeError(f"PTY session not found for {provider_node_id}:{session_id}")
        try:
            await pty_info["sandbox"].pty.resize(
                pty_info["pty"].pid, PtySize(rows=rows, cols=cols)
            )
            pty_info["rows"] = rows
            pty_info["cols"] = cols
        except Exception as e:
            service_log.warning(f"[E2B] resize failed: {e}")
            await self._cleanup_pty_session(provider_node_id, session_id, reason=f"resize: {e}")
            raise RuntimeError(f"Failed to resize PTY: {e}") from e

    def is_pty_alive(self, provider_node_id: str, session_id: str) -> bool:
        pty_info = self._pty_processes.get((provider_node_id, session_id))
        return pty_info is not None and pty_info["running"]["value"]

    async def close_pty_session(self, provider_node_id: str, session_id: str) -> None:
        await self._cleanup_pty_session(provider_node_id, session_id, reason="close_pty_session")

        # Kill the sandbox if no PTYs remain on this node.
        remaining = [k for k in self._pty_processes if k[0] == provider_node_id]
        if not remaining and provider_node_id in self._sandboxes:
            await self.shutdown(provider_node_id)

    async def _cleanup_pty_session(
        self, provider_node_id: str, session_id: str, reason: str
    ) -> None:
        pty_key = (provider_node_id, session_id)
        pty_info = self._pty_processes.pop(pty_key, None)
        if pty_info is None:
            return
        pty_info["running"]["value"] = False
        service_log.info(
            f"[E2B] PTY session closed: node={provider_node_id} session={session_id} reason={reason}"
        )

    # ---------------------------------------------------------------- misc

    def get_pty_session(self, cn_id: str, shell_id: str):
        """Return an E2BPtySession handle if an active session exists.

        Signature mirrors LocalComputeProvider.get_pty_session(cn_id, shell_id):
        the lookup walks the global pty_registry to find any session whose
        cn_id and shell_id match (regardless of provider_node_id, since we
        look up by ComputeNode id + shell id).
        """
        from flow_sdk.compute.providers.desktop.pty_session_manager import pty_registry

        from .e2b_pty_session import E2BPtySession

        for key in pty_registry.states:
            if key[0] == cn_id and key[2] == shell_id:
                return E2BPtySession(key[0], key[1], key[2], self, pty_registry)
        return None
