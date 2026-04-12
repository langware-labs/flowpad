"""Shell entity -- DB-backed metadata layer for PTY sessions.

Write-through cache to ShellRecord. Provides fast DB queries for
listing/filtering, relationship tracking (Shell -> ComputeNode), and
standard entity CRUD via the graph API.

The entity ``id`` (UUID) IS the session ID -- no separate field needed.
TypeId format: ``shell-<uuid>``.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING, ClassVar

import psutil

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_records.shell_record import ShellStatus
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.cli_workers.base import WorkerCLIOptions, WorkerExecutionInfo
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.faas.pty_session import Pty
    from flow_sdk.fs_records.shell_record import ShellRecord

logger = logging.getLogger(__name__)


class Shell(Entity):
    """Entity representing a shell tab (PTY session).

    The canonical stream data lives in ``ShellRecord`` on disk.
    This entity is the SQLite layer that enables fast queries, relationship
    tracking (child of ComputeNode), and standard graph CRUD.
    """

    type: str = APIField(default=BuiltinEntityType.SHELL.value)
    name: str | None = APIField(default=None, description="Tab display name")
    status: str = APIField(default=ShellStatus.IDLE.value)
    workdir: str | None = APIField(default=None)
    env: dict | None = APIField(default=None, description="Custom environment variables")
    pty_pid: str | None = APIField(default=None, description="PTY session ID")
    compute_node_id: str | None = APIField(default=None, description="Owning compute node")
    project_id: str | None = APIField(default=None, description="Owning project")
    tab_order: int = APIField(default=0)
    created_at: str | None = APIField(default=None, description="ISO creation timestamp")
    last_active_at: str | None = APIField(default=None, description="ISO last activity timestamp")
    error_message: str | None = APIField(default=None, description="Error message when status=error")
    worker_pid: int | None = APIField(default=None, description="OS PID of the running worker process")
    worker_name: str | None = APIField(default=None, description="Worker executable name, e.g. 'claude'")
    user_renamed: bool = APIField(default=False, description="True when user explicitly renamed this shell via /rename or the UI")
    last_launch_cmd: dict | None = APIField(default=None, description="Serialized WorkerCLIOptions from the last launch() call")

    _api_visible: ClassVar[bool] = True

    # ── Internal helpers ──────────────────────────────────────────────────────

    @property
    def compute_node(self) -> "ComputeNode":
        """The local ComputeNode backing this shell's PTY sessions."""
        from flow_sdk.builtin.faas.compute_node import ComputeNode
        return ComputeNode(
            id=self.compute_node_id or "",
            node_provider_id="local",
            node_provider_type="local_machine",
        )

    async def _cleanup_stale_session(self) -> None:
        """Evict any dead PTY session state so a fresh one can be spawned."""
        pty = self.compute_node.get_pty(self.id)
        if pty:
            await pty.kill()

    @staticmethod
    def _argv_flag_value(argv: list[str], flag: str) -> str | None:
        """Return the value immediately following *flag* in argv, if present."""
        try:
            idx = argv.index(flag)
        except ValueError:
            return None
        next_idx = idx + 1
        if next_idx >= len(argv):
            return None
        return argv[next_idx]

    @classmethod
    def _cmdline_matches_expected(
        cls,
        cmdline: list[str],
        *,
        expected_exe: str | None,
        expected_session_id: str | None = None,
    ) -> bool:
        """Return True when cmdline matches the expected executable/session."""
        if expected_exe:
            actual_exe = os.path.basename(cmdline[0]) if cmdline else None
            if actual_exe != os.path.basename(expected_exe):
                return False

        if expected_session_id:
            actual_session_id = cls._argv_flag_value(cmdline, "--session-id") or cls._argv_flag_value(cmdline, "--resume")
            if actual_session_id != expected_session_id:
                return False

        return True

    def _live_pty_matches_spawn_args(self, spawn_args: list[str]) -> bool:
        """True if the current live PTY already runs the requested direct worker."""
        if not self.compute_node_id or not spawn_args:
            return False

        cn = self.compute_node
        pty_pid = cn.compute_provider.get_pty_shell_pid(cn.node_provider_id, self.id)
        if pty_pid is None or not psutil.pid_exists(pty_pid):
            return False

        try:
            cmdline = psutil.Process(pty_pid).cmdline()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

        expected_session_id = self._argv_flag_value(spawn_args, "--session-id") or self._argv_flag_value(spawn_args, "--resume")
        return self._cmdline_matches_expected(
            cmdline,
            expected_exe=spawn_args[0],
            expected_session_id=expected_session_id,
        )

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def is_alive(self) -> bool:
        """True when the underlying PTY process is running. Sync in-memory check."""
        if not self.compute_node_id:
            return False
        pty = self.compute_node.get_pty(self.id)
        return pty is not None and pty.is_alive

    @property
    def pty(self) -> "Pty | None":
        """The live Pty for this shell, or None if not started / closed.

        Use for attaching WS connections, output replay, raw resize, direct kill.
        """
        if not self.compute_node_id:
            return None
        return self.compute_node.get_pty(self.id)

    # ── Construction ──────────────────────────────────────────────────────────

    @classmethod
    async def open(cls, workdir=None, **kwargs) -> "Shell":
        """Create + start PTY immediately. Returns a ready shell."""
        shell = cls(workdir=workdir, **kwargs)
        await shell.start()
        return shell

    async def __aenter__(self) -> "Shell":
        await self.start()
        return self

    async def __aexit__(self, *_) -> None:
        await self.close()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(
        self,
        rows: int = 24,
        cols: int = 80,
        on_exit=None,
        connection_id: str | None = None,
        spawn_args: list[str] | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> bool:
        """Spawn the OS PTY. Idempotent — no-op if already alive.

        Returns True if a new PTY was spawned, False if one was already running.
        Raises RuntimeError on failure.

        - status == "running" AND PTY alive  →  no-op, returns False
        - status == "running" AND PTY dead   →  cleanup stale session, spawn fresh PTY
        - status in (idle, closed, None)     →  spawn new PTY
        """
        if self.status not in (None, "idle", "closed", "running"):
            raise RuntimeError(f"Cannot open session in status: {self.status}")

        cn = self.compute_node
        existing = cn.get_pty(self.id)

        if existing and existing.is_alive:
            if spawn_args is not None and not self._live_pty_matches_spawn_args(spawn_args):
                await existing.kill()
                existing = None
            else:
                if connection_id:
                    await existing.attach(connection_id)
                return False

        if existing and not existing.is_alive:
            await existing.kill()
        elif existing:
            if connection_id:
                await existing.attach(connection_id)
            return False
        elif self.status in ("running", "closed"):
            await self._cleanup_stale_session()

        await cn.create_pty(
            self.id,
            rows=rows,
            cols=cols,
            connection_id=connection_id,
            name=self.name,
            working_dir=self.workdir,
            on_exit=on_exit,
            spawn_args=spawn_args,
            extra_env=extra_env,
        )

        self.status = "running"
        self.pty_pid = self.id
        self.last_active_at = datetime.now(timezone.utc).isoformat()
        self.worker_pid = None
        self.worker_name = None
        await self.save()
        return True

    async def stop(self) -> None:
        """Kill PTY but keep the Shell entity. Tab entry remains.

        Use before server restarts or when you want manual resume control.
        """
        pty_handle = self.compute_node.get_pty(self.id) if self.compute_node_id else None
        if pty_handle:
            await pty_handle.kill()
        self.status = "idle"
        await self.save()

    async def restart(self) -> None:
        """stop() then start(). Preserves workdir, env, tab_order."""
        await self.stop()
        await self.start()

    async def terminate_worker(self) -> None:
        """Gracefully kill the Claude worker: SIGTERM, wait 3s, SIGKILL if needed.

        Shell entity and PTY are left alive (status unchanged).
        Uses self.worker_pid set by _launch_worker_process().
        """
        import signal

        pid = self.worker_pid
        if not pid:
            return
        try:
            os.kill(pid, signal.SIGTERM)
            deadline = asyncio.get_event_loop().time() + 3.0
            while asyncio.get_event_loop().time() < deadline:
                if not psutil.pid_exists(pid):
                    return
                await asyncio.sleep(0.1)
            if psutil.pid_exists(pid):
                os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # already gone

    # ── I/O ───────────────────────────────────────────────────────────────────

    async def _wait_for_shell_ready(self, timeout: float = 5.0, idle_ms: int = 150) -> None:
        """Wait until the PTY output has been silent for idle_ms milliseconds.

        Polls the replay buffer sequence number. When output stops arriving the
        shell is at its prompt with readline initialised — safe to inject input.
        """
        from flow_sdk.compute.providers.desktop.pty_replay_buffer import replay_buffer

        pty_key = (self.compute_node_id, "local", self.id)
        deadline = asyncio.get_event_loop().time() + timeout
        last_seq = -1
        while asyncio.get_event_loop().time() < deadline:
            current_seq = replay_buffer.get_latest_seq(pty_key)
            if current_seq > 0 and current_seq == last_seq:
                return  # output has stopped — shell is at prompt
            last_seq = current_seq
            await asyncio.sleep(idle_ms / 1000)

    async def write(self, text: str) -> None:
        """Wait for the shell to be ready then inject text as if typed by the user.

        Waits until PTY output has gone idle (shell at prompt, readline active),
        then sends the raw command followed by carriage return. No bracketed-paste
        markers — works on any platform (zsh, bash, cmd.exe, PowerShell).
        """
        pty_handle = self.compute_node.get_pty(self.id)
        if not pty_handle:
            raise RuntimeError("No PTY session — call start() first")
        await self._wait_for_shell_ready()
        await pty_handle.write(f"{text}\r".encode())

    async def write_raw(self, data: bytes) -> None:
        """Send raw bytes verbatim to PTY stdin (no \\r, no bracketed paste).

        Use for control sequences: b"\\x1b" (Escape), b"\\x03" (Ctrl-C),
        b"\\x04" (Ctrl-D), or any binary PTY input.
        """
        pty_handle = self.compute_node.get_pty(self.id)
        if not pty_handle:
            raise RuntimeError("No PTY session — call start() first")
        await pty_handle.write(data)

    async def read(self) -> bytes:
        """Return all accumulated PTY output so far (from disk stream file).

        Non-destructive. Returns b"" if stream file does not exist yet.
        """
        from flow_sdk.fs_records.shell_record import ShellRecord  # noqa: PLC0415

        record = ShellRecord.discover_one(self.pty_pid or self.id)
        if record and record.pty_stream_ref.exists():
            return record.pty_stream_ref.read_bytes()
        return b""

    def output(self):
        """Stream live PTY output as it arrives. Delegates to self.pty.output()."""
        pty_handle = self.compute_node.get_pty(self.id)
        if pty_handle is None:
            async def _empty():
                return
                yield
            return _empty()
        return pty_handle.output()

    # ── Worker process ────────────────────────────────────────────────────────

    async def launch(
        self,
        cmd: "WorkerCLIOptions",
        instruction: str | None = None,
    ) -> "WorkerExecutionInfo":
        """Inject cmd into the PTY, poll for worker PID, persist on entity.

        Sends cmd.to_shell_string(instruction) into the PTY via write().
        Polls up to 1s for the child PID to appear in the process tree.
        Stores worker_pid, worker_name, and last_launch_cmd on the entity.

        Returns:
            WorkerExecutionInfo with pid (or None if not found within 1 s).

        Raises:
            RuntimeError: PTY session is not alive.
        """
        from flow_sdk.builtin.cli_workers.base import WorkerExecutionInfo

        cn = self.compute_node
        pty_handle = cn.get_pty(self.id)
        if pty_handle is None or not pty_handle.is_alive:
            raise RuntimeError("PTY session is not alive")

        shell_pid = cn.compute_provider.get_pty_shell_pid(cn.node_provider_id, self.id)
        executable = cmd._build_worker_args()[0]  # e.g. "claude"
        command = cmd.to_shell_string(instruction=instruction)

        await self.write(command)

        worker_pid = await self._poll_for_worker_pid(shell_pid, executable, timeout=1.0)

        self.worker_pid = worker_pid
        self.worker_name = executable
        try:
            self.last_launch_cmd = cmd.to_json()
        except Exception:
            pass
        await self.save()

        return WorkerExecutionInfo(
            pid=worker_pid,
            name=executable,
            cmd=command[:200],
            started_at=datetime.now(timezone.utc).isoformat(),
        )

    async def set_worker_pid_direct(self, cmd: "WorkerCLIOptions") -> "WorkerExecutionInfo":
        """Record worker_pid when Claude IS the PTY process (direct spawn, no polling).

        Used by AgenticProcess when shell_mode=False. The PTY PID is Claude's PID directly,
        so we read it immediately from the provider without any child-process hunting.
        """
        from flow_sdk.builtin.cli_workers.base import WorkerExecutionInfo

        cn = self.compute_node
        pty_pid = cn.compute_provider.get_pty_shell_pid(cn.node_provider_id, self.id)
        executable = cmd._build_worker_args()[0]  # "claude"
        self.worker_pid = pty_pid
        self.worker_name = executable
        try:
            self.last_launch_cmd = cmd.to_json()
        except Exception:
            pass
        await self.save()
        return WorkerExecutionInfo(
            pid=pty_pid,
            name=executable,
            cmd=None,
            started_at=datetime.now(timezone.utc).isoformat(),
        )

    async def worker_alive(self) -> bool:
        """True if worker_pid process is still running and matches worker_name.

        Raises:
            RuntimeError: If the PTY session itself is dead.
        """
        if not self.worker_pid:
            return False

        if self.compute_node_id:
            pty_handle = self.compute_node.get_pty(self.id)
            if pty_handle is not None and not pty_handle.is_alive:
                raise RuntimeError("PTY session is not alive")

        if not psutil.pid_exists(self.worker_pid):
            return False

        if self.worker_name:
            try:
                cmdline = psutil.Process(self.worker_pid).cmdline()
                expected_session_id = None
                if isinstance(self.last_launch_cmd, dict):
                    expected_session_id = self.last_launch_cmd.get("session_id")
                if not self._cmdline_matches_expected(
                    cmdline,
                    expected_exe=self.worker_name,
                    expected_session_id=expected_session_id,
                ):
                    return False
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return False

        return True

    async def _poll_for_worker_pid(
        self, shell_pid: int | None, executable: str, timeout: float = 1.0
    ) -> int | None:
        """Poll for a child process of shell_pid whose argv[0] matches executable."""
        import os as _os

        if shell_pid is None:
            return None
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                children = psutil.Process(shell_pid).children(recursive=True)
                for child in children:
                    try:
                        cmdline = child.cmdline()
                        if cmdline and _os.path.basename(cmdline[0]) == executable:
                            return child.pid
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                break
            await asyncio.sleep(0.1)
        return None

    # ── Environment ───────────────────────────────────────────────────────────

    async def set_env(self, **vars: str) -> None:
        """Persist env vars on the Shell entity and inject them live if running."""
        import sys

        self.env = {**(self.env or {}), **vars}
        await self.save()
        if self.status == "running":
            try:
                pty_handle = self.compute_node.get_pty(self.id)
                if pty_handle:
                    is_windows = sys.platform == "win32"
                    lines = []
                    for key, val in vars.items():
                        if is_windows:
                            lines.append(f"set {key}={val}\r\n")
                        else:
                            lines.append(f"export {key}={val}\n")
                    await pty_handle.write("".join(lines).encode())
            except Exception as e:
                logging.warning(f"[Shell.set_env] PTY inject failed: {e}")

    # ── Display ───────────────────────────────────────────────────────────────

    async def rename(self, name: str) -> None:
        """Set the tab display label. User rename wins over PTY OSC title escapes."""
        self.name = name
        self.user_renamed = True
        self.last_active_at = datetime.now(timezone.utc).isoformat()
        await self.save()
        try:
            record = await self.get_record()
            if record:
                record.sync_from_entity(self)
        except Exception:
            pass

    # ── Class utilities ───────────────────────────────────────────────────────

    @classmethod
    async def active(cls, compute_node_typeid: str | None = None) -> list["Shell"]:
        """All non-closed shells ordered by tab_order."""
        all_shells = await cls.get_all()
        shells = [s for s in all_shells if s.status != ShellStatus.CLOSED.value]
        shells.sort(key=lambda s: s.tab_order)
        return shells

    @classmethod
    async def next_tab_order(cls) -> int:
        """Return a tab_order value that places a new shell after all existing ones."""
        all_shells = await cls.get_all()
        if not all_shells:
            return 0
        return max(getattr(s, "tab_order", 0) for s in all_shells) + 1

    # ── Record sync ───────────────────────────────────────────────────────────

    @classmethod
    async def from_record(
        cls,
        record: "ShellRecord",
        compute_node_typeid: str | None = None,
    ) -> "Shell | None":
        """Create or update a Shell entity from a ShellRecord."""
        import re

        _UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
        if not _UUID_RE.match(record.id):
            logger.debug(f"[Shell.from_record] Skipping non-UUID record id: {record.id!r}")
            return None

        existing = await cls.get_one({"id": record.id})
        if existing:
            existing.sync_from_record(record)
            if not existing.compute_node_id and compute_node_typeid:
                parts = str(compute_node_typeid).split("-", 1)
                existing.compute_node_id = parts[1] if len(parts) == 2 else str(compute_node_typeid)
            await existing.save()
            return existing

        cn_id: str | None = None
        if compute_node_typeid:
            parts = str(compute_node_typeid).split("-", 1)
            cn_id = parts[1] if len(parts) == 2 else str(compute_node_typeid)

        entity = cls(
            id=record.id,
            name=record.data.get("name"),
            workdir=record.data.get("workdir"),
            tab_order=record.data.get("tab_order") or await cls.next_tab_order(),
            pty_pid=record.data.get("pty_pid"),
            created_at=record.data.get("created_at"),
            last_active_at=record.data.get("last_active_at"),
            status=(record.status.value if hasattr(record.status, "value") else record.status) or ShellStatus.IDLE.value,
            compute_node_id=cn_id,
        )
        await entity.save()

        if compute_node_typeid:
            try:
                from flow_sdk.api.type_id import TypeId as TId

                cn_tid = TId(compute_node_typeid) if isinstance(compute_node_typeid, str) else compute_node_typeid
                cn = await Entity.get_by_typeid(cn_tid)
                if cn:
                    await cn.attach_child(entity.typeid)
            except Exception as e:
                logger.debug(f"Failed to attach Shell {entity.id} to {compute_node_typeid}: {e}")

        return entity

    def sync_from_record(self, record: "ShellRecord") -> None:
        """Update entity fields from a ShellRecord."""
        self.name = record.data.get("name")
        self.workdir = record.data.get("workdir")
        self.tab_order = record.data.get("tab_order", 0)
        self.pty_pid = record.data.get("pty_pid")
        self.created_at = record.data.get("created_at")
        self.last_active_at = record.data.get("last_active_at")
        status = record.status
        self.status = status.value if hasattr(status, "value") else (status or ShellStatus.IDLE.value)

    # ── HTTP actions ──────────────────────────────────────────────────────────

    @action.post(action_name="open")
    async def _http_open(self) -> ApiResponse:
        """HTTP: Start PTY and set status=running.

        POST body: {connection_id?, cols?, rows?}
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        working_dir = body.get("working_dir")
        if working_dir:
            self.workdir = working_dir
        try:
            await self.start(
                rows=body.get("rows", 24),
                cols=body.get("cols", 80),
                connection_id=body.get("connection_id"),
            )
        except RuntimeError as e:
            return ApiFailResponse(message=str(e))
        payload = self.model_dump(mode="json")
        payload["pty_id"] = self.pty_pid or self.id
        return ApiSuccessResponse(data=payload)

    @action.post(action_name="close")
    async def close(self) -> ApiResponse:
        """Kill PTY + delete disk record + delete entity. Permanent teardown."""
        try:
            record = await self.get_record()
            if record:
                await record.delete()
        except Exception as e:
            logging.warning(f"[Shell.close] DomainObject close failed: {e}")

        try:
            pty_handle = self.compute_node.get_pty(self.id)
            if pty_handle:
                await pty_handle.close()
        except Exception as e:
            logging.warning(f"[Shell.close] PTY kill failed: {e}")

        await self.delete()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="run")
    async def run(self) -> ApiResponse:
        """HTTP: Execute a command in a subprocess and return stdout/stderr/exit_code.

        POST body: {command: str}
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        command = body.get("command")
        if not command:
            return ApiFailResponse(message="command is required")
        env = {**os.environ, **(self.env or {})}
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.workdir or None,
            env=env,
        )
        stdout, stderr = await proc.communicate()
        return ApiSuccessResponse(
            data={
                "stdout": stdout.decode("utf-8", errors="replace"),
                "stderr": stderr.decode("utf-8", errors="replace"),
                "exit_code": proc.returncode,
            }
        )

    @action.post(action_name="set-env")
    async def _http_set_env(self) -> ApiResponse:
        """HTTP: Set environment variables on this session.

        POST body: {vars: {key: value, ...}}
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        vars_dict: dict = body.get("vars", {})
        if not vars_dict:
            return ApiFailResponse(message="vars is required")
        await self.set_env(**vars_dict)
        return ApiSuccessResponse(data={"vars": list(vars_dict.keys())})

    # PTY title values that are generic spinner frames — never overwrite an existing name.
    _PTY_NAME_BLOCKLIST: ClassVar[set[str]] = {"Claude Code"}

    @action.post(action_name="update-display")
    async def update_display(self) -> ApiResponse:
        """HTTP: Update display properties (name, tab_order).

        POST body: {name?, tab_order?, is_pty?}
        When is_pty=True the name came from a PTY OSC title escape — ignored
        if the user already explicitly renamed this shell, or if the incoming
        name is a generic spinner title and the shell already has a name.
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}

        is_pty = bool(body.get("is_pty", False))
        changed = False
        if "name" in body:
            incoming = body["name"]
            is_blocked = is_pty and self.name and any(f in incoming for f in self._PTY_NAME_BLOCKLIST)
            if is_pty and (self.user_renamed or is_blocked):
                pass
            else:
                self.name = incoming
                if not is_pty:
                    self.user_renamed = True
                changed = True
        if "tab_order" in body:
            self.tab_order = body["tab_order"]
            changed = True

        if changed:
            self.last_active_at = datetime.now(timezone.utc).isoformat()
            await self.save()
            try:
                record = await self.get_record()
                if record:
                    record.sync_from_entity(self)
            except Exception:
                pass

            # Propagate name change to the linked AgenticProcess so the name
            # survives shell deletion when the process is closed.
            if self.name and "name" in body:
                try:
                    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
                    proc = await AgenticProcess.get_by_prop("shell_id", self.id, "agentic_process")
                    if proc and proc.name != self.name:
                        proc.name = self.name
                        await proc.save()
                except Exception:
                    pass

        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.get(action_name="fetch-pty-sequence")
    async def fetch_pty_sequence(self) -> ApiResponse:
        """HTTP: Return replay buffer chunk metadata for PTY debugging."""
        import base64

        if not self.compute_node_id:
            return ApiFailResponse(message="Shell has no compute_node_id")

        pty_handle = self.compute_node.get_pty(self.id)
        if pty_handle is None:
            return ApiSuccessResponse(data={"chunks": [], "total_chunks": 0, "total_size_bytes": 0})

        chunks = pty_handle.snapshot(0)
        if not chunks:
            return ApiSuccessResponse(data={"chunks": [], "total_chunks": 0, "total_size_bytes": 0})

        preview_bytes = 32
        chunks_meta = [
            {
                "seq": chunk.seq,
                "timestamp": chunk.timestamp,
                "size": len(chunk.data),
                "data_b64": base64.b64encode(chunk.data).decode("ascii"),
                "preview_b64": base64.b64encode(chunk.data[:preview_bytes]).decode("ascii"),
            }
            for chunk in chunks
        ]
        total_size_bytes = sum(len(c.data) for c in chunks)
        next_seq = chunks[-1].seq + 1

        pty_file_b64 = None
        try:
            record = await self.get_record()
            if record and record.pty_stream_ref.exists():
                pty_file_b64 = base64.b64encode(record.pty_stream_ref.read_bytes()).decode("ascii")
        except Exception as e:
            logger.warning(f"[Shell.fetch_pty_sequence] Failed to read PTY file: {e}")

        return ApiSuccessResponse(
            data={
                "chunks": chunks_meta,
                "total_chunks": len(chunks_meta),
                "total_size_bytes": total_size_bytes,
                "next_seq": next_seq,
                "pty_file_b64": pty_file_b64,
            }
        )
