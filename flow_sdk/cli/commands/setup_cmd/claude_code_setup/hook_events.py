"""
Pydantic models for Claude Code hook events.

Each model represents the structure of data passed to hooks for a specific event type.
Based on Claude Code hooks documentation: https://code.claude.com/docs/en/hooks
"""

from enum import Enum
from typing import Optional, Any, Dict, List, Literal, Union
from pydantic import BaseModel, Field


# =============================================================================
# Enums
# =============================================================================

class HookEventName(str, Enum):
    """All available Claude Code hook events."""
    SESSION_START = "SessionStart"
    SESSION_END = "SessionEnd"
    USER_PROMPT_SUBMIT = "UserPromptSubmit"
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    PERMISSION_REQUEST = "PermissionRequest"
    NOTIFICATION = "Notification"
    STOP = "Stop"
    SUBAGENT_STOP = "SubagentStop"
    STOP_FAILURE = "StopFailure"
    PRE_COMPACT = "PreCompact"
    POST_COMPACT = "PostCompact"
    INSTRUCTIONS_LOADED = "InstructionsLoaded"
    ELICITATION = "Elicitation"
    ELICITATION_RESULT = "ElicitationResult"
    CWD_CHANGED = "CwdChanged"
    FILE_CHANGED = "FileChanged"


class PermissionMode(str, Enum):
    """Permission modes for Claude Code."""
    DEFAULT = "default"
    PLAN = "plan"
    BYPASS_PERMISSIONS = "bypassPermissions"
    TRUSTED_REPO = "trustedRepo"


class NotificationType(str, Enum):
    """Types of notifications."""
    PERMISSION_PROMPT = "permission_prompt"
    IDLE_PROMPT = "idle_prompt"
    AUTH_SUCCESS = "auth_success"
    ELICITATION_DIALOG = "elicitation_dialog"


class SessionStartSource(str, Enum):
    """Source of session start."""
    STARTUP = "startup"
    RESUME = "resume"
    CLEAR = "clear"
    COMPACT = "compact"


class SessionEndReason(str, Enum):
    """Reason for session end."""
    CLEAR = "clear"
    LOGOUT = "logout"
    PROMPT_INPUT_EXIT = "prompt_input_exit"
    OTHER = "other"


class CompactTrigger(str, Enum):
    """Trigger for compact operation."""
    MANUAL = "manual"
    AUTO = "auto"


class PermissionDecision(str, Enum):
    """Permission decisions for hooks."""
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


class BlockDecision(str, Enum):
    """Block decision for hooks."""
    BLOCK = "block"


# =============================================================================
# Base Models
# =============================================================================

class BaseHookEvent(BaseModel):
    """Base model for all hook events with common fields."""
    session_id: str = Field(..., description="Unique session identifier")
    transcript_path: str = Field(..., description="Path to session transcript")
    permission_mode: PermissionMode = Field(..., description="Current permission mode")
    hook_event_name: HookEventName = Field(..., description="Name of the hook event")

    class Config:
        use_enum_values = True


class BaseHookEventWithCwd(BaseHookEvent):
    """Base model for hook events that include current working directory."""
    cwd: str = Field(..., description="Current working directory")


# =============================================================================
# Input Models (data passed TO hooks)
# =============================================================================

class SessionStartEvent(BaseHookEvent):
    """Input data for SessionStart hook."""
    hook_event_name: Literal["SessionStart"] = "SessionStart"
    source: SessionStartSource = Field(..., description="Source of session start")


class SessionEndEvent(BaseHookEventWithCwd):
    """Input data for SessionEnd hook."""
    hook_event_name: Literal["SessionEnd"] = "SessionEnd"
    reason: SessionEndReason = Field(..., description="Reason for session end")


class UserPromptSubmitEvent(BaseHookEventWithCwd):
    """Input data for UserPromptSubmit hook."""
    hook_event_name: Literal["UserPromptSubmit"] = "UserPromptSubmit"
    prompt: str = Field(..., description="The user's submitted prompt")


class PreToolUseEvent(BaseHookEventWithCwd):
    """Input data for PreToolUse hook."""
    hook_event_name: Literal["PreToolUse"] = "PreToolUse"
    tool_name: str = Field(..., description="Name of the tool being called")
    tool_input: Dict[str, Any] = Field(..., description="Input parameters for the tool")
    tool_use_id: str = Field(..., description="Unique identifier for this tool use")


class PostToolUseEvent(BaseHookEventWithCwd):
    """Input data for PostToolUse hook."""
    hook_event_name: Literal["PostToolUse"] = "PostToolUse"
    tool_name: str = Field(..., description="Name of the tool that was called")
    tool_input: Dict[str, Any] = Field(..., description="Input parameters that were used")
    tool_response: Any = Field(..., description="Response from the tool")
    tool_use_id: str = Field(..., description="Unique identifier for this tool use")


class PermissionRequestEvent(BaseHookEventWithCwd):
    """Input data for PermissionRequest hook."""
    hook_event_name: Literal["PermissionRequest"] = "PermissionRequest"
    tool_name: str = Field(..., description="Name of the tool requesting permission")
    tool_input: Dict[str, Any] = Field(..., description="Input parameters for the tool")


class NotificationEvent(BaseHookEventWithCwd):
    """Input data for Notification hook."""
    hook_event_name: Literal["Notification"] = "Notification"
    message: str = Field(..., description="Notification message content")
    notification_type: NotificationType = Field(..., description="Type of notification")


class StopEvent(BaseHookEvent):
    """Input data for Stop hook."""
    hook_event_name: Literal["Stop"] = "Stop"
    stop_hook_active: bool = Field(..., description="Whether stop hook is currently active")


