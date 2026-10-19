"""Shared hook event SDK — single source of truth for hook event types and models."""

from flow_sdk.claude_hook_events.event_types import HookEventType
from flow_sdk.claude_hook_events.field_extractors import (
    extract_cwd,
    extract_session_id,
    get_event_summary_line,
    get_tool_name,
)
from flow_sdk.claude_hook_events.hook_event_data import HookEventData
from flow_sdk.claude_hook_events.type_guards import (
    is_notification,
    is_post_tool_use,
    is_pre_tool_use,
    is_session_end,
    is_session_start,
    is_stop,
    is_subagent_stop,
    is_tool_event,
    is_user_prompt_submit,
)

__all__ = [
    # Enum
    "HookEventType",
    # Data model
    "HookEventData",
    # Field extractors
    "extract_cwd",
    "extract_session_id",
    "get_event_summary_line",
    "get_tool_name",
    # Type guards
    "is_tool_event",
    "is_pre_tool_use",
    "is_post_tool_use",
    "is_notification",
    "is_stop",
    "is_user_prompt_submit",
    "is_subagent_stop",
    "is_session_start",
    "is_session_end",
]
