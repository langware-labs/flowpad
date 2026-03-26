"""Webhook flow data models for typed webhook handling.

Consolidated to 2 webhook types:
- agent_hook: Claude Code hook events
- hook_op: everything else (entity CRUD, events, logs, invocations)
"""

from flow_sdk._compat import StrEnum
from typing import Literal, Optional

from pydantic import BaseModel


class WebhookType(StrEnum):
    """Supported webhook types."""

    AGENT_HOOK = "agent_hook"
    HOOK_OP = "hook_op"


class AgentHookData(BaseModel):
    """Data model for agent_hook webhook."""

    webhook_type: Literal["agent_hook"] = "agent_hook"
    agent_hook_id: Optional[str] = None
    hook_data: dict
    hook_entry_id: Optional[str] = None
    hook_metadata: Optional[dict] = None
    hook_file_path: Optional[str] = None


class SkillNotification(BaseModel):
    """Skill notification details for skill activation tracking."""

    skill_name: str
    matched_keyword: Optional[str] = None
    prompt: Optional[str] = None
    handler_name: Optional[str] = None
    folder_path: Optional[str] = None


class WebhookPayload(BaseModel):
    """Incoming webhook request: type + payload."""

    webhook_type: WebhookType
    webhook_payload: dict
