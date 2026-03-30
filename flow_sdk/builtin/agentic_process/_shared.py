"""Shared models, request types, and helper functions for agentic process/processor."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from pydantic import BaseModel

from flow_sdk.fs_records.agentic_process_record import AgenticProcessStatus

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
    status: str = AgenticProcessStatus.IDLE.value
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
