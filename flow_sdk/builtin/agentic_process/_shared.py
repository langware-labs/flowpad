"""Shared models and request types for agentic process/processor."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
    """Request to create a new idle process ready for open() / prompt() calls."""

    context: ContextData | dict[str, Any] = {}
    result: ProcessResultRequest | None = None
