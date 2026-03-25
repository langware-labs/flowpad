"""Type guard functions for HookEventData."""

from __future__ import annotations

from flow_sdk.claude_hook_events.hook_event_data import HookEventData


def is_tool_event(h: HookEventData) -> bool:
    """Check if event has a tool_name (tool event)."""
    return h.tool_name is not None


def is_pre_tool_use(h: HookEventData) -> bool:
    """Check if event is PreToolUse."""
    return h.hook_event_name == "PreToolUse"


def is_post_tool_use(h: HookEventData) -> bool:
    """Check if event is PostToolUse."""
    return h.hook_event_name == "PostToolUse"


def is_notification(h: HookEventData) -> bool:
    """Check if event is Notification."""
    return h.hook_event_name == "Notification"


def is_stop(h: HookEventData) -> bool:
    """Check if event is Stop."""
    return h.hook_event_name == "Stop"


def is_user_prompt_submit(h: HookEventData) -> bool:
    """Check if event is UserPromptSubmit."""
    return h.hook_event_name == "UserPromptSubmit"


def is_subagent_stop(h: HookEventData) -> bool:
    """Check if event is SubagentStop."""
    return h.hook_event_name == "SubagentStop"


def is_session_start(h: HookEventData) -> bool:
    """Check if event is SessionStart."""
    return h.hook_event_name == "SessionStart"


def is_session_end(h: HookEventData) -> bool:
    """Check if event is SessionEnd."""
    return h.hook_event_name == "SessionEnd"
