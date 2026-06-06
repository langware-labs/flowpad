"""PtyActionsMixin — PTY session management actions for ComputeNode.

Mixed into ComputeNode. Accesses self.id, self.node_provider_id,
self.active_pty_sessions, self.typeid, self.compute_provider via
normal Python attribute lookup (no dependency injection needed).
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import TYPE_CHECKING, Callable

from flow_sdk.api.messages import PtyOutputMessage, PtySessionStatusMessage, ResponseMessage
from flow_sdk.api.type_id import TypeId
from flow_sdk.core.network.connection import Connection
from flow_sdk.core.network.connection_manager import get_connection_handler
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.faas.pty_session import Pty as PtySession

# When active PTY sessions reach this count, the oldest _PTY_EVICT_COUNT are closed automatically.
# Prevents OS PTY device exhaustion (macOS default limit: 511).
_PTY_CAP = 70
_PTY_EVICT_COUNT = 10

class PtyActionsMixin:
    """PTY session management implementation mixed into ComputeNode.

    All methods here are plain implementations — no @action decorators.
    ComputeNode keeps the @action stubs and delegates to these methods.
    """

    @staticmethod
    def _request_message_id(body: dict | None = None) -> str:
        request_info = get_current_request_info()
        if request_info and request_info.request_message_id:
            return request_info.request_message_id
        if body and body.get("message_id"):
            return str(body["message_id"])
        return str(uuid.uuid4())

    async def _pty_terminal_command(self):
        """Dispatch terminal operations via /terminal-command/<op> API.

        Operations:
        - start: Start a new PTY session
        - attach: Reattach to existing PTY session (asserts size + repaint)
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
        spawn_args: list[str] | None = None,
        extra_env: dict[str, str] | None = None,
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
        from flow_sdk.compute.providers.desktop.pty_session_manager import session_manager

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

        # Create output callback that sends data over WebSocket
        main_loop = asyncio.get_event_loop()
        request_message_id = str(uuid.uuid4())

        # Mutable holder for session_state, populated after generate_session()
        session_state_holder: list = []

        def on_pty_output(data: bytes):
            logging.debug(f"[PTY] on_pty_output (machine): {len(data)} bytes for session {shell_id}")
            current_pty_key = (self.id, self.node_provider_id, shell_id)

            # Advance the per-session output counter (activity signal; no data stored)
            seq = session_state_holder[0].next_seq() if session_state_holder else 0
            chunk_timestamp = time.time()

            # Write to PTY stream file for persistence
            if session_state_holder:
                ss = session_state_holder[0]
                if ss.pty_stream_file:
                    ss.pty_stream_file.write(data, seq)
                # Feed Pty.output() iterators
                for _q in ss.output_queues:
                    asyncio.run_coroutine_threadsafe(_q.put(data), main_loop)

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
                    logging.debug(
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
                spawn_args=spawn_args,
                extra_env=extra_env,
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

        # Create or update shell FSRecord and wire PtyStreamFile
        try:
            from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile
            from flow_sdk.fs_store.fs_record import FSRecord
            from flow_sdk.builtin.shell import (
                ShellStatus,
                get_shell_record,
                shell_pty_stream_path,
            )

            existing_record = get_shell_record(shell_id)
            if not existing_record:
                record = FSRecord(
                    type="shell",
                    id=shell_id,
                    pty_pid=shell_id,
                    workdir=working_dir,
                    name=name,
                    status=ShellStatus.RUNNING.value,
                )
                record.save()
            else:
                # Recovery case: backfill pty_pid (may be missing when the
                # record was first materialized via Entity.save() before PTY
                # start) and update process_id from the provider session.
                patch: dict = {}
                if not existing_record.__dict__.get("pty_pid"):
                    patch["pty_pid"] = shell_id
                pid = provider_session_data.get("pid") if isinstance(provider_session_data, dict) else None
                if pid is not None:
                    patch["process_id"] = str(pid)
                if patch:
                    existing_record.save_metadata(patch)
                record = existing_record

            # Create PtyStreamFile at the record's pty stream path. Initial
            # winsize goes in the framed header — replay interprets output at
            # the recorded sizes (resize frames are appended on every change).
            pty_stream_file = PtyStreamFile(
                path=shell_pty_stream_path(record.id, record.__dict__.get("pty_pid")),
                cols=cols,
                rows=rows,
            )
            session_state.pty_stream_file = pty_stream_file

            # Write-through: create/update the Shell DB entity from the record
            # via the generic base sync, then apply the shell-specific side
            # effects (tab ordering for new tabs, compute-node binding). The
            # compute node is this action's context (self.typeid), so the
            # binding lives here — not in a per-type from_record override.
            try:
                import re as _re
                from flow_sdk.builtin.shell import Shell
                from flow_sdk.core.entity.entity_model import Entity

                _UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
                if _re.match(_UUID, str(record.id), _re.I):
                    was_new = await Shell.get_one({"id": record.id}) is None
                    shell = await Shell.from_record(record)
                    if shell:
                        changed = False
                        if was_new:
                            shell.tab_order = await Shell.next_tab_order()
                            changed = True
                        cn_parts = str(self.typeid).split("-", 1)
                        cn_id = cn_parts[1] if len(cn_parts) == 2 else str(self.typeid)
                        if cn_id and not shell.compute_node_id:
                            shell.compute_node_id = cn_id
                            changed = True
                        if shell.status != ShellStatus.RUNNING.value:
                            shell.status = ShellStatus.RUNNING.value
                            changed = True
                        if changed:
                            await shell.save()
                        try:
                            cn = await Entity.get_by_typeid(self.typeid)
                            if cn:
                                await cn.attach_child(shell.typeid)
                        except Exception as _e_attach:
                            logging.debug(f"[PTY] attach shell to compute node failed: {_e_attach}")
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

    def get_pty(self, shell_id: str) -> "PtySession | None":
        """Return a PtySession handle if an active session exists for shell_id."""
        return self.compute_provider.get_pty_session(self.id, shell_id)

    async def create_pty(
        self,
        shell_id: str,
        rows: int = 24,
        cols: int = 80,
        connection_id: str | None = None,
        name: str | None = None,
        working_dir: str | None = None,
        on_exit=None,
        spawn_args: list[str] | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> "PtySession":
        """Create a new PTY session and return its handle.

        Raises RuntimeError if creation fails.
        """
        success = await self.start_machine_pty_session(
            shell_id=shell_id,
            connection_id=connection_id,
            rows=rows,
            cols=cols,
            name=name,
            working_dir=working_dir,
            on_exit=on_exit,
            spawn_args=spawn_args,
            extra_env=extra_env,
        )
        if not success:
            raise RuntimeError(f"Failed to create PTY session for shell {shell_id}")
        pty = self.get_pty(shell_id)
        if pty is None:
            raise RuntimeError(f"PTY session not found after creation for shell {shell_id}")
        return pty

    async def _pty_list_shells(self) -> ApiResponse:
        """List active shell entities (status != closed)."""
        from flow_sdk.builtin.shell import Shell as ShellEntity

        all_sessions = await ShellEntity.get_all()

        # Detect zombie sessions: status=running but no pty_pid means PTY never started or died
        for s in all_sessions:
            if s.status == "running" and not s.pty_pid:
                s.status = "error"
                s.error_message = "PTY session not found"
                await s.save()

        active = [s for s in all_sessions if s.status not in ("closing", "closed", "error")]
        result = [s.model_dump(mode="json") for s in active]

        # Enrich with agentic_process_id from AgenticProcess
        try:
            from flow_sdk.builtin.agentic_process import AgenticProcess

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

    async def _pty_session_transcript(self) -> ApiResponse:
        """Return transcript entries for a Claude session.

        Query params:
          - session_id (required): The Claude session UUID
          - project (optional): Absolute project path for O(1) lookup
        """
        from flow_sdk.fs_store.indexer.functions.claude_sessions import (
            claude_session_to_transcript_dicts,
            get_claude_session,
        )

        request_info = get_current_request_info()
        session_id = request_info.request.query_params.get("session_id")
        if not session_id:
            return ApiFailResponse(message="session_id query parameter required")

        project = request_info.request.query_params.get("project")
        record = get_claude_session(session_id, project=project)
        if not record:
            return ApiSuccessResponse(data=[])

        return ApiSuccessResponse(data=claude_session_to_transcript_dicts(record))

    async def _pty_session_transcript_raw(self) -> ApiResponse:
        """Return raw JSONL bytes for a Claude session as a UTF-8 string.

        The browser cannot fetch ``~/.claude/projects/.../<sid>.jsonl`` directly
        (no static mount), so callers that need the *original* bytes (e.g. to
        attach the transcript to an outbound share) ask us to read the file
        server-side and return its content in the response payload.

        Query params:
          - session_id (required): The Claude session UUID
          - project (optional): Absolute project path for O(1) lookup
        """
        from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session

        request_info = get_current_request_info()
        session_id = request_info.request.query_params.get("session_id")
        if not session_id:
            return ApiFailResponse(message="session_id query parameter required")

        project = request_info.request.query_params.get("project")
        record = get_claude_session(session_id, project=project)
        if not record or not record.jsonl_path:
            return ApiSuccessResponse(data={"content": "", "session_id": session_id, "jsonl_path": None})

        from pathlib import Path as _Path
        path = _Path(record.jsonl_path)
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return ApiFailResponse(message=f"failed to read transcript: {exc}")

        return ApiSuccessResponse(data={
            "content": content,
            "session_id": session_id,
            "jsonl_path": str(path),
        })

    async def _pty_discovery_action(self) -> ApiResponse:
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

        uuid_param = request_info.request.query_params.get("uuid") if request_info.request else None
        project = request_info.request.query_params.get("project") if request_info.request else None

        loop = asyncio.get_event_loop()

        # Parser-fn-only types need their own dispatch (no record_cls). Add
        # cases here as more types migrate.
        if record_type == "claude_session":
            from flow_sdk.fs_store.indexer.functions.claude_sessions import (  # noqa: PLC0415
                claude_session_meta_dict,
                discover_claude_session_paths_iter,
                ensure_claude_session_stats,
                extract_claude_session_from_path,
                get_claude_session,
            )
            try:
                if uuid_param:
                    record = await loop.run_in_executor(
                        None, lambda: get_claude_session(uuid_param, project=project)
                    )
                    if not record:
                        return ApiSuccessResponse(data=None)
                    await loop.run_in_executor(None, lambda: ensure_claude_session_stats(record))
                    return ApiSuccessResponse(data=claude_session_meta_dict(record))
                else:
                    paths = await loop.run_in_executor(
                        None, lambda: list(discover_claude_session_paths_iter())
                    )
                    records = [extract_claude_session_from_path(p) for p in paths]
                    return ApiSuccessResponse(
                        data=[claude_session_meta_dict(r) for r in records]
                    )
            except Exception as exc:
                logging.warning("discovery action error for %r uuid=%r: %s", record_type, uuid_param, exc)
                return ApiSuccessResponse(data=None)

        if _SR.get(record_type) is None:
            return ApiFailResponse(message=f"Unknown record type: {record_type!r}")

        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
        try:
            if uuid_param:
                record = await loop.run_in_executor(None, lambda: FSRecord.load_or_none(record_type, uuid_param))
                if record is None:
                    return ApiSuccessResponse(data=None)
                return ApiSuccessResponse(data=record.meta_dict())
            else:
                records = await loop.run_in_executor(None, lambda: FSRecord.discover(record_type))
                return ApiSuccessResponse(data=[r.meta_dict() for r in records])
        except Exception as exc:
            logging.warning("discovery action error for %r uuid=%r: %s", record_type, uuid_param, exc)
            return ApiSuccessResponse(data=None)

    async def _pty_reset_pty(self) -> ApiResponse:
        """Clear all in-memory PTY state for this compute node (mimics server restart).

        Wipes:
        - session_manager sessions for this node
        - compute_provider._pty_sessions for this node
        - active_pty_sessions list on this entity

        Shell entities in the DB retain their status; _open_shell will detect
        the dead PTY via is_pty_alive() and reset them on the next resume().
        """
        cleared = self.compute_provider.reset_all_sessions(self.id, self.node_provider_id)
        self.active_pty_sessions.clear()
        logging.info("[reset_pty] Cleared %d session(s) for compute node %s", cleared, self.id)
        return ApiSuccessResponse(data={"cleared": cleared})

    async def _pty_update_shell(self) -> ApiResponse:
        """Update a shell record's display properties.

        Accepts shell_id (required) and optional fields: tab_order (int),
        name (str). Updates the record on disk and returns
        the updated record data.
        """
        from flow_sdk.builtin.shell import get_shell_record

        request_info = get_current_request_info()
        body = await request_info.get_post_data()
        shell_id = body.get("shell_id")
        if not shell_id:
            return ApiFailResponse(message="shell_id is required")

        # Entity-first write-through: mutate the Shell entity and save(). The
        # base store mirrors persisted fields (name) to metadata.json; tab_order
        # is DB-only (persist=FALSE). No direct record poke / sync_from_record.
        from flow_sdk.builtin.shell import Shell

        shell_entity = await Shell.get_one({"id": shell_id})
        if not shell_entity:
            return ApiFailResponse(message="Shell session not found")

        if "tab_order" in body:
            shell_entity.tab_order = body["tab_order"]
        if "name" in body:
            shell_entity.name = body["name"]
        await shell_entity.save()

        record = get_shell_record(shell_id)
        data = record.meta_dict() if record else {}
        data["tab_order"] = shell_entity.tab_order
        return ApiSuccessResponse(data=data)

    async def _attach_pty_session(self, body: dict) -> ApiResponse:
        """Reattach to an existing PTY session.

        No byte replay: the client mounts a blank terminal, so the server
        asserts the client's size on the PTY and forces the running TUI to
        repaint its live frame (real resize when the size changed, winsize
        jiggle when it didn't). ``since_seq`` from older clients is ignored.
        """
        logging.info(f"[PTY] _attach_pty_session called with body: {body}")
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")

        request_message_id = request_info.request_message_id
        pty_id = body.get("pty_id") or body.get("shell_id")

        if not pty_id:
            logging.error("[PTY] Missing required parameters")
            response_msg = ResponseMessage(
                session_id=pty_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="Missing required parameters (pty_id or shell_id)",
            )
            return ApiFailResponse(message="Missing required parameters", data=response_msg.model_dump())

        # Get connection_id from request context
        if not request_info.request_connection_id:
            logging.error("[PTY] No WebSocket connection available")
            response_msg = ResponseMessage(
                session_id=pty_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="No WebSocket connection available",
            )
            return ApiFailResponse(message="No WebSocket connection available", data=response_msg.model_dump())

        request_connection_id = request_info.request_connection_id
        logging.info(f"[PTY] Attaching with connection_id: {request_connection_id}")

        pty_handle = self.get_pty(pty_id)
        if not pty_handle:
            # Session not found or expired (expected after server restart)
            logging.debug(f"[PTY] Session {pty_id} not found")
            status_msg = PtySessionStatusMessage(
                shell_id=pty_id,
                status="not_found",
            )
            response_msg = ResponseMessage(
                session_id=pty_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                content=status_msg,  # Pass instance, not dict
            )
            return ApiSuccessResponse(data=response_msg.model_dump())

        # Attach to session (updates connection_id — live output starts flowing)
        try:
            await pty_handle.attach(request_connection_id)
            logging.info(f"[PTY] Attached to session {pty_id} with connection_id {request_connection_id}")

        except Exception as e:
            logging.error(f"[PTY] Failed to attach to session: {e}", exc_info=True)
            response_msg = ResponseMessage(
                session_id=pty_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"Failed to attach to session: {e}",
            )
            return ApiFailResponse(message=f"Failed to attach to session: {e}", data=response_msg.model_dump())

        # Make the running program repaint for this freshly-attached client.
        # ``repaint`` asserts the client's size (or jiggles the winsize when it
        # is unchanged/omitted) — the size policy lives on the handle, not here.
        # 0/missing dims → None (no size override); a real 0 is not a valid size.
        try:
            cols = int(body.get("cols") or 0) or None
            rows = int(body.get("rows") or 0) or None
        except (TypeError, ValueError):
            cols = rows = None
        try:
            await pty_handle.repaint(cols, rows)
        except Exception as e:
            # Repaint is best-effort: the attach itself succeeded and live
            # output flows regardless.
            logging.warning(f"[PTY] attach repaint failed for {pty_id}: {e}")

        # Send status message
        latest_seq = pty_handle.latest_seq
        status_msg = PtySessionStatusMessage(
            shell_id=pty_id,
            status="reattached",
            latest_seq=latest_seq,
        )

        logging.info(f"[PTY] Session {pty_id} reattached successfully")
        response_msg = ResponseMessage(
            session_id=pty_id,
            message_id=request_message_id,
            response_message_id=request_message_id,
            content=status_msg,  # Pass instance, not dict
        )
        return ApiSuccessResponse(
            message=f"[PTY] Session reattached: shell_id: {pty_id}",
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
            seq: Sequence number (per-session monotonic counter)
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
                logging.debug(f"[PTY] Sending PTY output to client: seq={seq}, size={len(data)} bytes")
                await handler.send_message(response_msg.model_dump())
            except Exception as e:
                # A closed socket (tab closed mid-stream) is normal, not a
                # warning — the PTY keeps running and reattach repaints the frame.
                _m = str(e).lower()
                if any(s in _m for s in (
                    "close message has been sent", "websocket.close",
                    "after sending", "disconnect",
                )):
                    logging.debug(f"PTY output send skipped — client gone: {e}")
                else:
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
        request_message_id = self._request_message_id(body)

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

        if not shell_id:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error="shell_id required",
            )
            return ApiFailResponse(message="shell_id required", data=response_msg.model_dump())

        pty = self.get_pty(shell_id)
        if not pty:
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
            await pty.write(data_bytes)
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
        request_message_id = self._request_message_id(body)

        shell_id = body.get("shell_id")
        try:
            cols = int(body.get("cols", 80))
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

        pty = self.get_pty(shell_id)
        if not pty:
            response_msg = ResponseMessage(
                session_id=shell_id,
                message_id=request_message_id,
                response_message_id=request_message_id,
                error=f"PTY session not found: {shell_id}",
            )
            return ApiFailResponse(message=f"PTY session not found: {shell_id}", data=response_msg.model_dump())

        try:
            await pty.resize(cols, rows)
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
            from flow_sdk.builtin.shell import ShellStatus, get_shell_record

            record = get_shell_record(shell_id)
            if record:
                # Canonical `status` write through the unified metadata path.
                record.save_metadata_field("status", ShellStatus.CLOSED.value)
        except Exception as e:
            logging.warning(f"[PTY] Failed to update shell record on close: {e}")

        # Write-through: update Shell DB entity status to CLOSED
        try:
            from flow_sdk.builtin.shell import Shell

            shell_entity = await Shell.get_one({"id": shell_id})
            if shell_entity:
                await shell_entity.close()
        except Exception as e:
            logging.warning(f"[PTY] Failed to update Shell entity on close: {e}")

        pty = self.get_pty(shell_id)
        if not pty:
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
            await pty.close_for_connection(connection_id)

            logging.info(f"[PTY] Session close requested: {shell_id}, connection={connection_id}")
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
        active_sessions = self.compute_provider.list_pty_sessions(self.id)

        # Enrich sessions with agentic_process_id when an AgenticProcess owns the PTY
        if active_sessions:
            from flow_sdk.builtin.agentic_process import AgenticProcess

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

        pty = self.get_pty(shell_id)
        if not pty:
            return ApiFailResponse(message=f"Session not found: {shell_id}")

        pty.name = name
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
