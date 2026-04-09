"""Shared models and request types for agentic process/processor."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel

if TYPE_CHECKING:
    from flow_sdk.fs_records.agent_status import AgenticProcessStatus


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class AgenticContext(BaseModel):
    permission_mode: str | None = None
    workdir: str | None = None
    model: str | None = None
    max_thinking_tokens: int | None = None
    compute_node_id: str | None = None


class ContextData(BaseModel):
    """Serialized context data from frontend."""

    instructions: str | None = None
    workdir: str | None = None
    env_vars: dict[str, str] = {}
    model: str | None = None
    max_thinking_tokens: int = 1024
    permission_mode: str = "bypassPermissions"
    project_id: str | None = None  # Project to associate the process with
    agents_json: dict[str, Any] | None = None  # Claude Code --agents spec


class RunFileRequest(BaseModel):
    """Request to run an instruction file from VFS path."""

    vfs_path: str


class RunRequest(BaseModel):
    """Request to run instruction content with context."""

    instruction_content: str
    context: ContextData | dict[str, Any] = {}


class ExecuteRequest(BaseModel):
    """Request to execute instruction content directly."""

    instruction_content: str
    context: ContextData | dict[str, Any] = {}


class ProcessResultRequest(BaseModel):
    """Optional result metadata to create a ProcessResult child for a process."""

    uname: str | None = None
    result_type: str | None = None
    source_session_id: str | None = None


class CreateProcessRequest(BaseModel):
    """Request to create a new idle process ready for start() / prompt() calls."""

    context: ContextData | dict[str, Any] = {}
    result: ProcessResultRequest | None = None


# ── Result types ──────────────────────────────────────────────────────────────

@dataclass
class RunResult:
    """Return value from AgenticProcess.run() / prompt()."""

    text: str
    session_id: str
    status: "AgenticProcessStatus"
    ok: bool                        # False when status is error or interrupted
    duration_ms: int | None = None
    models_used: list[str] = field(default_factory=list)
    token_usage: dict | None = None


@dataclass
class StreamEvent:
    """A single event yielded by AgenticProcess.stream()."""

    type: Literal["text", "tool_use", "tool_result", "error"]
    text: str | None = None
    tool: str | None = None
    input: dict | None = None
    result: str | None = None
    error: str | None = None


class ProcessError(Exception):
    """Raised by AgenticProcess.run() when status is error or interrupted."""

    def __init__(self, status: "AgenticProcessStatus", session_id: str):
        self.status = status
        self.session_id = session_id
        super().__init__(f"Process ended with status={status} session_id={session_id}")
