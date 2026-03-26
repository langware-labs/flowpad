"""Agentic processor backend for flow-cli.

Supports the full AgenticProcessor action surface:
- POST /api/v1/graph/apu (compatibility factory)
- POST /api/v1/graph/agentic_processor/{id}/controlStart
- POST /api/v1/graph/agentic_processor/{id}/controlAppend
- POST /api/v1/graph/agentic_processor/{id}/controlInput
- POST /api/v1/graph/agentic_processor/{id}/controlAbort
- POST /api/v1/graph/agentic_processor/{id}/controlStep
- POST /api/v1/graph/agentic_processor/{id}/controlContinue
- GET  /api/v1/graph/agentic_processor/{id}/state
- POST /api/v1/graph/agentic_processor/{id}/runFile
- POST /api/v1/graph/agentic_processor/{id}/run
- POST /api/v1/graph/agentic_processor/{id}/execute
- POST /api/v1/graph/agentic_processor/{id}/createProcess

It parses AMD `flow-ui` directives, emits websocket `flow_data_msg` events, and
updates processor state via normal entity update notifications.

Desktop mode: No Flow entity, single @local compute node, simplified execution.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import shutil
import sys
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from pydantic import BaseModel, SerializationInfo, model_serializer

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.app.actions.listen import set_plan_auto_approve
from flow_sdk.core import Entity, action
from flow_sdk.core.entity.entity_model import EntityExpansion
from flow_sdk.fs_records.agentic_process_record import ProcessorStatus
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


class StackFrame(BaseModel):
    frame_id: str
    type: str
    instruction_id: str
    index: int = 0
    source_vfs_path: str | None = None
    local_variables: dict[str, Any] = {}
    iterator_name: str | None = None
    iterator_index: int | None = None
    iterator_total: int | None = None


class DebugState(BaseModel):
    enabled: bool = False
    breakpoints: list[str] = []
    step_mode: str | None = None


class ProcessorState(BaseModel):
    status: str = ProcessorStatus.IDLE.value
    index: int = 0
    total_instructions: int = 0
    current_instruction_id: str | None = None
    variables: dict[str, Any] = {}
    waiting_for_input: bool = False
    input_id: str | None = None
    stack: list[dict[str, Any]] = []
    debug: dict[str, Any] = {"enabled": False, "breakpoints": [], "step_mode": None}
    error: str | None = None
    mdo_content: str | None = None


class AgenticContext(BaseModel):
    permission_mode: str | None = None
    workdir: str | None = None
    model: str | None = None
    max_thinking_tokens: int | None = None
    compute_node_id: str | None = None


class ContextData(BaseModel):
    """Serialized context data from frontend.

    Note: compute_node_id is NOT passed from frontend - it's a security-sensitive
    field set by the backend when AgenticProcessor is created via ComputeNode action.
    """

    instructions: str | None = None
    workdir: str | None = None
    env_vars: dict[str, str] = {}
    model: str | None = None
    max_thinking_tokens: int = 1024
    permission_mode: str = "bypassPermissions"
    project_id: str | None = None  # Project to associate the process with
    agents_json: dict[str, Any] | None = None  # Claude Code --agents spec


class ControlStartRequest(BaseModel):
    """Request to start execution."""

    mdo_content: str | None = None
    source_vfs_path: str | None = None  # VFS path of the executing skill file for UI URI resolution
    debug: bool = False
    breakpoints: list[str] = []


class ControlInputRequest(BaseModel):
    """Request to provide input for blocking UI."""

    input_data: str | None = None
    input_id: str | None = None


class ControlStepRequest(BaseModel):
    """Request to step in debug mode."""

    step_mode: str = "over"


class ControlAppendRequest(BaseModel):
    """Request to append a new instruction to a running process."""

    content: str
    instruction_id: str | None = None


class ControlContinueRequest(BaseModel):
    """Request to continue a completed process with new instruction."""

    agentic_process_id: str  # ID of the completed process to continue
    mdo_content: str  # New instruction content to execute
    debug: bool = False
    breakpoints: list[str] = []


class RunFileRequest(BaseModel):
    """Request to run an instruction file from VFS path."""

    vfs_path: str
    debug: bool = False
    breakpoints: list[str] = []


class RunRequest(BaseModel):
    """Request to run instruction content with context."""

    instruction_content: str
    context: ContextData | dict[str, Any] = {}
    debug: bool = False
    breakpoints: list[str] = []


class ExecuteRequest(BaseModel):
    """Request to execute instruction content directly (no file parsing).

    This is a simpler API that takes just the instruction text and context.
    The instruction is wrapped in AMD format if needed.
    """

    instruction_content: str  # Plain text or AMD instruction content
    context: ContextData | dict[str, Any] = {}
    debug: bool = False
    breakpoints: list[str] = []


class ProcessResultRequest(BaseModel):
    """Optional result metadata to create a ProcessResult child for a process."""

    uname: str | None = None
    result_type: str | None = None
    source_session_id: str | None = None


class CreateProcessRequest(BaseModel):
    """Request to create a new idle process ready for execute() calls."""

    context: ContextData | dict[str, Any] = {}
    result: ProcessResultRequest | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _default_processor_state() -> dict[str, Any]:
    return ProcessorState().model_dump()


class _UIItem(BaseModel):
    ui_id: str
    uri: str | None = None
    page: str | None = None
    params: dict[str, Any] = {}
    blocking: bool = True
    content: str | None = None


_FLOW_UI_RE = re.compile(r"<!--\s*<flow-ui\s+(.*?)\/>\s*-->", re.IGNORECASE | re.DOTALL)
_ATTR_RE = re.compile(r"""([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")


def _parse_flow_ui_items(mdo_content: str) -> list[_UIItem]:
    items: list[_UIItem] = []
    for idx, match in enumerate(_FLOW_UI_RE.finditer(mdo_content or "")):
        raw_attrs = match.group(1)
        attrs: dict[str, str] = {}
        for attr_match in _ATTR_RE.finditer(raw_attrs):
            key = attr_match.group(1)
            value = attr_match.group(2) if attr_match.group(2) is not None else (attr_match.group(3) or "")
            attrs[key] = value

        ui_id = attrs.get("id", f"ui_{idx}")
        uri = attrs.get("uri")
        page = attrs.get("page")
        non_blocking = attrs.get("non-blocking", "false").strip().lower() == "true"

        params: dict[str, Any] = {}
        raw_params = attrs.get("params")
        if raw_params:
            try:
                loaded = json.loads(raw_params)
                if isinstance(loaded, dict):
                    params = loaded
            except Exception:
                logger.warning("Failed parsing flow-ui params for %s", ui_id)

        items.append(
            _UIItem(
                ui_id=ui_id,
                uri=uri,
                page=page,
                params=params,
                blocking=not non_blocking,
            )
        )
    return items


async def _send_flow_data_message(target_type: str, target_id: str, payload: dict[str, Any]) -> None:
    """Emit a websocket flow_data message to watchers of the target entity."""
    try:
        from flow_sdk.app.actions.watch_registry import get_watched_by
        from flow_sdk.core.network.connections import get_all_connections
    except Exception as exc:
        logger.warning("Unable to import watch/connection helpers for flow_data emit: %s", exc)
        return

    entity_key = f"{target_type}:{target_id}"
    recipients = get_watched_by(entity_key)
    if not recipients:
        return

    active_connections = get_all_connections()
    message = {
        "message_type": "flow_data_msg",
        "message_id": str(uuid4()),
        "to_entity": f"{target_type}-{target_id}",
        "flow_data": payload,
    }
    message_json = json.dumps(message)

    for connection_id in recipients:
        ws = active_connections.get(connection_id)
        if not ws:
            continue
        try:
            await ws.send_text(message_json)
        except Exception as exc:
            logger.warning("Failed sending flow_data to %s: %s", connection_id, exc)




async def _run_claude_subprocess(
    agentic_process_id: str,
    process_type: str,
    instruction: str,
    worker_session_id: str,
    context_data: dict[str, Any],
    workdir: str | None = None,
) -> None:
    """Run claude CLI in background and update AgenticProcess state when done."""
    try:
        claude_bin = shutil.which("claude")
        if not claude_bin:
            logger.error("AgenticProcess %s: claude binary not found in PATH", agentic_process_id)
            process = await AgenticProcess.get_by_id(agentic_process_id)
            if process:
                process._set_process_state(status=ProcessorStatus.ERROR.value, error="claude binary not found")
                await process.save()
            return

        process_entity = await AgenticProcess.get_by_id(agentic_process_id)
        workdir = (process_entity.workdir if process_entity else None) or os.getcwd()
        permission_mode = context_data.get("permission_mode", "bypassPermissions")
        model: str | None = context_data.get("model")
        extra_env_vars: dict[str, str] = context_data.get("env_vars") or {}

        env = os.environ.copy()
        env.update(extra_env_vars)
        env["CLAUDE_PROJECT_DIR"] = workdir
        env["FLOWPAD_EXECUTION_SCOPE"] = json.dumps([{"type": process_type, "id": agentic_process_id}])
        # Allow Claude to run even when launched from inside a Claude Code session
        env.pop("CLAUDECODE", None)

        debug: bool = context_data.get("debug", True)
        resume_session_id: str | None = context_data.get("resume_session_id")
        fork_session: bool = bool(context_data.get("fork_session") and resume_session_id)

        args = [claude_bin]
        if permission_mode == "bypassPermissions":
            args.append("--dangerously-skip-permissions")
        if debug:
            args.append("--debug")
        if resume_session_id:
            args.extend(["--resume", resume_session_id])
            if fork_session:
                args.append("--fork-session")
        else:
            args.extend(["--session-id", worker_session_id])
        if model:
            args.extend(["--model", model])
        agents_json: dict | None = context_data.get("agents_json")
        if agents_json:
            args.extend(["--agents", json.dumps(agents_json)])
        args.extend(["-p", instruction])

        logger.info(
            "AgenticProcess %s: launching claude, workdir=%s args=%s",
            agentic_process_id,
            workdir,
            " ".join(shlex.quote(a) for a in args[1:]),
        )

        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=workdir,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await proc.communicate()
        output = stdout_bytes.decode("utf-8", errors="replace")
        error_output = stderr_bytes.decode("utf-8", errors="replace")

        logger.info(
            "AgenticProcess %s: claude exited code=%d output_len=%d",
            agentic_process_id,
            proc.returncode,
            len(output),
        )

        if output:
            await _send_flow_data_message(
                process_type,
                agentic_process_id,
                {
                    "element_type": "chat",
                    "data_type": "string",
                    "flow_value": output,
                    "attributes": {"element-type": "chat", "t": _now_iso()},
                },
            )

        process = await AgenticProcess.get_by_id(agentic_process_id)
        if process:
            if proc.returncode != 0:
                err_msg = error_output or f"claude exited with code {proc.returncode}"
                process._set_process_state(status=ProcessorStatus.ERROR.value, error=err_msg)
            else:
                process._set_process_state(status=ProcessorStatus.COMPLETE.value)
            await process.save()

        # Always send completion status FlowData so the frontend output() generator terminates
        is_success = proc.returncode == 0
        await _send_flow_data_message(
            process_type,
            agentic_process_id,
            {
                "element_type": "status",
                "flow_value": {"status": ProcessorStatus.COMPLETE.value if is_success else ProcessorStatus.ERROR.value},
                "attributes": {
                    "element-type": "status",
                    "complete": "true",
                    "t": _now_iso(),
                },
            },
        )

    except Exception as exc:
        logger.exception("AgenticProcess %s: background claude error: %s", agentic_process_id, exc)
        try:
            process = await AgenticProcess.get_by_id(agentic_process_id)
            if process:
                process._set_process_state(status=ProcessorStatus.ERROR.value, error=str(exc))
                await process.save()
            await _send_flow_data_message(
                process_type,
                agentic_process_id,
                {
                    "element_type": "status",
                    "flow_value": {"status": ProcessorStatus.ERROR.value},
                    "attributes": {
                        "element-type": "status",
                        "complete": "true",
                        "t": _now_iso(),
                    },
                },
            )
        except Exception:
            pass


class AgenticProcess(Entity):
    _api_visible = True
    type: str = APIField(default="agentic_process")

    processor_id: str | None = APIField(default=None)
    instruction_content: str | None = APIField(default=None)
    source_vfs_path: str | None = APIField(default=None)
    context: dict[str, Any] = APIField(default_factory=dict)
    context_data: dict[str, Any] = APIField(default_factory=dict)
    cli_config: dict[str, Any] = APIField(default_factory=dict)
    workdir: str | None = APIField(default=None)
    favorite_index: int | None = APIField(default=None)
    state: dict[str, Any] = APIField(default_factory=_default_processor_state)
    worker_session_id: str | None = APIField(default=None)
    use_worker_history: bool = APIField(default=False)
    project_id: str | None = APIField(default=None)
    project_encoded_name: str | None = APIField(default=None)
    compute_node_id: str | None = APIField(default=None)
    shell_id: str | None = APIField(default=None)
    sidecar_shell_id: str | None = APIField(default=None)
    visible: bool = APIField(default=False, description="Whether this process is visible in the tabs view")
    is_active: bool = APIField(default=False)
    queue: dict | None = APIField(default=None)

    @property
    def cli_cmd(self):
        """Build a WorkerCLICommand from stored cli_config + entity fields.

        The returned command object has session_id and workdir injected from
        the entity. Callers add runtime env vars via add_env() before calling
        to_shell_string().
        """
        from flow_sdk.builtin.cli_workers import factory as _cli_factory
        cmd = _cli_factory(self.cli_config, worker_type="claude")
        cmd.session_id = self.worker_session_id
        cmd.workdir = self.workdir
        if cmd.workdir:
            cmd.env_vars.setdefault("CLAUDE_PROJECT_DIR", cmd.workdir)
        return cmd


    def _is_exist_claude_resume_session(self, claude_session_id: str | None) -> bool:
        """Check if there's a resumable Claude session for this agentic process."""
        return self._discover_claude_record_session(claude_session_id) is not None
    
    
    def _discover_claude_record_session(self, claude_session_id: str | None) -> ClaudeSessionRecord | None:
        """Discover the ClaudeSessionRecord associated with this agentic process's worker_session_id."""
        if not claude_session_id:
            return None

        return ClaudeSessionRecord.discover_one(claude_session_id)


    def _discover_status_from_transcript(self) -> str | None:
        """Derive status from the Claude session transcript record.

        Delegates to ``ClaudeSessionRecord.status`` which tracks the
        last assistant ``stop_reason`` during JSONL parsing.
        Returns the status string, or None if no transcript is available.
        """
        
        session = self._discover_claude_record_session(self.worker_session_id)
        return session.status if session else None

    def _get_process_state(self) -> dict[str, Any]:
        if not isinstance(self.state, dict):
            self.state = _default_processor_state()
        state = dict(self.state)

        # Derive status from transcript if available
        transcript_status = self._discover_status_from_transcript()
        if transcript_status is not None:
            state["status"] = transcript_status

        return state

    def _set_process_state(self, **updates: Any) -> None:
        if not isinstance(self.state, dict):
            self.state = _default_processor_state()
        state = dict(self.state)
        state.update(updates)
        self.state = state

    @model_serializer(mode="wrap")
    def api_json_serializer(self, nxt, info: SerializationInfo):
        if info.context and info.context.get("skip_api_serializer"):
            return nxt(self)
        data = nxt(self)
        if data is None:
            return None
        if data.get("expand") is None or (isinstance(data.get("expand"), dict) and not data["expand"]):
            data["expand"] = EntityExpansion()
        data = {key: value for key, value in data.items() if value is not None and self.is_api_field(key)}
        return data

    @action.all(action_name="control")
    async def control(self):
        """Unified control action dispatched by sub_path.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Routes to internal control methods based on sub_path:
        - /control/pause - Pause message processing
        - /control/resume - Resume message processing
        - /control/inject - Inject a new message

        Returns:
            ApiResponse with status or error message
        """
        request_info = get_current_request_info()
        if request_info is None:
            return ApiFailResponse(message="No request context available")

        sub_action = request_info.sub_path
        if not sub_action:
            return ApiFailResponse(message="Missing sub_path for control action")

        # Remove leading slash if present
        sub_action = sub_action.lstrip("/")

        if sub_action == "pause":
            return await self._control_pause()
        elif sub_action == "resume":
            return await self._control_resume()
        elif sub_action == "inject":
            return await self._control_inject(request_info)
        else:
            return ApiFailResponse(message=f"Unknown control action: {sub_action}")

    async def _control_pause(self):
        """Pause message processing."""
        logger.info(f"AgenticProcess {self.id}: control/pause")
        self._set_process_state(status=ProcessorStatus.PAUSED.value)
        await self.save()
        return ApiSuccessResponse(data={"status": ProcessorStatus.PAUSED.value})

    async def _control_resume(self):
        """Resume message processing after pause."""
        logger.info(f"AgenticProcess {self.id}: control/resume")
        self._set_process_state(status=ProcessorStatus.RUNNING.value)
        await self.save()
        return ApiSuccessResponse(data={"status": ProcessorStatus.RUNNING.value})

    async def _control_inject(self, request_info):
        """Inject a new message into the worker's input queue."""
        # Get message from request parameters or POST body
        message = None
        if request_info.request_parameters:
            message = request_info.request_parameters.get("message")
        if not message:
            post_data = await request_info.get_post_data()
            if isinstance(post_data, dict):
                message = post_data.get("message")

        if not message:
            return ApiFailResponse(message="Missing 'message' parameter")

        logger.info(f"AgenticProcess {self.id}: control/inject message: {message[:80]}...")

        # Desktop stub: no active worker, log and return success
        return ApiSuccessResponse(data={"injected": True, "message_length": len(message)})

    @action.get(action_name="input-dir")
    async def get_input_dir(self):
        """Return the absolute path of this process's input directory, creating it if needed."""
        from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
        from flow_sdk.fs_store.record import get_default_records_root, record_stem

        record = None
        try:
            record = AgenticProcessRecord.discover_one(self.id)
        except Exception:
            pass

        if record and record.record_dir:
            input_dir = record.input_dir
        else:
            uid = self.id
            root = get_default_records_root()
            record_dir = root / AgenticProcessRecord._record_type / record_stem(AgenticProcessRecord._record_type, uid)
            input_dir = record_dir / "input"
            input_dir.mkdir(parents=True, exist_ok=True)

        compute_node_id = self.compute_node_id or "compute_node-@local"

        return ApiSuccessResponse(
            data={
                "abs_path": str(input_dir),
                "compute_node_id": compute_node_id,
            }
        )

    @action.all(action_name="queue")
    async def queue_action(self, enabled: bool | None = None, entries: list | None = None):
        """GET returns the prompt queue; POST updates it."""
        from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
        from flow_sdk.fs_store.record import get_default_records_root, record_stem

        request_info = get_current_request_info()
        method = (request_info.method if request_info else "get").lower()

        record = None
        try:
            record = AgenticProcessRecord.discover_one(self.id)
        except Exception:
            pass

        # Resolve record_data_dir: prefer discovered record, fall back to computed path
        if record and record.record_dir:
            record_data_dir = record.record_dir
        else:
            uid = self.id
            root = get_default_records_root()
            record_data_dir = root / AgenticProcessRecord._record_type / record_stem(AgenticProcessRecord._record_type, uid)

        if method == "get":
            queue_path = record_data_dir / "queue.json"
            if queue_path.exists():
                try:
                    return ApiSuccessResponse(data=json.loads(queue_path.read_text()))
                except Exception:
                    pass
            return ApiSuccessResponse(data={"enabled": True, "entries": []})

        # POST: update queue.json
        record_data_dir.mkdir(parents=True, exist_ok=True)
        queue_path = record_data_dir / "queue.json"
        current = json.loads(queue_path.read_text()) if queue_path.exists() else {"enabled": True, "entries": []}
        if enabled is not None:
            current["enabled"] = enabled
        if entries is not None:
            current["entries"] = entries
        queue_path.write_text(json.dumps(current, indent=2))
        return ApiSuccessResponse(data=current)

    @action.get(action_name="get-history")
    async def get_history(self):
        """Get the execution history for this process.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Desktop stub: returns empty history (no worker/blob storage in desktop mode).

        Returns:
            ApiSuccessResponse with list of FlowData items
        """
        return ApiSuccessResponse(
            data={
                "history": [],
                "count": 0,
                "worker_session_id": self.worker_session_id,
                "use_worker_history": self.use_worker_history,
            }
        )

    @action.all(action_name="step")
    async def step_action(self):
        """Execute one instruction step.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Desktop stub: validates status and returns step result.

        Returns:
            ApiSuccessResponse with step result
        """
        state = self._get_process_state()

        if state.get("status") == ProcessorStatus.TERMINATED.value:
            return ApiFailResponse(message="Process has been terminated")

        if state.get("status") == ProcessorStatus.RUNNING.value:
            return ApiFailResponse(message="Process is already running")

        logger.info(f"AgenticProcess {self.id}: step action")

        try:
            # Desktop mode: set status back to idle (no real instruction execution)
            self._set_process_state(status=ProcessorStatus.IDLE.value)
            await self.save()

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": self._get_process_state().get("status"),
                    "index": self.state.get("index", 0) if isinstance(self.state, dict) else 0,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} step error: {e}")
            self._set_process_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    async def close(self) -> bool:
        """Terminate this process and close its linked shell.

        Returns True on success, False if already terminated or on error.
        """
        if self._get_process_state().get("status") == ProcessorStatus.TERMINATED.value:
            logger.debug("[AgenticProcess] close() skipped for %s: already terminated", self.id)
            return False

        logger.info(f"AgenticProcess {self.id}: close")

        try:
            shell_id = self.shell_id
            if shell_id:
                self.shell_id = None
                self.sidecar_shell_id = None

            self._set_process_state(status=ProcessorStatus.TERMINATED.value)
            await self.save()

            if shell_id:
                from flow_sdk.builtin.shell import Shell
                shell = await Shell.get_by_id(shell_id)
                if shell:
                    await shell.close()

            return True

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} close error: {e}")
            return False

    @action.all(action_name="exit")
    async def exit_action(self):
        """Terminate this process.

        Ported from FlowPad: flowpad/hub/core/agentic_processor/process.py
        Delegates to close(), then returns an ApiResponse for the HTTP layer.

        Returns:
            ApiSuccessResponse confirming termination
        """
        if not await self.close():
            return ApiFailResponse(message="Process already terminated or close failed")

        return ApiSuccessResponse(
            data={
                "id": self.id,
                "status": ProcessorStatus.TERMINATED.value,
                "terminated": True,
            }
        )

    # ============ PTY Lifecycle ============

    async def _find_resumable_session(self, session_id: str) -> str | None:
        """Walk up the fork chain to find a session ID with a transcript on disk.

        Claude CLI doesn't always create a .jsonl for forked sessions,
        so fork-of-fork needs to find the nearest ancestor that does.
        Returns the session ID with a transcript, or None if none found.
        """
        candidate: str | None = session_id
        seen: set[str] = set()
        while candidate and candidate not in seen:
            seen.add(candidate)
            if ClaudeSessionRecord.discover_one(candidate) is not None:
                return candidate
            procs = await AgenticProcess.get_all()
            parent = next((p for p in procs if p.worker_session_id == candidate), None)
            candidate = parent.context_data.get("resume_session_id") if parent else None
        return None

    async def _open_shell(
        self,
        reuse_id: str | None = None,
        name: str | None = None,
        workdir: str | None = None,
        compute_node: Any = None,
    ) -> Any:
        """Get existing shell by reuse_id, or create a new one."""
        from flow_sdk.builtin.shell import Shell

        if reuse_id:
            shell = await Shell.get_by_id(reuse_id)
            if shell:
                return shell

        # Restore tab_order saved by stop() so the restarted shell keeps its
        # position.  For brand-new shells, append after all existing ones.
        prev = self.context_data.pop("_prev_tab_order", None)
        tab_order = prev if prev is not None else await Shell.next_tab_order()

        shell = Shell(
            compute_node_id=compute_node.id if compute_node else None,
            name=name,
            workdir=workdir,
            tab_order=tab_order,
        )
        await shell.save()
        return shell

    def _make_pty_exit_callback(self) -> Callable[[int | None], None]:
        """Create a callback for PTY process exit that updates process state.

        Captures agentic_process_id and the running event loop. The callback is called
        from the daemon reader thread, so it schedules the async state update
        via run_coroutine_threadsafe.
        """
        main_loop = asyncio.get_running_loop()
        agentic_process_id = self.id

        def _on_pty_exit(exit_code: int | None) -> None:
            async def _update_state():
                try:
                    proc = await AgenticProcess.get_by_id(agentic_process_id)
                    if not proc:
                        return
                    # If shell_id is already cleared, stop() handled the
                    # transition. Don't overwrite with complete/error.
                    if not proc.shell_id:
                        logger.info(
                            "AgenticProcess %s: PTY exited (code=%s), skipping — already handled by stop",
                            agentic_process_id,
                            exit_code,
                        )
                        return
                    # Detach from the shell but do NOT delete it — the user
                    # may still see the tab and click X, which calls shell.close().
                    proc.shell_id = None
                    proc.sidecar_shell_id = None

                    if exit_code is not None and exit_code != 0:
                        proc._set_process_state(
                            error=f"claude exited with code {exit_code}",
                        )
                    else:
                        # Clean exit (code 0): transition back to idle
                        proc._set_process_state(status=ProcessorStatus.IDLE.value)
                    await proc.save()

                    logger.info(
                        "AgenticProcess %s: PTY exited (code=%s), state updated",
                        agentic_process_id,
                        exit_code,
                    )
                except Exception as exc:
                    logger.warning("AgenticProcess %s: on_exit update failed: %s", agentic_process_id, exc)

            asyncio.run_coroutine_threadsafe(_update_state(), main_loop)

        return _on_pty_exit

    async def _resolve_compute_node(self):
        """Resolve the ComputeNode for this process.

        Uses compute_node_id if set, otherwise falls back to @local node.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        if self.compute_node_id:
            # compute_node_id is stored as "compute_node-<id>"
            parts = self.compute_node_id.split("-", 1)
            if len(parts) == 2:
                node = await ComputeNode.get_by_id(parts[1])
                if node:
                    return node

        # Desktop fallback: always @local
        return await ComputeNode.get_by_uname("local")

    async def _send_pty_raw(self, compute_node, data: bytes) -> None:
        """Send raw bytes into an already-running PTY session."""
        from flow_sdk.builtin.faas.pty_session_manager import session_manager

        shell_id = self.shell_id
        if not shell_id:
            raise RuntimeError("PTY session has no shell_id")
        if not compute_node.node_provider_id:
            raise RuntimeError("Compute node provider ID not set")

        pty_key = (compute_node.id, compute_node.node_provider_id, shell_id)
        session_state = await session_manager.get_session(pty_key)
        cols = session_state.cols if session_state else 80
        rows = session_state.rows if session_state else 24

        await compute_node.compute_provider.send_pty_input(
            compute_node.node_provider_id,
            shell_id,
            data,
            cols,
            rows,
        )

    async def _send_command_to_pty(self, compute_node, command: str) -> None:
        """Send a command into an already-running PTY session."""
        await self._send_pty_raw(compute_node, f"{command}\r".encode())

    @action.post(action_name="open")
    async def open(self, instruction: str | None = None, worker_session_id: str | None = None, visible: bool | None = None):
        """Open (or reopen) this AgenticProcess — starts fresh or resumes automatically.

        Covers all cases:
        - Fresh open (no previous session): spawns Claude with --session-id.
        - Reopen after server restart (stale shell, dead PTY): Shell.start_pty() detects
          the dead PTY, cleans up, and spawns Claude with --resume.
        - Idempotent call on live process: Shell.start_pty() detects alive PTY and returns
          ApiSuccessResponse without re-spawning.

        The frontend calls open() on every navigation to an agentic-process URL;
        the backend decides whether to start fresh, resume, or do nothing.
        """

        state = self._get_process_state()
        if state.get("status") == ProcessorStatus.TERMINATED.value:
            return ApiFailResponse(message="Process has been terminated")


        # Detect restart: process previously had a shell session.
        # Captured before _open_shell so it reflects the pre-call state.
        had_previous_session = bool(self.shell_id)

        compute_node = await self._resolve_compute_node()
        if not compute_node:
            return ApiFailResponse(message="No compute node available")

        try:
            self.worker_session_id = worker_session_id or self.worker_session_id or str(uuid4())
            self.compute_node_id = str(compute_node.typeid)

            # Discover project_id if not already set (check context_data fallback, then DB ancestor)
            if not self.project_id:
                if self.context_data.get("project_id"):
                    self.project_id = self.context_data["project_id"]
                else:
                    from flow_sdk.builtin.project import Project
                    ancestor = await Project.get_ancestor(self.typeid)
                    if ancestor:
                        self.project_id = ancestor.id

            # Resolve workdir and project_encoded_name from project_id if not already set
            if self.project_id and (not self.workdir or not self.project_encoded_name):
                from flow_sdk.builtin.project import Project
                project = await Project.get_by_id(self.project_id)
                if project and project.fs_storage_mount_path:
                    if not self.workdir:
                        self.workdir = str(project.fs_storage_mount_path)
                    if not self.project_encoded_name:
                        self.project_encoded_name = project.project_encoded_name

            # Build the CLI command from cli_config + entity fields
            cmd = self.cli_cmd

            # Server-restart resume: process had a shell but cli_config didn't encode resume
            if not cmd.resume and self.shell_id:
                cmd.resume = self._is_exist_claude_resume_session(self.worker_session_id)

            # Fork: resolve chain to nearest ancestor with a transcript on disk
            if cmd.fork_session_id:
                cmd.fork_session_id = await self._find_resumable_session(cmd.fork_session_id)

            # When resuming, ensure CLAUDE_PROJECT_DIR points to where the session lives.
            # The stored workdir may be a parent directory; use session cwd to be precise.
            if cmd.resume and self.worker_session_id:
                session_rec = self._discover_claude_record_session(self.worker_session_id)
                if session_rec and session_rec.cwd:
                    cmd.env_vars["CLAUDE_PROJECT_DIR"] = session_rec.cwd
                    cmd.workdir = session_rec.cwd

            # Runtime env injection (process identity for hook routing)
            cmd.add_env(
                "FLOWPAD_EXECUTION_SCOPE",
                json.dumps([{"type": self.get_type(), "id": self.id}]),
            )

            is_resume = cmd.resume
            is_fork = bool(cmd.fork_session_id)
            command = cmd.to_shell_string(instruction=instruction)

            workdir = self.workdir
            session_name = f"Claude - {self.worker_session_id[:8]} ({'fork' if is_fork else 'resume' if is_resume else 'new'})"
            shell = await self._open_shell(
                reuse_id=self.shell_id,   # reuse existing tab on restart; None for fresh open
                name=session_name,
                workdir=workdir,
                compute_node=compute_node,
            )
            self.shell_id = shell.id
            on_exit = self._make_pty_exit_callback()

            logger.info(
                "AgenticProcess %s: %s shell %s (worker=%s)",
                self.id,
                "reopening" if had_previous_session else "opening",
                self.shell_id,
                self.worker_session_id,
            )

            started = await shell.start_pty(on_exit=on_exit)

            if started:
                await asyncio.sleep(1.0)  # let shell initialize and write prompt before injecting
                await compute_node.compute_provider.send_pty_input(
                    compute_node.node_provider_id, shell.id, f"{command}\r".encode(), None, None
                )

            self._set_process_state(status=ProcessorStatus.RUNNING.value, error=None)
            if visible is not None:
                self.visible = visible
            await self.save()

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": ProcessorStatus.RUNNING.value,
                    "shell_id": self.shell_id,
                    "worker_session_id": self.worker_session_id,
                    "compute_node_id": self.compute_node_id,
                    "shell": shell.model_dump(mode="json"),
                    "is_resume": is_resume,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} open error: {e}")
            self.shell_id = None
            self._set_process_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.post(action_name="stop")
    async def stop(self):
        """Stop the active shell session.

        Delegates all PTY teardown to Shell.close(). Preserves worker_session_id
        so the Claude conversation can be resumed later.

        Returns:
            ApiSuccessResponse confirming the stop.
        """
        if not self.shell_id:
            return ApiFailResponse(message="No active shell session")

        try:
            from flow_sdk.builtin.shell import Shell

            old_shell_id = self.shell_id

            # Preserve tab_order so open() can place the new shell in the same slot.
            shell = await Shell.get_by_id(old_shell_id)
            if shell:
                self.context_data = {**self.context_data, "_prev_tab_order": shell.tab_order}

            # Clear shell_id BEFORE closing so on_exit callback sees None and skips.
            self.shell_id = None
            self.sidecar_shell_id = None
            await self.save()

            if shell:
                await shell.close()
                logger.info("AgenticProcess %s: closed Shell entity %s", self.id, old_shell_id)
            else:
                logger.warning("AgenticProcess %s: Shell entity %s not found", self.id, old_shell_id)

            logger.info(
                "AgenticProcess %s: stopped (worker_session_id preserved: %s)",
                self.id,
                self.worker_session_id,
            )

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": ProcessorStatus.IDLE.value,
                    "shell_id": None,
                    "worker_session_id": self.worker_session_id,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} stop error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="execute-plan")
    async def execute_plan(
        self,
        file_path: str,
        clear_context: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """
        Tell Claude to execute the plan.
        If clear_context=True, inject '/clear' first.

        Sets the plan auto-approve flag so that when ExitPlanMode is called,
        the hook handler can auto-approve the PermissionRequest once.
        """
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            if clear_context:
                # Inject /clear command to reset context
                await self._control_inject_message("/clear")
                await asyncio.sleep(1)  # Wait for context to clear before sending the next command

            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>, if any, then execute plan"
            await self._control_inject_message(prompt)
            await asyncio.sleep(1.5)  # Wait for the command to be processed and the plan to be entered before setting auto-approve

            set_plan_auto_approve(self.id)

            return ApiSuccessResponse(data={"injected": True})
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} execute-plan error: {e}")
            return ApiFailResponse(message=str(e))

    @action.post(action_name="update-plan")
    async def update_plan(
        self,
        file_path: str,
    ) -> ApiSuccessResponse | ApiFailResponse:
        """
        Tell Claude to update the plan based on <plan-note> annotations.
        Claude reads the file itself; <plan-note> tags are left unchanged.
        """
        if not file_path:
            return ApiFailResponse(message="file_path is required")

        try:
            prompt = f"Update the plan in {file_path} based on comments marked as <plan-note>...</plan-note>"
            await self._control_inject_message(prompt)

            return ApiSuccessResponse(data={"ok": True})
        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} update-plan error: {e}")
            return ApiFailResponse(message=str(e))

    async def _control_inject_message(self, message: str) -> None:
        """Inject a message into the active PTY session for this process.

        Resolves the compute node, sends Escape to dismiss any active
        numeric prompt (e.g. Claude waiting for a numbered answer), then
        sends the message as PTY input.
        If no PTY session is active, logs a warning and returns silently.
        """
        if not self.shell_id:
            logger.warning("AgenticProcess %s: no active shell, cannot inject message", self.id)
            return

        compute_node = await self._resolve_compute_node()
        if not compute_node:
            logger.warning("AgenticProcess %s: no compute node, cannot inject message", self.id)
            return

        # Dismiss any active numeric prompt before injecting.
        # Terminal input parsers (Node.js libuv, readline, etc.) treat a lone
        # \x1b as the start of an escape sequence and wait ~100ms for more
        # bytes.  If our command arrives within that window the first byte is
        # swallowed as part of sequence parsing.  We therefore:
        #   1. Send a single \x1b — enough to trigger an Escape keypress.
        #   2. Sleep 200ms — longer than the escape-sequence timeout — so the
        #      handler commits "Escape pressed" and Claude transitions state
        #      before the command bytes arrive.
        await self._send_pty_raw(compute_node, b"\x1b")
        await asyncio.sleep(0.2)

        logger.info("AgenticProcess %s: injecting message: %s", self.id, message[:80])
        await self._send_command_to_pty(compute_node, message)

    # ============ Legacy Execute (headless subprocess) ============

    @action.post(action_name="execute")
    async def execute_action(self, instruction: str | None = None, worker_session_id: str | None = None):
        """Execute an instruction on this process via Claude Code CLI.

        Launches claude as a headless subprocess.

        Args:
            instruction: The instruction text to execute
            worker_session_id: Optional pre-generated session ID. If not provided, one is generated.

        Returns:
            ApiSuccessResponse with RUNNING status and worker_session_id
        """
        if not instruction:
            return ApiFailResponse(message="instruction is required")

        state = self._get_process_state()
        if state.get("status") == ProcessorStatus.TERMINATED.value:
            return ApiFailResponse(message="Process has been terminated")

        if state.get("status") == ProcessorStatus.RUNNING.value:
            return ApiFailResponse(message="Process is already running")

        try:
            worker_session_id = worker_session_id or str(uuid4())
            self.worker_session_id = worker_session_id

            logger.info(
                f"AgenticProcess {self.id}: execute instruction "
                f"processor={self.processor_id} session={worker_session_id}: "
                f"{instruction[:80]}..."
            )
            self._set_process_state(status=ProcessorStatus.RUNNING.value)
            await self.save()

            asyncio.create_task(
                _run_claude_subprocess(
                    agentic_process_id=self.id,
                    process_type=self.get_type(),
                    instruction=instruction,
                    worker_session_id=worker_session_id,
                    context_data=dict(self.context_data),
                )
            )

            return ApiSuccessResponse(
                data={
                    "id": self.id,
                    "status": ProcessorStatus.RUNNING.value,
                    "worker_session_id": worker_session_id,
                    "instruction_executed": True,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcess {self.id} execute error: {e}")
            self._set_process_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))


class AgenticProcessor(Entity):
    _api_visible = True
    type: str = APIField(default="agentic_processor")

    worker_type: str = APIField(default="claude")
    state: dict[str, Any] = APIField(default_factory=_default_processor_state)
    active_agentic_process_id: str | None = APIField(default=None)
    queued_ui: list[dict[str, Any]] = APIField(default_factory=list)
    next_ui_index: int = APIField(default=0)
    process_seq: int = APIField(default=0)

    def _get_state(self) -> dict[str, Any]:
        if not isinstance(self.state, dict):
            self.state = _default_processor_state()
        return dict(self.state)

    def _set_state(self, **updates: Any) -> None:
        state = self._get_state()
        state.update(updates)
        self.state = state

    async def _sync_active_process_state(self) -> None:
        if not self.active_agentic_process_id:
            return
        process = await AgenticProcess.get_by_id(self.active_agentic_process_id)
        if not process:
            return
        process.state = self._get_state()
        await process.save()

    async def _emit_ui_process_data(self, ui_item: dict[str, Any]) -> None:
        ui_payload: dict[str, Any] = {
            "ui_id": ui_item["ui_id"],
            "params": ui_item.get("params", {}),
            "blocking": ui_item.get("blocking", True),
        }
        if ui_item.get("uri"):
            ui_payload["uri"] = ui_item["uri"]
        if ui_item.get("page"):
            ui_payload["page"] = ui_item["page"]
        if ui_item.get("content"):
            ui_payload["content"] = ui_item["content"]

        self.process_seq += 1
        attrs = {
            "element-type": "ui",
            "data-type": "object",
            "ui-id": ui_item["ui_id"],
            "i": str(self.process_seq),
            "t": _now_iso(),
        }
        message_payload = {
            "element_type": "ui",
            "data_type": "object",
            "flow_value": json.dumps(ui_payload),
            "attributes": attrs,
        }

        await _send_flow_data_message(self.get_type(), self.id, message_payload)

    async def _advance_execution(self) -> None:
        total = len(self.queued_ui)
        logger.info(f"AgenticProcessor {self.id}: advancing execution ({self.next_ui_index}/{total} items)")
        while self.next_ui_index < len(self.queued_ui):
            ui_item = self.queued_ui[self.next_ui_index]
            self.next_ui_index += 1
            logger.info(
                f"AgenticProcessor {self.id}: processing item {self.next_ui_index}/{total} "
                f"ui_id={ui_item.get('ui_id')} blocking={ui_item.get('blocking', True)}"
            )

            await self._emit_ui_process_data(ui_item)

            if ui_item.get("blocking", True):
                self._set_state(
                    status=ProcessorStatus.PAUSED.value,
                    waiting_for_input=True,
                    input_id=ui_item["ui_id"],
                    index=self.next_ui_index,
                )
                await self.save()
                await self._sync_active_process_state()
                logger.info(f"AgenticProcessor {self.id}: paused, waiting for input on {ui_item['ui_id']}")
                return

        self._set_state(
            status=ProcessorStatus.COMPLETE.value,
            waiting_for_input=False,
            input_id=None,
            index=self.next_ui_index,
        )
        await self.save()
        await self._sync_active_process_state()
        logger.info(f"AgenticProcessor {self.id}: execution complete ({total} items processed)")

    @action.post(action_name="controlStart")
    async def control_start(
        self,
        mdo_content: str | None = None,
        source_vfs_path: str | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        request_info = get_current_request_info()
        owner = request_info.someone_typeid if request_info else None

        self.queued_ui = []
        self.next_ui_index = 0
        self.process_seq = 0
        self._set_state(
            status=ProcessorStatus.IDLE.value,
            index=0,
            waiting_for_input=False,
            input_id=None,
            error=None,
            mdo_content=mdo_content,
            debug={
                "enabled": bool(debug),
                "breakpoints": breakpoints or [],
                "step_mode": None,
            },
        )

        process = AgenticProcess(
            processor_id=self.id,
            instruction_content=mdo_content,
            source_vfs_path=source_vfs_path,
            state=self._get_state(),
        )
        await process.save(owner)

        self.active_agentic_process_id = process.id
        await self.save(owner)
        return ApiSuccessResponse(data=process)

    @action.post(action_name="controlAppend")
    async def control_append(self, content: str, instruction_id: str | None = None):
        if not content:
            return ApiFailResponse(message="content is required")

        parsed_items = _parse_flow_ui_items(content)
        self.queued_ui = [item.model_dump() for item in parsed_items]
        self.next_ui_index = 0
        self.process_seq = 0

        state = self._get_state()
        total_instructions = int(state.get("total_instructions", 0)) + 1
        resolved_instruction_id = instruction_id or f"instr_{uuid4().hex[:10]}"

        self._set_state(
            status=ProcessorStatus.RUNNING.value,
            total_instructions=total_instructions,
            current_instruction_id=resolved_instruction_id,
            waiting_for_input=False,
            input_id=None,
            mdo_content=content,
            index=0,
        )
        await self.save()
        await self._sync_active_process_state()

        await self._advance_execution()

        return ApiSuccessResponse(
            data={
                "instructionId": resolved_instruction_id,
                "totalInstructions": total_instructions,
            }
        )

    @action.post(action_name="controlInput")
    async def control_input(self, input_data: str | None = None, input_id: str | None = None):
        state = self._get_state()
        if not state.get("waiting_for_input", False):
            return ApiFailResponse(message="Processor not waiting for input", status_code=400)

        state_variables = dict(state.get("variables", {}))
        if input_data:
            try:
                state_variables["last_input"] = json.loads(input_data)
            except Exception:
                state_variables["last_input"] = input_data
        if input_id:
            state_variables["last_input_id"] = input_id

        self._set_state(
            status=ProcessorStatus.RUNNING.value,
            waiting_for_input=False,
            input_id=None,
            variables=state_variables,
        )
        await self.save()
        await self._sync_active_process_state()

        await self._advance_execution()
        return ApiSuccessResponse(data=True)

    @action.post(action_name="controlAbort")
    async def control_abort(self):
        self.queued_ui = []
        self.next_ui_index = 0
        self.process_seq = 0
        self._set_state(
            status=ProcessorStatus.IDLE.value,
            waiting_for_input=False,
            input_id=None,
            error=None,
        )
        await self.save()
        await self._sync_active_process_state()
        return ApiSuccessResponse(data=True)

    @action.all(action_name="controlStep")
    async def control_step(self, step_mode: str = "over"):
        """Step to next instruction in debug mode.

        Args:
            step_mode: Step mode (over, into, out)

        Returns:
            Success response on step, error if not in debug mode
        """
        state = self._get_state()
        debug = state.get("debug", {})
        if not debug.get("enabled", False):
            return ApiFailResponse(message="Debug mode not enabled")

        if state.get("status") != ProcessorStatus.STEPPING.value:
            return ApiFailResponse(message="Processor not paused at breakpoint")

        try:
            debug["step_mode"] = step_mode
            self._set_state(
                status=ProcessorStatus.RUNNING.value,
                debug=debug,
            )
            await self.save()
            await self._sync_active_process_state()

            # In desktop mode, advance execution if there are queued UI items
            await self._advance_execution()

            return ApiSuccessResponse(data={"status": self._get_state().get("status")})

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} step error: {e}")
            self._set_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="controlContinue")
    async def control_continue(
        self,
        agentic_process_id: str | None = None,
        mdo_content: str | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        """Continue a completed process with new instruction content.

        This action loads an existing completed process, appends the new
        instruction, and continues execution.

        Args:
            agentic_process_id: ID of the completed process to continue
            mdo_content: New instruction content to execute
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess data with updated state
        """
        state = self._get_state()
        if state.get("status") == ProcessorStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not agentic_process_id:
            return ApiFailResponse(message="agentic_process_id is required")
        if not mdo_content:
            return ApiFailResponse(message="mdo_content is required")

        try:
            # Load the existing process from DB
            existing_process = await AgenticProcess.get_by_id(agentic_process_id)
            if not existing_process:
                return ApiFailResponse(message=f"Process not found: {agentic_process_id}")

            # Parse UI items from the new content
            parsed_items = _parse_flow_ui_items(mdo_content)
            self.queued_ui = [item.model_dump() for item in parsed_items]
            self.next_ui_index = 0
            self.process_seq = 0

            # Reset state for new execution
            self._set_state(
                status=ProcessorStatus.RUNNING.value,
                mdo_content=mdo_content,
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                waiting_for_input=False,
                input_id=None,
            )

            self.active_agentic_process_id = existing_process.id
            await self.save()

            # Sync state to existing process
            existing_process.instruction_content = mdo_content
            existing_process.state = self._get_state()
            await existing_process.save()

            # Advance execution
            await self._advance_execution()

            return ApiSuccessResponse(
                data={
                    "id": existing_process.id,
                    "type": existing_process.type,
                    "processor_id": existing_process.processor_id,
                    "instruction_content": existing_process.instruction_content,
                    "state": existing_process.state
                    if isinstance(existing_process.state, dict)
                    else existing_process.state,
                    "worker_session_id": existing_process.worker_session_id,
                    "resumed": True,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} controlContinue error: {e}")
            self._set_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="state")
    async def get_state(self):
        """Get current processor state."""
        return ApiSuccessResponse(data=self._get_state())

    @action.all(action_name="runFile")
    async def run_file(self, vfs_path: str | None = None, debug: bool = False, breakpoints: list[str] | None = None):
        """Run an instruction file from VFS path.

        This is the primary way to execute skill files. It loads the file
        from the VFS path and executes all instructions.

        Args:
            vfs_path: VFS path to the instruction file
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess entity data
        """
        state = self._get_state()
        if state.get("status") == ProcessorStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not vfs_path:
            return ApiFailResponse(message="vfs_path is required")

        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            # Try to load the file content via VFS/FS
            file_content = None
            try:
                from flow_sdk.api.fs_api import VFSPath

                vfs = VFSPath(vfs_path)
                # Attempt to read the file through the compute provider
                from pathlib import Path

                local_path = vfs.local_path if hasattr(vfs, "local_path") else None
                if local_path and Path(local_path).exists():
                    file_content = Path(local_path).read_text()
            except Exception as e:
                logger.warning(f"Could not load file from VFS path {vfs_path}: {e}")

            # Parse UI items if we got file content
            if file_content:
                parsed_items = _parse_flow_ui_items(file_content)
                self.queued_ui = [item.model_dump() for item in parsed_items]
            else:
                self.queued_ui = []

            self.next_ui_index = 0
            self.process_seq = 0

            self._set_state(
                status=ProcessorStatus.RUNNING.value,
                mdo_content=file_content or "",
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                index=0,
                waiting_for_input=False,
                input_id=None,
            )

            # Create process entity
            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=file_content or "",
                source_vfs_path=vfs_path,
                state=self._get_state(),
            )
            await process.save(owner)

            self.active_agentic_process_id = process.id
            await self.save(owner)

            # Advance execution
            await self._advance_execution()

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "source_vfs_path": process.source_vfs_path,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except FileNotFoundError:
            logger.error(f"AgenticProcessor {self.id} file not found: {vfs_path}")
            return ApiFailResponse(message=f"File not found: {vfs_path}")

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} runFile error: {e}")
            self._set_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="run")
    async def run(
        self,
        instruction_content: str | None = None,
        context: dict[str, Any] | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        """Run instruction content with context - returns AgenticProcess.

        This is the primary interface for the TypeScript SDK's processor.run() method.
        Creates an AgenticProcess, starts execution, and returns the entity data.

        Args:
            instruction_content: The instruction/AMD content to execute
            context: Context data (workdir, env_vars, model, etc.)
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess data (id, type, state, etc.)
        """
        state = self._get_state()
        if state.get("status") == ProcessorStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not instruction_content:
            return ApiFailResponse(message="instruction_content is required")

        logger.info(f"AgenticProcessor {self.id}: run started, content_len={len(instruction_content)}, debug={debug}")
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            context_data = context or {}

            # Parse UI items from instruction content
            parsed_items = _parse_flow_ui_items(instruction_content)
            self.queued_ui = [item.model_dump() for item in parsed_items]
            self.next_ui_index = 0
            self.process_seq = 0

            self._set_state(
                status=ProcessorStatus.RUNNING.value,
                mdo_content=instruction_content,
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                index=0,
                waiting_for_input=False,
                input_id=None,
            )

            # Create process entity
            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=instruction_content,
                context_data=context_data,
                state=self._get_state(),
            )
            await process.save(owner)
            logger.info(f"AgenticProcessor {self.id}: created process {process.id}")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            # Advance execution
            await self._advance_execution()

            logger.info(
                f"AgenticProcessor {self.id}: run finished, process={process.id} state={self._get_state().get('status')}"
            )
            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "context": process.context_data,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} run error: {e}")
            self._set_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="execute")
    async def execute(
        self,
        instruction_content: str | None = None,
        context: dict[str, Any] | None = None,
        debug: bool = False,
        breakpoints: list[str] | None = None,
    ):
        """Execute instruction content directly (no file parsing) - returns AgenticProcess.

        This is a simpler API than run() that takes instruction text directly.

        Args:
            instruction_content: Plain text or AMD instruction content
            context: Context data (workdir, env_vars, model, etc.)
            debug: Enable debug mode
            breakpoints: List of breakpoint IDs

        Returns:
            AgenticProcess data (id, type, state, etc.)
        """
        state = self._get_state()
        if state.get("status") == ProcessorStatus.RUNNING.value:
            return ApiFailResponse(message="Processor is already running")

        if not instruction_content:
            return ApiFailResponse(message="instruction_content is required")

        logger.info(
            f"AgenticProcessor {self.id}: execute started, content_len={len(instruction_content)}, debug={debug}"
        )
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            context_data = context or {}

            # Parse UI items from instruction content
            parsed_items = _parse_flow_ui_items(instruction_content)
            self.queued_ui = [item.model_dump() for item in parsed_items]
            self.next_ui_index = 0
            self.process_seq = 0

            self._set_state(
                status=ProcessorStatus.RUNNING.value,
                mdo_content=instruction_content,
                debug={
                    "enabled": bool(debug),
                    "breakpoints": breakpoints or [],
                    "step_mode": None,
                },
                error=None,
                index=0,
                waiting_for_input=False,
                input_id=None,
            )

            # Create process entity
            process = AgenticProcess(
                processor_id=self.id,
                instruction_content=instruction_content,
                context_data=context_data,
                state=self._get_state(),
            )
            await process.save(owner)
            logger.info(f"AgenticProcessor {self.id}: created process {process.id}")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            # Advance execution
            await self._advance_execution()

            logger.info(
                f"AgenticProcessor {self.id}: execute finished, process={process.id} state={self._get_state().get('status')}"
            )
            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "instruction_content": process.instruction_content,
                    "context": process.context_data,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} execute error: {e}")
            self._set_state(status=ProcessorStatus.ERROR.value, error=str(e))
            await self.save()
            return ApiFailResponse(message=str(e))

    @action.all(action_name="createProcess")
    async def create_process(
        self,
        context: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        visible: bool = False,
    ):
        """Create a new idle process ready for execute() calls.

        This creates a process in IDLE status that can accept instructions
        via the process.execute() action. The process stays alive until
        explicitly terminated via process.exit().

        Args:
            context: Context data (workdir, env_vars, model, etc.)
            result: Optional ProcessResult metadata

        Returns:
            AgenticProcess entity data in IDLE status
        """
        try:
            request_info = get_current_request_info()
            owner = request_info.someone_typeid if request_info else None

            context_data = dict(context or {})
            workdir = context_data.pop("workdir", None)

            # Create process in IDLE state
            idle_state = _default_processor_state()
            idle_state["status"] = ProcessorStatus.IDLE.value

            process = AgenticProcess(
                processor_id=self.id,
                instruction_content="",
                context_data=context_data,
                workdir=workdir,
                state=idle_state,
                visible=visible,
            )
            await process.save(owner)

            # Handle ProcessResult creation if requested
            if result and isinstance(result, dict):
                try:
                    from flow_sdk.builtin.process_result import ProcessResult

                    result_uname = result.get("uname")
                    existing_result = None
                    if result_uname:
                        existing_result = await ProcessResult.get_by_uname(result_uname)

                    if existing_result:
                        existing_result.agentic_process_id = process.id
                        existing_result.status = "running"
                        existing_result.result_type = result.get("result_type")
                        existing_result.source_session_id = result.get("source_session_id")
                        await existing_result.save(owner)
                    else:
                        process_result = ProcessResult(
                            uname=result_uname,
                            agentic_process_id=process.id,
                            status="running",
                            result_type=result.get("result_type"),
                            source_session_id=result.get("source_session_id"),
                        )
                        await process_result.save(owner)
                except ImportError:
                    logger.debug("ProcessResult entity not available, skipping result creation")

            self.active_agentic_process_id = process.id
            await self.save(owner)

            logger.info(f"AgenticProcessor {self.id} created process {process.id} in IDLE status")

            return ApiSuccessResponse(
                data={
                    "id": process.id,
                    "type": process.type,
                    "processor_id": process.processor_id,
                    "state": process.state if isinstance(process.state, dict) else process.state,
                }
            )

        except Exception as e:
            logger.exception(f"AgenticProcessor {self.id} createProcess error: {e}")
            return ApiFailResponse(message=str(e))


class APU(Entity):
    """Compatibility factory endpoint used by API tests.

    POST /graph/apu creates an `agentic_processor` and returns `{type:'apu', id}`.
    """

    _api_visible = True
    type: str = APIField(default="apu")

    @action.post(action_name="create")
    async def create(cls):
        request_info = get_current_request_info()
        owner = request_info.someone_typeid if request_info else None

        processor = AgenticProcessor()
        await processor.save(owner)
        return ApiSuccessResponse(data={"type": "apu", "id": processor.id})


__all__ = [
    "ProcessorStatus",
    "StackFrame",
    "DebugState",
    "ProcessorState",
    "AgenticContext",
    "AgenticProcess",
    "AgenticProcessor",
    "APU",
    "ContextData",
    "ControlStartRequest",
    "ControlInputRequest",
    "ControlStepRequest",
    "ControlAppendRequest",
    "ControlContinueRequest",
    "RunFileRequest",
    "RunRequest",
    "ExecuteRequest",
    "CreateProcessRequest",
    "ProcessResultRequest",
]
