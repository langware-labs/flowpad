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
    claude_session_id: str | None = APIField(default=None)
    created_at: str | None = APIField(default=None, description="ISO creation timestamp")
    last_active_at: str | None = APIField(default=None, description="ISO last activity timestamp")
    error_message: str | None = APIField(default=None, description="Error message when status=error")

    _api_visible: ClassVar[bool] = True

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
            claude_session_id=record.data.get("claude_session_id"),
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
        self.claude_session_id = record.data.get("claude_session_id")
        self.pty_pid = record.data.get("pty_pid")
        self.created_at = record.data.get("created_at")
        self.last_active_at = record.data.get("last_active_at")
        status = record.status
        self.status = status.value if hasattr(status, "value") else (status or ShellStatus.IDLE.value)

    async def _cleanup_stale_session(self) -> None:
        """Clean up stale PTY session state so a fresh one can be created."""
        from flow_sdk.builtin.faas.pty_replay_buffer import replay_buffer
        from flow_sdk.builtin.faas.pty_session_manager import session_manager

        if not self.compute_node_id:
            return
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        compute_node = await ComputeNode.get_by_id(self.compute_node_id)
        if not compute_node or not compute_node.node_provider_id:
            return
        pty_key = (compute_node.id, compute_node.node_provider_id, self.id)
        existing = await session_manager.get_session(pty_key)
        if existing:
            await session_manager.close_session(pty_key)
        replay_buffer.clear(pty_key)
        active = compute_node.active_pty_sessions or []
        if self.id in active:
            compute_node.active_pty_sessions.remove(self.id)

    async def connect(
        self, cmd: str | None = None, rows: int = 24, cols: int = 80, on_exit=None, connection_id: str | None = None
    ) -> ApiResponse:
        """Start or restart the PTY. Single public method for PTY lifecycle.

        - status == "running" AND PTY alive  →  no-op, return success
        - status == "running" AND PTY dead   →  cleanup stale session, spawn new PTY
        - status in (idle, closed, None)     →  spawn new PTY
        - cmd: if provided, injected as initial_command
        - connection_id: WebSocket connection to route PTY output to
        - Sets status = "running" on success.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        if self.status not in (None, "idle", "closed", "running"):
            return ApiFailResponse(message=f"Cannot open session in status: {self.status}")
        if not self.compute_node_id:
            return ApiFailResponse(message="compute_node_id is required")

        compute_node = await ComputeNode.get_by_id(self.compute_node_id)
        if not compute_node:
            return ApiFailResponse(message=f"ComputeNode {self.compute_node_id} not found")

        # If already running, check whether PTY is actually alive.
        if self.status == "running":
            actually_alive = compute_node.node_provider_id and compute_node.compute_provider.is_pty_alive(
                compute_node.node_provider_id, self.id
            )
            if actually_alive:
                if connection_id:
                    from flow_sdk.builtin.faas.pty_session_manager import session_manager

                    pty_key = (compute_node.id, compute_node.node_provider_id, self.id)
                    await session_manager.attach_session(pty_key, connection_id)
                # If a command was requested but Claude hasn't taken over the shell yet
                # (status is "running" not "elevated"), inject the command into the live PTY.
                # This handles the case where a bare shell was spawned on server-restart
                # reconnect, and agentic_process.open() now needs to start Claude in it.
                if cmd and self.status != ShellStatus.ELEVATED.value:
                    await compute_node.compute_provider.send_pty_input(
                        compute_node.node_provider_id, self.id, f"{cmd}\r".encode(), cols, rows
                    )
                return ApiSuccessResponse(data=self.model_dump(mode="json"))

        # Cleanup stale session state before spawning.
        if self.status in ("running", "closed"):
            await self._cleanup_stale_session()

        success = await compute_node.start_machine_pty_session(
            shell_id=self.id,
            connection_id=connection_id,
            rows=rows,
            cols=cols,
            name=self.name,
            working_dir=self.workdir,
            initial_command=cmd,
            on_exit=on_exit,
        )

        if not success:
            return ApiFailResponse(message="Failed to start PTY session")

        self.status = "running"
        self.pty_pid = self.id
        self.last_active_at = datetime.now(timezone.utc).isoformat()
        await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="open")
    async def open(self) -> ApiResponse:
        """Start PTY and set status=running.

        POST body: {connection_id?, cols?, rows?, initial_command?}
        Validates: status in (created, idle, None, closed), compute_node_id is set.
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        return await self.connect(
            cmd=body.get("initial_command"),
            rows=body.get("rows", 24),
            cols=body.get("cols", 80),
            connection_id=body.get("connection_id"),
        )

    @action.post(action_name="close")
    async def close(self) -> ApiResponse:
        """Kill PTY and set status=closed.

        Delegates to DomainObject for .pty file cleanup + disk record state,
        then kills the in-memory PTY process.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode
        from flow_sdk.builtin.faas.pty_replay_buffer import replay_buffer
        from flow_sdk.builtin.faas.pty_session_manager import session_manager

        # 1. Close disk record + delete .pty file
        try:
            from flow_sdk.fs_records.shell_record import ShellRecord  # noqa: PLC0415

            record = ShellRecord.discover_one(self.id)
            if record:
                record.delete()
        except Exception as e:
            logging.warning(f"[Shell.close] DomainObject close failed: {e}")

        # 2. Kill in-memory PTY
        if self.compute_node_id:
            try:
                compute_node = await ComputeNode.get_by_id(self.compute_node_id)
                if compute_node and compute_node.node_provider_id:
                    pty_key = (compute_node.id, compute_node.node_provider_id, self.id)
                    request_info = get_current_request_info()
                    connection_id = request_info.request_connection_id if request_info else None
                    await session_manager.close_for_connection(pty_key, connection_id)
                    remaining = await session_manager.get_session(pty_key)
                    if not remaining:
                        replay_buffer.clear(pty_key)
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

        from flow_sdk.builtin.faas.compute_node import ComputeNode

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        vars_dict: dict = body.get("vars", {})
        if not vars_dict:
            return ApiFailResponse(message="vars is required")
        self.env = {**(self.env or {}), **vars_dict}
        await self.save()
        if self.status == "running" and self.compute_node_id:
            try:
                compute_node = await ComputeNode.get_by_id(self.compute_node_id)
                if compute_node and compute_node.node_provider_id:
                    is_windows = sys.platform == "win32"
                    lines = []
                    for key, val in vars_dict.items():
                        if is_windows:
                            lines.append(f"set {key}={val}\r\n")
                        else:
                            lines.append(f"export {key}={val}\n")
                    data = "".join(lines)
                    await compute_node.node_provider.send_pty_input(
                        compute_node.node_provider_id, self.id, data.encode(), None, None
                    )
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

        from flow_sdk.builtin.faas.compute_node import ComputeNode
        from flow_sdk.builtin.faas.pty_replay_buffer import PtyReplayBuffer

        if not self.compute_node_id:
            return ApiFailResponse(message="compute_node_id not set")

        compute_node = await ComputeNode.get_by_id(self.compute_node_id)
        if not compute_node or not compute_node.node_provider_id:
            return ApiFailResponse(message="ComputeNode or provider not found")

        buf = PtyReplayBuffer.get_instance()
        session_key = (compute_node.id, compute_node.node_provider_id, self.id)
        session_buf = buf.buffers.get(session_key)

        if not session_buf:
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
            for chunk in session_buf.chunks
        ]

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
                "total_chunks": len(session_buf.chunks),
                "total_size_bytes": session_buf.total_size_bytes,
                "next_seq": session_buf.next_seq,
                "pty_file_b64": pty_file_b64,
            }
        )

    async def elevate(self, claude_session_id: str) -> None:
        """Elevate to a Claude session."""
        self.status = ShellStatus.ELEVATED.value
        self.claude_session_id = claude_session_id
        await self.save()

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
