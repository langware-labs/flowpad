"""Hook event types for Claude Code hooks."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Re-export canonical HookEventType from shared module
from flow_sdk.claude_hook_events.event_types import HookEventType

__all__ = ["HookEventType", "HookEvent"]


@dataclass
class HookEvent:
    hook_event: str
    hook_name: str
    command: str | None = None
    tool_use_id: str | None = None
    parent_tool_use_id: str | None = None
    timestamp: str | None = None
    entry_index: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)
