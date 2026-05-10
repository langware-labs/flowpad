"""PtyActionsMixin — PTY session management actions for ComputeNode.

Mixed into ComputeNode. Accesses self.id, self.node_provider_id,
self.active_pty_sessions, self.typeid, self.compute_provider via
normal Python attribute lookup (no dependency injection needed).
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re as _re
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

# ---------------------------------------------------------------------------
# Session title tracking — captures Claude-generated tab titles in real time.
# Keyed by shell_id (entity UUID).  Populated by on_pty_output() whenever an
# ANSI OSC title escape is detected that isn't a Claude Code spinner frame.
# ---------------------------------------------------------------------------
_pty_session_titles: dict[str, str] = {}

# Matches OSC 0 terminal title sequences: ESC ] 0 ; <title> BEL (or ST)
_OSC_TITLE_RE = _re.compile(rb"\x1b\]0;([^\x07\x1b]+)(?:\x07|\x1b\\)")
# Strips a leading spinner glyph + space (e.g. "✳ Morning coding session" → "Morning coding session")
_SPINNER_PREFIX_RE = _re.compile(r"^[^\x00-\x7F] ")


def _detect_osc_title(data: bytes) -> str | None:
    """Extract the last meaningful session title from a raw PTY chunk, or None."""
    matches = _OSC_TITLE_RE.findall(data)
    for raw in reversed(matches):
        try:
            title = raw.decode("utf-8", errors="replace").strip()
        except Exception:
            continue
        if "Claude Code" in title:
            continue  # spinner-only frame ("⠂ Claude Code") — not a real title
        title = _SPINNER_PREFIX_RE.sub("", title).strip()
        if title:
            return title
    return None


def get_pty_session_title(shell_id: str) -> str | None:
    """Return the last Claude-generated title seen for *shell_id*, or None."""
    return _pty_session_titles.get(shell_id)


class PtyActionsMixin:
    """PTY session management implementation mixed into ComputeNode.

    All methods here are plain implementations — no @action decorators.
    ComputeNode keeps the @action stubs and delegates to these methods.
    """

    async def _pty_terminal_command(self):
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
        from flow_sdk.compute.providers.desktop.pty_replay_buffer import replay_buffer
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
                replay_buffer.clear(evict_key)

        # Create output callback that sends data over WebSocket
        main_loop = asyncio.get_event_loop()
        request_message_id = str(uuid.uuid4())

        # Mutable holder for session_state, populated after generate_session()
        session_state_holder: list = []

        def on_pty_output(data: bytes):
            logging.info(f"[PTY] on_pty_output (machine): {len(data)} bytes for session {shell_id}")
            current_pty_key = (self.id, self.node_provider_id, shell_id)

            # Track Claude-generated session title (set via ANSI OSC escape after first prompt).
            # Stored in module-level dict so AgenticProcess.close() can read it at close time.
            _title = _detect_osc_title(data)
            if _title and _pty_session_titles.get(shell_id) != _title:
                _pty_session_titles[shell_id] = _title

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

        # Create or update ShellRecord and wire PtyStreamFile
        try:
            from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile
            from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus

            existing_record = ShellRecord.get(shell_id)
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

        active = [s for s in all_sessions if s.status not in ("closed", "error")]
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
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

        request_info = get_current_request_info()
        session_id = request_info.request.query_params.get("session_id")
        if not session_id:
            return ApiFailResponse(message="session_id query parameter required")

        project = request_info.request.query_params.get("project")
        kwargs = {}
        if project:
            kwargs["project"] = project

        record = ClaudeSessionRecord.get(session_id, **kwargs)
        if not record:
            return ApiSuccessResponse(data=[])

        return ApiSuccessResponse(data=record.to_transcript_dicts())

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
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

        request_info = get_current_request_info()
        session_id = request_info.request.query_params.get("session_id")
        if not session_id:
            return ApiFailResponse(message="session_id query parameter required")

        project = request_info.request.query_params.get("project")
        kwargs = {}
        if project:
            kwargs["project"] = project

        record = ClaudeSessionRecord.get(session_id, **kwargs)
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

        cls = _SR.get_record_cls(record_type)
        if cls is None:
            # Lazy-import well-known record types that aren't loaded at startup.
            # Importing the module triggers __init_subclass__ → SchemaRegistry registration.
            if record_type == "claude_session":
                from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord  # noqa: PLC0415

                cls = ClaudeSessionRecord
            else:
                return ApiFailResponse(message=f"Unknown record type: {record_type!r}")

        uuid_param = request_info.request.query_params.get("uuid") if request_info.request else None
        project = request_info.request.query_params.get("project") if request_info.request else None
        kwargs = {}
        if project:
            kwargs["project"] = project

        loop = asyncio.get_event_loop()

        try:
            if uuid_param:
                record = await loop.run_in_executor(None, lambda: cls.get(uuid_param, **kwargs))
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
            logging.warning("discovery action error for %r uuid=%r: %s", record_type, uuid_param, exc)
            return ApiSuccessResponse(data=None)

    async def _pty_reset_pty(self) -> ApiResponse:
        """Clear all in-memory PTY state for this compute node (mimics server restart).

        Wipes:
        - session_manager sessions for this node
        - replay_buffer entries for this node
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
        from flow_sdk.fs_records.shell_record import ShellRecord

        request_info = get_current_request_info()
        body = await request_info.get_post_data()
        shell_id = body.get("shell_id")
        if not shell_id:
            return ApiFailResponse(message="shell_id is required")

        record = ShellRecord.get(shell_id)
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

    async def _attach_pty_session(self, body: dict) -> ApiResponse:
        """Reattach to existing PTY session with output replay."""
        logging.info(f"[PTY] _attach_pty_session called with body: {body}")
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")

        request_message_id = request_info.request_message_id
        pty_id = body.get("pty_id") or body.get("shell_id")
        since_seq = body.get("since_seq")

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

        # Snapshot the replay buffer BEFORE attaching the connection.
        # Once attached, live PTY output starts flowing to this connection via
        # on_pty_output.  Taking the snapshot first avoids a race where live
        # output (with high seq) arrives at the client before the replay (low
        # seq), which would cause the client's dedup to reject the replay.
        replay_chunks = []
        if since_seq is not None:
            logging.info(f"[PTY] Snapshotting replay buffer from seq {since_seq}, shell_id={pty_id}")
            replay_chunks = pty_handle.snapshot(since_seq)
            logging.info(f"[PTY] Snapshotted {len(replay_chunks)} chunks for shell_id={pty_id}")

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

        # Send replay chunks (snapshot was taken before attach to avoid races)
        if replay_chunks:
            handler = get_connection_handler(TypeId(type=Connection.get_type(), id=request_connection_id))
            if handler:
                for i, chunk in enumerate(replay_chunks):
                    pty_msg = PtyOutputMessage(
                        provider_node_id=self.node_provider_id,
                        shell_id=pty_id,
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
                                session_id=pty_id,
                                message_id=replay_msg_id,
                                response_message_id=replay_msg_id,  # Use unique ID, not request_message_id
                                content=pty_msg,
                            ).model_dump()
                        )
                    except Exception as e:
                        logging.warn(f"[PTY] Failed to send replay chunk {i + 1}: {e}")

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
        request_info = get_current_request_info()
        if not request_info or not request_info.request_message_id:
            return ApiFailResponse(message="Invalid request context")
        request_message_id = request_info.request_message_id

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
            from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus

            record = ShellRecord.get(shell_id)
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
