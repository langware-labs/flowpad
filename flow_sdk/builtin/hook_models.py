"""Shared models for hook and trigger functionality.

This module contains models used by both AgentHook and Trigger
to avoid circular imports.
"""

from abc import ABC, abstractmethod
from flow_sdk._compat import StrEnum
from typing import Any, Optional

from pydantic import BaseModel


class ActionType(StrEnum):
    """Types of actions that can be triggered."""

    NOP = "nop"
    NOTIFY_ENTITY = "notify_entity"


class RelationshipSubAction(StrEnum):
    """Sub-actions for relationship operations."""

    ADD = "add"
    REMOVE = "remove"


class ErrorMessage(StrEnum):
    """Common error messages for API responses."""

    REQUEST_INFO_NOT_AVAILABLE = "Request info not available"
    REQUEST_BODY_REQUIRED = "Request body is required"
    AGENT_HOOK_ID_REQUIRED = "agent_hook_id is required in request body"
    TRIGGER_ID_REQUIRED = "trigger_id is required in request body"
    INVALID_AGENT_HOOK_ID_FORMAT = "Invalid agent_hook_id format"
    INVALID_TRIGGER_ID_FORMAT = "Invalid trigger_id format"
    UNKNOWN_SUB_ACTION = "Unknown sub-action"
    METHOD_NOT_ALLOWED = "Method not allowed for action"


class SuccessMessage(StrEnum):
    """Common success messages for API responses."""

    AGENT_HOOK_CONNECTED = "Agent hook connected successfully"
    AGENT_HOOK_DISCONNECTED = "Agent hook disconnected successfully"
    TRIGGER_CONNECTED = "Trigger connected successfully"
    TRIGGER_DISCONNECTED = "Trigger disconnected successfully"


class TriggerAction(BaseModel):
    """Action to be executed when a trigger matches."""

    action_type: ActionType


class ExecutedAction(BaseModel):
    """Result of executing a trigger action."""

    trigger_id: str
    trigger_name: str
    action_type: ActionType
    counter: int


# Re-export canonical HookEventData from shared module
from flow_sdk.claude_hook_events.hook_event_data import HookEventData


class WebhookHandleResult(BaseModel):
    """Result of handling an agent hook webhook."""

    status: str
    matched_triggers: int
    executed_actions: list[Any]
    agentic_process_id: Optional[str] = None
    flow_id: Optional[str] = None
    session_id: Optional[str] = None


class TriggerActionHandler(ABC):
    """Base class for trigger action handlers."""

    @abstractmethod
    async def execute(self, trigger: Any) -> None:
        """Execute the action on the trigger."""
        pass


class NopActionHandler(TriggerActionHandler):
    """Handler for NOP action - does nothing."""

    async def execute(self, trigger: Any) -> None:
        """Execute NOP action - no operation."""
        pass


class NotifyEntityActionHandler(TriggerActionHandler):
    """Handler for NOTIFY_ENTITY action - increments counter."""

    async def execute(self, trigger: Any) -> None:
        """Execute NOTIFY_ENTITY action - increments counter."""
        trigger.counter += 1


_ACTION_HANDLERS: dict[ActionType, TriggerActionHandler] = {
    ActionType.NOP: NopActionHandler(),
    ActionType.NOTIFY_ENTITY: NotifyEntityActionHandler(),
}


def get_action_handler(action_type: ActionType) -> TriggerActionHandler | None:
    """Get the handler for an action type."""
    return _ACTION_HANDLERS.get(action_type)
