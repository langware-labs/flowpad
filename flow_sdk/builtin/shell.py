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
    tab_order: int = APIField(default=0)
    created_at: str | None = APIField(default=None, description="ISO creation timestamp")
    last_active_at: str | None = APIField(default=None, description="ISO last activity timestamp")
    error_message: str | None = APIField(default=None, description="Error message when status=error")
    worker_pid: int | None = APIField(default=None, description="OS PID of the running worker process")
    worker_name: str | None = APIField(default=None, description="Worker executable name, e.g. 'claude'")

    _api_visible: ClassVar[bool] = True

    @property
    def compute_node(self) -> "ComputeNode":
        """The local ComputeNode backing this shell's PTY sessions."""
        from flow_sdk.builtin.faas.compute_node import ComputeNode
        return ComputeNode(
            id=self.compute_node_id or "",
            node_provider_id="local",
            node_provider_type="local_machine",
        )

    @property
    def connected(self) -> bool:
        """True if the PTY session is alive on the compute node."""
        if not self.compute_node_id:
            return False
        pty = self.compute_node.get_pty(self.id)
        return pty is not None and pty.is_alive

    async def read_output(self) -> bytes:
        """Read all accumulated PTY output from the .pty stream file on disk.

        The stream file survives destruct() and server restarts — it is only
        deleted by shell.close(). Returns b"" if no output has been written yet.
        """
        from flow_sdk.fs_records.shell_record import ShellRecord  # noqa: PLC0415

        record = ShellRecord.discover_one(self.pty_pid or self.id)
        if record and record.pty_stream_ref.exists():
            return record.pty_stream_ref.read_bytes()
        return b""

    async def send_input(self, cmd: str, bracketed: bool = False) -> None:
        """Send a command string to the PTY session.

        Args:
            cmd: Command text to send (without trailing newline).
            bracketed: Wrap with bracketed-paste markers (ESC[200~ / ESC[201~).
                       Use True when injecting programmatic commands so any
                       interactive line editor (zsh ZLE, bash readline, fish,
                       PSReadLine) echoes the command as one clean unit instead
                       of repainting the line on every character.
        """
        pty = self.compute_node.get_pty(self.id)
        if not pty:
            raise RuntimeError("No PTY session — call start_pty() first")
        data = f"\x1b[200~{cmd}\x1b[201~\r".encode() if bracketed else f"{cmd}\r".encode()
        await pty.send(data)

    def is_running(self, pid: int | None = None) -> bool:
        """Return True if the shell has a foreground process running.

        Uses psutil to check whether the shell process (identified by ``pid``)
        has any child processes.  When the shell is idle no children exist;
        when a command is running at least one child is present.

        Args:
            pid: OS PID of the shell process.  Pass None (or omit) when the
                 PID is not yet known — returns False in that case.
        """
        if pid is None:
            return False
        try:
            children = psutil.Process(pid).children(recursive=False)
            return len(children) > 0
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

    async def run_process(
        self,
        worker_cli: "WorkerCLIOptions",
        instruction: str | None = None,
    ) -> "WorkerExecutionInfo":
        """Launch a WorkerCLIOptions inside this PTY shell and track its PID.

        Sends the command to the shell, polls up to 1 s for the worker child
        process to appear, then persists the PID + name on the entity.

        Args:
            worker_cli: The CLI command to run (e.g. ClaudeCLICommand).
            instruction: Optional prompt/instruction passed to to_shell_string().

        Returns:
            WorkerExecutionInfo with pid (or None if not found within 1 s), name, cmd, started_at.

        Raises:
            ValueError: Shell has no compute_node_id.
            RuntimeError: PTY session is not alive.
        """
        from flow_sdk.builtin.cli_workers.base import WorkerExecutionInfo

        cn = self.compute_node
        pty = cn.get_pty(self.id)
        if pty is None or not pty.is_alive:
            raise RuntimeError("PTY session is not alive")

        shell_pid = cn.compute_provider.get_pty_shell_pid(cn.node_provider_id, self.id)
        executable = worker_cli._build_worker_args()[0]  # e.g. "claude"
        command = worker_cli.to_shell_string(instruction=instruction)

        await self.send_input(command)

        worker_pid = await self._poll_for_worker_pid(shell_pid, executable, timeout=1.0)

        self.worker_pid = worker_pid
        self.worker_name = executable
        await self.save()

        return WorkerExecutionInfo(
            pid=worker_pid,
            name=executable,
            cmd=command[:200],
            started_at=datetime.now(timezone.utc).isoformat(),
        )

    async def _poll_for_worker_pid(
        self, shell_pid: int | None, executable: str, timeout: float = 1.0
    ) -> int | None:
        """Poll for a child process of shell_pid whose argv[0] matches executable.

        On macOS the claude binary (Bun bundle) reports its version as the
        process name — name() is unreliable. We match against cmdline[0] instead.
        """
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

    async def worker_alive(self) -> bool:
        """Return True if the tracked worker process (worker_pid) is still alive.

        Raises:
            RuntimeError: If the PTY session itself is dead.
        """
        if not self.worker_pid:
            return False

        if self.compute_node_id:
            pty = self.compute_node.get_pty(self.id)
            if pty is not None and not pty.is_alive:
                raise RuntimeError("PTY session is not alive")

        return psutil.pid_exists(self.worker_pid)

    @classmethod
    async def next_tab_order(cls) -> int:
        """Return a tab_order value that places a new shell after all existing ones."""
        all_shells = await cls.get_all()
        if not all_shells:
            return 0
        return max(getattr(s, "tab_order", 0) for s in all_shells) + 1

    @classmethod
    async def from_record(
        cls,
        record: ShellRecord,
        compute_node_typeid: str | None = None,
    ) -> Shell | None:
        """Create or update a Shell entity from a ShellRecord.

        Uses the record's ``id`` as the entity ``id`` so both share the
        same UUID.  Returns None if the record ID is not a valid UUID
        (e.g. test/legacy records with non-UUID IDs).
        """
        import re

        _UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
        if not _UUID_RE.match(record.id):
            logger.debug(f"[Shell.from_record] Skipping non-UUID record id: {record.id!r}")
            return None

        existing = await cls.get_one({"id": record.id})
        if existing:
            existing.sync_from_record(record)
            # Backfill compute_node_id if missing (e.g. created before this field was set)
            if not existing.compute_node_id and compute_node_typeid:
                parts = str(compute_node_typeid).split("-", 1)
                existing.compute_node_id = parts[1] if len(parts) == 2 else str(compute_node_typeid)
            await existing.save()
            return existing

        # Extract compute_node_id from typeid string "compute_node-<uuid>"
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

    def sync_from_record(self, record: ShellRecord) -> None:
        """Update entity fields from a ShellRecord."""
        self.name = record.data.get("name")
        self.workdir = record.data.get("workdir")
        self.tab_order = record.data.get("tab_order", 0)
        self.pty_pid = record.data.get("pty_pid")
        self.created_at = record.data.get("created_at")
        self.last_active_at = record.data.get("last_active_at")
        status = record.status
        self.status = status.value if hasattr(status, "value") else (status or ShellStatus.IDLE.value)

    async def _cleanup_stale_session(self) -> None:
        """Evict any dead PTY session state so a fresh one can be spawned."""
        pty = self.compute_node.get_pty(self.id)
        if pty:
            await pty.kill()

    async def open_pty(
        self,
        rows: int = 24,
        cols: int = 80,
        on_output=None,
        on_exit=None,
    ) -> None:
        """Start the OS PTY via the compute provider. No DB writes.

        Lightweight counterpart to ``start_pty()``. Use in tests and direct
        provider calls when you want a real PTY without touching the DB or
        updating entity status.
        """
        await self.compute_node.create_pty(self.id, rows=rows, cols=cols, on_exit=on_exit)

    async def start_pty(
        self, rows: int = 24, cols: int = 80, on_exit=None, connection_id: str | None = None
    ) -> bool:
        """Start or restart the PTY.

        Returns True if a new PTY was spawned, False if one was already running (no-op).
        Raises RuntimeError on failure.

        - status == "running" AND PTY alive  →  no-op, returns False
        - status == "running" AND PTY dead   →  cleanup stale session, spawn new PTY, returns True
        - status in (idle, closed, None)     →  spawn new PTY, returns True
        - connection_id: WebSocket connection to route PTY output to
        """
        if self.status not in (None, "idle", "closed", "running"):
            raise RuntimeError(f"Cannot open session in status: {self.status}")

        cn = self.compute_node
        existing = cn.get_pty(self.id)

        if existing and existing.is_alive:
            if connection_id:
                await existing.attach(connection_id)
            return False

        # Dead session in manager — evict stale state before spawning.
        if existing:
            await existing.kill()
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
        )

        self.status = "running"
        self.pty_pid = self.id
        self.last_active_at = datetime.now(timezone.utc).isoformat()
        await self.save()
        return True

    @action.post(action_name="open")
    async def open(self) -> ApiResponse:
        """Start PTY and set status=running.

        POST body: {connection_id?, cols?, rows?}
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        try:
            await self.start_pty(
                rows=body.get("rows", 24),
                cols=body.get("cols", 80),
                connection_id=body.get("connection_id"),
            )
        except RuntimeError as e:
            return ApiFailResponse(message=str(e))
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="close")
    async def close(self) -> ApiResponse:
        """Kill PTY and set status=closed.

        Delegates to DomainObject for .pty file cleanup + disk record state,
        then kills the in-memory PTY process.
        """
        # 1. Close disk record + delete .pty file
        try:
            from flow_sdk.fs_records.shell_record import ShellRecord  # noqa: PLC0415

            record = ShellRecord.discover_one(self.id)
            if record:
                record.delete()
        except Exception as e:
            logging.warning(f"[Shell.close] DomainObject close failed: {e}")

        # 2. Kill in-memory PTY
        try:
            pty = self.compute_node.get_pty(self.id)
            if pty:
                await pty.close()
        except Exception as e:
            logging.warning(f"[Shell.close] PTY kill failed: {e}")

        # 3. Delete entity so it no longer appears in tab list
        await self.delete()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="run")
    async def run(self) -> ApiResponse:
        """Execute a command in a subprocess and return stdout/stderr/exit_code.

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
    async def set_env(self) -> ApiResponse:
        """Set environment variables on this session.

        POST body: {vars: {key: value, ...}}
        If session is running with a PTY, injects export commands.
        """
        import sys

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        vars_dict: dict = body.get("vars", {})
        if not vars_dict:
            return ApiFailResponse(message="vars is required")
        self.env = {**(self.env or {}), **vars_dict}
        await self.save()
        if self.status == "running":
            try:
                pty = self.compute_node.get_pty(self.id)
                if pty:
                    is_windows = sys.platform == "win32"
                    lines = []
                    for key, val in vars_dict.items():
                        if is_windows:
                            lines.append(f"set {key}={val}\r\n")
                        else:
                            lines.append(f"export {key}={val}\n")
                    await pty.send("".join(lines).encode())
            except Exception as e:
                logging.warning(f"[Shell.set_env] PTY inject failed: {e}")
        return ApiSuccessResponse(data={"vars": list(vars_dict.keys())})

    @action.post(action_name="update-display")
    async def update_display(self) -> ApiResponse:
        """Update display properties (name, tab_order).

        POST body: {name?, tab_order?}
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}

        changed = False
        if "name" in body:
            self.name = body["name"]
            changed = True
        if "tab_order" in body:
            self.tab_order = body["tab_order"]
            changed = True

        if changed:
            self.last_active_at = datetime.now(timezone.utc).isoformat()
            await self.save()

            # Also update disk record if linked
            try:
                from flow_sdk.fs_records.shell_record import ShellRecord  # noqa: PLC0415

                record = ShellRecord.discover_one(self.id)
                if record:
                    record.sync_from_entity(self)
            except Exception:
                pass

        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.get(action_name="fetch-pty-sequence")
    async def fetch_pty_sequence(self) -> ApiResponse:
        """Return replay buffer chunk metadata for PTY debugging."""
        return await self._get_pty_sequence_data()

    async def _get_pty_sequence_data(self) -> ApiResponse:
        """Resolve replay buffer and return chunk metadata."""
        import base64

        if not self.compute_node_id:
            return ApiFailResponse(message="Shell has no compute_node_id")

        pty = self.compute_node.get_pty(self.id)
        if pty is None:
            return ApiSuccessResponse(data={"chunks": [], "total_chunks": 0, "total_size_bytes": 0})

        chunks = pty.get_replay(0)
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

        # Resolve PTY file path for binary comparison
        pty_file_b64 = None
        try:
            from flow_sdk.fs_records.shell_record import ShellRecord

            record = ShellRecord.discover_one(self.id)
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

    @classmethod
    async def get_active_sessions(cls, compute_node_typeid: str | None = None) -> list[Shell]:
        """Return non-CLOSED sessions ordered by tab_order.

        If ``compute_node_typeid`` is provided, only returns children of
        that node.  Otherwise returns all active sessions.
        """
        all_shells = await cls.get_all()
        active = [s for s in all_shells if s.status != ShellStatus.CLOSED.value]
        active.sort(key=lambda s: s.tab_order)
        return active


