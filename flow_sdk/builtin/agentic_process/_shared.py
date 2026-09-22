"""Shared models and request types for agentic process/processor."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel



def _now_iso(timespec: str = "auto") -> str:
    return datetime.now(timezone.utc).isoformat(timespec=timespec).replace("+00:00", "Z")


def _parse_iso_datetime(value: object) -> datetime | None:
    """Lenient ISO-8601 → timezone-aware datetime (naive values assumed UTC).

    Accepts an already-parsed ``datetime`` and ``Z``-suffixed strings; returns
    None for anything unparseable.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class AgenticContext(BaseModel):
    permission_mode: str | None = None
    workdir: str | None = None
    model: str | None = None
    max_thinking_tokens: int | None = None


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
class StreamEvent:
    """A single event yielded by AgenticProcess.stream()."""

    type: Literal["text", "tool_use", "tool_result", "error"]
    text: str | None = None
    tool: str | None = None
    input: dict | None = None
    result: str | None = None
    error: str | None = None

