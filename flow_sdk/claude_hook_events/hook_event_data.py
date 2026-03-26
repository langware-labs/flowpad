"""Unified Pydantic model for hook event data."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class HookEventData(BaseModel):
    """Provider-agnostic model for hook event data.

    Covers all Claude Code hook event types. This is the canonical
    Pydantic model for hook event payloads.
    """

    hook_event_name: str
    session_id: Optional[str] = None
    transcript_path: Optional[str] = None
    cwd: Optional[str] = None
    permission_mode: Optional[str] = None

    # Tool events (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest)
    tool_name: Optional[str] = None
    tool_input: Optional[dict[str, Any]] = None
    tool_response: Optional[Any] = None
    tool_use_id: Optional[str] = None
    error: Optional[str] = None
    is_interrupt: Optional[bool] = None
    permission_suggestions: Optional[list[dict[str, Any]]] = None

    # UserPromptSubmit
    prompt: Optional[str] = None

    # Notification
    message: Optional[str] = None
    title: Optional[str] = None
    notification_type: Optional[str] = None

    # SessionStart
    source: Optional[str] = None
    model: Optional[str] = None
    agent_type: Optional[str] = None

    # SessionEnd
    reason: Optional[str] = None

    # SubagentStart / SubagentStop
    agent_id: Optional[str] = None
    agent_transcript_path: Optional[str] = None
    last_assistant_message: Optional[str] = None
    stop_hook_active: Optional[bool] = None

    # TeammateIdle / TaskCreated / TaskCompleted
    teammate_name: Optional[str] = None
    team_name: Optional[str] = None
    task_id: Optional[str] = None
    task_subject: Optional[str] = None
    task_description: Optional[str] = None

    # ConfigChange / WorktreeCreate
    file_path: Optional[str] = None
    name: Optional[str] = None

    # WorktreeRemove
    worktree_path: Optional[str] = None

    # PreCompact
    trigger: Optional[str] = None
    custom_instructions: Optional[str] = None

    # Legacy
    output: Optional[str] = None
    usage: Optional[dict[str, int]] = None