class SubagentStopEvent(BaseHookEvent):
    """Input data for SubagentStop hook."""
    hook_event_name: Literal["SubagentStop"] = "SubagentStop"
    stop_hook_active: bool = Field(..., description="Whether stop hook is currently active")
    agent_id: Optional[str] = Field(None, description="ID of the subagent")
    agent_transcript_path: Optional[str] = Field(None, description="Path to subagent transcript")


class PreCompactEvent(BaseHookEvent):
    """Input data for PreCompact hook."""
    hook_event_name: Literal["PreCompact"] = "PreCompact"
    trigger: CompactTrigger = Field(..., description="What triggered the compact")
    custom_instructions: Optional[str] = Field(None, description="Custom compact instructions")


# Union type for any hook event input
HookEvent = Union[
    SessionStartEvent,
    SessionEndEvent,
    UserPromptSubmitEvent,
    PreToolUseEvent,
    PostToolUseEvent,
    PermissionRequestEvent,
    NotificationEvent,
    StopEvent,
    SubagentStopEvent,
    PreCompactEvent,
]


# =============================================================================
# Output Models (data returned FROM hooks)
# =============================================================================

class BaseHookOutput(BaseModel):
    """Base output model with common fields for all hooks."""
    continue_: bool = Field(default=True, alias="continue", description="Whether Claude should continue")
    stopReason: Optional[str] = Field(None, description="Message shown when continue is false")
    suppressOutput: bool = Field(default=False, description="Hide stdout from transcript")
    systemMessage: Optional[str] = Field(None, description="Warning message shown to user")

    class Config:
        populate_by_name = True


class PreToolUseHookOutput(BaseHookOutput):
    """Output from PreToolUse hooks."""
    hookSpecificOutput: Optional[Dict[str, Any]] = Field(
        None,
        description="Hook-specific output with permissionDecision, permissionDecisionReason, updatedInput"
    )


class PostToolUseHookOutput(BaseHookOutput):
    """Output from PostToolUse hooks."""
    decision: Optional[BlockDecision] = Field(None, description="Set to 'block' to block the tool result")
    reason: Optional[str] = Field(None, description="Reason for the decision")
    hookSpecificOutput: Optional[Dict[str, Any]] = Field(
        None,
        description="Hook-specific output with additionalContext"
    )


class UserPromptSubmitHookOutput(BaseHookOutput):
    """Output from UserPromptSubmit hooks."""
    decision: Optional[BlockDecision] = Field(None, description="Set to 'block' to block the prompt")
    reason: Optional[str] = Field(None, description="Reason shown to user when blocked")
    hookSpecificOutput: Optional[Dict[str, Any]] = Field(
        None,
        description="Hook-specific output with additionalContext"
    )


class StopHookOutput(BaseHookOutput):
    """Output from Stop hooks."""
    decision: Optional[BlockDecision] = Field(None, description="Set to 'block' to prevent stopping")
    reason: Optional[str] = Field(None, description="Required if decision is 'block'")


class SubagentStopHookOutput(BaseHookOutput):
    """Output from SubagentStop hooks."""
    decision: Optional[BlockDecision] = Field(None, description="Set to 'block' to prevent stopping")
    reason: Optional[str] = Field(None, description="Required if decision is 'block'")


class SessionStartHookOutput(BaseHookOutput):
    """Output from SessionStart hooks."""
    hookSpecificOutput: Optional[Dict[str, Any]] = Field(
        None,
        description="Hook-specific output with additionalContext"
    )


class PermissionRequestHookOutput(BaseHookOutput):
    """Output from PermissionRequest hooks."""
    hookSpecificOutput: Optional[Dict[str, Any]] = Field(
        None,
        description="Hook-specific output with decision (behavior, updatedInput, message, interrupt)"
    )


# =============================================================================
# Helper Functions
# =============================================================================

def parse_hook_event(data: Dict[str, Any]) -> HookEvent:
    """
    Parse a hook event dictionary into the appropriate Pydantic model.

    Args:
        data: Raw hook event data from Claude Code

    Returns:
        Appropriate HookEvent model instance

    Raises:
        ValueError: If hook_event_name is missing or unknown
    """
    event_name = data.get("hook_event_name")
    if not event_name:
        raise ValueError("Missing hook_event_name in event data")

    event_models = {
        "SessionStart": SessionStartEvent,
        "SessionEnd": SessionEndEvent,
        "UserPromptSubmit": UserPromptSubmitEvent,
        "PreToolUse": PreToolUseEvent,
        "PostToolUse": PostToolUseEvent,
        "PermissionRequest": PermissionRequestEvent,
        "Notification": NotificationEvent,
        "Stop": StopEvent,
        "SubagentStop": SubagentStopEvent,
        "PreCompact": PreCompactEvent,
    }

    model_class = event_models.get(event_name)
    if not model_class:
        raise ValueError(f"Unknown hook event: {event_name}")

    return model_class.model_validate(data)


# =============================================================================
# Event Configuration
# =============================================================================

# Events that don't use matchers
EVENTS_NO_MATCHER: List[str] = [
    "UserPromptSubmit",
    "Stop",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "WorktreeCreate",
    "WorktreeRemove",
    "CwdChanged",
    "FileChanged",
]

# Events that use matchers (tool patterns)
EVENTS_WITH_MATCHER: List[str] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "SessionStart",
    "SessionEnd",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "StopFailure",
    "PreCompact",
    "PostCompact",
    "ConfigChange",
    "InstructionsLoaded",
    "Elicitation",
    "ElicitationResult",
]

# All hook events
ALL_HOOK_EVENTS: List[str] = EVENTS_NO_MATCHER + EVENTS_WITH_MATCHER
