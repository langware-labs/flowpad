"""Typed schemas for Claude Code hook events and tool payloads.

This module provides comprehensive type definitions for all Claude Code hook
data schemas, enabling type-safe processing of hook events.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union



# =============================================================================
# Base Types
# =============================================================================


@dataclass
class RawHookDataBase:
    """Base fields present in all raw hook data payloads."""

    session_id: str
    transcript_path: str
    cwd: str
    hook_event_name: str
    permission_mode: str | None = None


# =============================================================================
# Tool Input Types
# =============================================================================


@dataclass
class BashToolInput:
    """Input parameters for the Bash tool."""

    command: str
    description: str | None = None
    timeout: int | None = None
    run_in_background: bool | None = None


@dataclass
class GlobToolInput:
    """Input parameters for the Glob tool."""

    pattern: str
    path: str | None = None


@dataclass
class GrepToolInput:
    """Input parameters for the Grep tool."""

    pattern: str
    path: str | None = None
    glob: str | None = None
    type: str | None = None
    output_mode: str | None = None  # "content", "files_with_matches", "count"
    context: int | None = None
    head_limit: int | None = None
    multiline: bool | None = None


@dataclass
class ReadToolInput:
    """Input parameters for the Read tool."""

    file_path: str
    offset: int | None = None
    limit: int | None = None


@dataclass
class WriteToolInput:
    """Input parameters for the Write tool."""

    file_path: str
    content: str


@dataclass
class EditToolInput:
    """Input parameters for the Edit tool."""

    file_path: str
    old_string: str
    new_string: str
    replace_all: bool = False


@dataclass
class TaskToolInput:
    """Input parameters for the Task tool (subagent spawning)."""

    prompt: str
    description: str
    subagent_type: str
    model: str | None = None
    run_in_background: bool | None = None
    resume: str | None = None
    max_turns: int | None = None


@dataclass
class WebFetchToolInput:
    """Input parameters for the WebFetch tool."""

    url: str
    prompt: str


@dataclass
class WebSearchToolInput:
    """Input parameters for the WebSearch tool."""

    query: str
    allowed_domains: list[str] | None = None
    blocked_domains: list[str] | None = None


@dataclass
class LSPToolInput:
    """Input parameters for the LSP tool."""

    operation: str
    filePath: str
    line: int
    character: int


@dataclass
class AskUserQuestionToolInput:
    """Input parameters for the AskUserQuestion tool."""

    questions: list[dict[str, Any]]


# Union of all tool input types
ToolInput = Union[
    BashToolInput,
    GlobToolInput,
    GrepToolInput,
    ReadToolInput,
    WriteToolInput,
    EditToolInput,
    TaskToolInput,
    WebFetchToolInput,
    WebSearchToolInput,
    LSPToolInput,
    AskUserQuestionToolInput,
    dict[str, Any],  # Fallback for unknown tools
]


# =============================================================================
# Tool Response Types
# =============================================================================


@dataclass
class BashToolResponse:
    """Response from the Bash tool."""

    stdout: str = ""
    stderr: str = ""
    interrupted: bool = False
    isImage: bool = False


@dataclass
class GlobToolResponse:
    """Response from the Glob tool."""

    filenames: list[str] = field(default_factory=list)
    durationMs: int = 0
    numFiles: int = 0
    truncated: bool = False


@dataclass
class GrepToolResponse:
    """Response from the Grep tool."""

    content: str = ""
    filenames: list[str] = field(default_factory=list)
    numFiles: int = 0
    durationMs: int = 0


@dataclass
class ReadFileContent:
    """Content of a file read by the Read tool."""

    filePath: str
    content: str
    numLines: int = 0
    startLine: int = 1
    totalLines: int = 0


@dataclass
class ReadToolResponse:
    """Response from the Read tool."""

    type: str = "file"  # "file", "image", "pdf", "notebook"
    file: ReadFileContent | None = None


@dataclass
class StructuredPatch:
    """A structured patch representing file changes."""

    oldStart: int
    oldLines: int
    newStart: int
    newLines: int
    lines: list[str] = field(default_factory=list)


@dataclass
class WriteToolResponse:
    """Response from the Write tool."""

    type: str = "write"
    filePath: str = ""
    content: str = ""
    structuredPatch: StructuredPatch | None = None
    originalFile: str | None = None


@dataclass
class EditToolResponse:
    """Response from the Edit tool (similar to Write)."""

    type: str = "edit"
    filePath: str = ""
    content: str = ""
    structuredPatch: StructuredPatch | None = None
    originalFile: str | None = None


@dataclass
class TaskToolResponse:
    """Response from the Task tool (subagent)."""

    result: str = ""
    agent_id: str | None = None
    output_file: str | None = None


@dataclass
class WebFetchToolResponse:
    """Response from the WebFetch tool."""

    content: str = ""
    url: str = ""
    redirect_url: str | None = None


@dataclass
class WebSearchToolResponse:
    """Response from the WebSearch tool."""

    results: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class LSPToolResponse:
    """Response from the LSP tool."""

    results: list[dict[str, Any]] = field(default_factory=list)


# Union of all tool response types
ToolResponse = Union[
    BashToolResponse,
    GlobToolResponse,
    GrepToolResponse,
    ReadToolResponse,
    WriteToolResponse,
    EditToolResponse,
    TaskToolResponse,
    WebFetchToolResponse,
    WebSearchToolResponse,
    LSPToolResponse,
    dict[str, Any],  # Fallback for unknown tools
    str,  # Some tools return simple strings
]


# =============================================================================
# Event-Specific Raw Hook Data
# =============================================================================


@dataclass
class NotificationRawHookData(RawHookDataBase):
    """Raw hook data for Notification events."""

    message: str = ""
    notification_type: str = ""  # e.g., "idle", "waiting_for_input"


@dataclass
class UserPromptSubmitRawHookData(RawHookDataBase):
    """Raw hook data for UserPromptSubmit events."""

    prompt: str = ""


@dataclass
class PreToolUseRawHookData(RawHookDataBase):
    """Raw hook data for PreToolUse events."""

    tool_name: str = ""
    tool_input: dict[str, Any] = field(default_factory=dict)
    tool_use_id: str = ""


@dataclass
class PostToolUseRawHookData(RawHookDataBase):
    """Raw hook data for PostToolUse events."""

    tool_name: str = ""
    tool_input: dict[str, Any] = field(default_factory=dict)
    tool_response: Any = None
    tool_use_id: str = ""


@dataclass
class SessionStartRawHookData(RawHookDataBase):
    """Raw hook data for SessionStart events."""

    source: str = ""  # e.g., "cli", "ide"


@dataclass
class SessionEndRawHookData(RawHookDataBase):
    """Raw hook data for SessionEnd events."""

    reason: str = ""  # e.g., "user_exit", "error", "timeout"


@dataclass
class StopRawHookData(RawHookDataBase):
    """Raw hook data for Stop events."""

    stop_hook_active: bool = False


@dataclass
class SubagentStopRawHookData(RawHookDataBase):
    """Raw hook data for SubagentStop events."""

    stop_hook_active: bool = False
    agent_id: str = ""
    agent_transcript_path: str = ""
    agent_type: str = ""  # e.g., "Explore", "Plan", "Bash"


# Union of all event-specific raw hook data types
RawHookData = Union[
    NotificationRawHookData,
    UserPromptSubmitRawHookData,
    PreToolUseRawHookData,
    PostToolUseRawHookData,
    SessionStartRawHookData,
    SessionEndRawHookData,
    StopRawHookData,
    SubagentStopRawHookData,
    RawHookDataBase,
]


# =============================================================================
# Main Wrapper Types
# =============================================================================


@dataclass
class UsageInfo:
    """Token usage information."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0


@dataclass
class HookData:
    """Main hook data payload from Claude Code.

    This represents the parsed hook data that is passed to hook handlers.
    """

    hook_event_name: str
    session_id: str
    tool_name: str | None = None
    tool_input: dict[str, Any] | None = None
    tool_response: Any = None
    tool_use_id: str | None = None
    prompt: str | None = None
    message: str | None = None
    notification_type: str | None = None
    usage: UsageInfo | None = None
    raw_hook_data: dict[str, Any] = field(default_factory=dict)

    # Session info
    transcript_path: str | None = None
    cwd: str | None = None
    permission_mode: str | None = None

    # Stop/subagent specific
    stop_hook_active: bool | None = None
    agent_id: str | None = None
    agent_transcript_path: str | None = None
    agent_type: str | None = None
    source: str | None = None
    reason: str | None = None


@dataclass
class HookMetadata:
    """Metadata about the hook invocation."""

    hook_file_path: str = ""
    hook_name: str = ""
    hook_command: str = ""


@dataclass
class AgentHookPayload:
    """Complete webhook payload sent to hook handlers.

    This is the top-level structure received by webhook endpoints.
    """

    webhook_type: str
    agent_hook_id: str
    hook_data: HookData
    hook_entry_id: str = ""
    hook_metadata: HookMetadata | None = None
    hook_file_path: str = ""


# =============================================================================
# Parsing Utilities
# =============================================================================


def parse_tool_input(tool_name: str, input_dict: dict[str, Any]) -> ToolInput:
    """Parse a tool input dictionary into a typed dataclass.

    Args:
        tool_name: The name of the tool.
        input_dict: The raw input dictionary.

    Returns:
        A typed tool input dataclass, or the original dict if unknown.
    """
    parsers: dict[str, type] = {
        "Bash": BashToolInput,
        "Glob": GlobToolInput,
        "Grep": GrepToolInput,
        "Read": ReadToolInput,
        "Write": WriteToolInput,
        "Edit": EditToolInput,
        "Task": TaskToolInput,
        "WebFetch": WebFetchToolInput,
        "WebSearch": WebSearchToolInput,
        "LSP": LSPToolInput,
        "AskUserQuestion": AskUserQuestionToolInput,
    }

    parser = parsers.get(tool_name)
    if parser is None:
        return input_dict

    # Filter to only include fields the dataclass accepts
    valid_fields = {f.name for f in parser.__dataclass_fields__.values()}  # type: ignore
    filtered = {k: v for k, v in input_dict.items() if k in valid_fields}

    try:
        return parser(**filtered)
    except (TypeError, ValueError):
        return input_dict


def parse_tool_response(tool_name: str, response: Any) -> ToolResponse:
    """Parse a tool response into a typed dataclass.

    Args:
        tool_name: The name of the tool.
        response: The raw response (dict, string, or other).

    Returns:
        A typed tool response dataclass, or the original response if unknown.
    """
    if not isinstance(response, dict):
        return response

    parsers: dict[str, type] = {
        "Bash": BashToolResponse,
        "Glob": GlobToolResponse,
        "Grep": GrepToolResponse,
        "Read": ReadToolResponse,
        "Write": WriteToolResponse,
        "Edit": EditToolResponse,
        "Task": TaskToolResponse,
        "WebFetch": WebFetchToolResponse,
        "WebSearch": WebSearchToolResponse,
        "LSP": LSPToolResponse,
    }

    parser = parsers.get(tool_name)
    if parser is None:
        return response

    # Special handling for Read tool with nested file content
    if tool_name == "Read" and "file" in response and isinstance(response["file"], dict):
        file_dict = response["file"]
        file_content = ReadFileContent(
            filePath=file_dict.get("filePath", ""),
            content=file_dict.get("content", ""),
            numLines=file_dict.get("numLines", 0),
            startLine=file_dict.get("startLine", 1),
            totalLines=file_dict.get("totalLines", 0),
        )
        return ReadToolResponse(
            type=response.get("type", "file"),
            file=file_content,
        )

    # Filter to only include fields the dataclass accepts
    valid_fields = {f.name for f in parser.__dataclass_fields__.values()}  # type: ignore
    filtered = {k: v for k, v in response.items() if k in valid_fields}

    try:
        return parser(**filtered)
    except (TypeError, ValueError):
        return response


def parse_raw_hook_data(data: dict[str, Any]) -> RawHookData:
    """Parse raw hook data into a typed dataclass.

    Args:
        data: The raw hook data dictionary.

    Returns:
        A typed raw hook data dataclass.
    """
    event_name = data.get("hook_event_name", "")

    parsers: dict[str, type] = {
        "Notification": NotificationRawHookData,
        "UserPromptSubmit": UserPromptSubmitRawHookData,
        "PreToolUse": PreToolUseRawHookData,
        "PostToolUse": PostToolUseRawHookData,
        "SessionStart": SessionStartRawHookData,
        "SessionEnd": SessionEndRawHookData,
        "Stop": StopRawHookData,
        "SubagentStop": SubagentStopRawHookData,
    }

    parser = parsers.get(event_name, RawHookDataBase)

    # Filter to only include fields the dataclass accepts
    valid_fields = {f.name for f in parser.__dataclass_fields__.values()}  # type: ignore
    filtered = {k: v for k, v in data.items() if k in valid_fields}

    try:
        return parser(**filtered)
    except (TypeError, ValueError):
        # Fallback to base class
        base_fields = {f.name for f in RawHookDataBase.__dataclass_fields__.values()}
        base_filtered = {k: v for k, v in data.items() if k in base_fields}
        return RawHookDataBase(**base_filtered)


def parse_usage(usage_dict: dict[str, Any] | None) -> UsageInfo | None:
    """Parse usage information into a typed dataclass.

    Args:
        usage_dict: The raw usage dictionary.

    Returns:
        A UsageInfo dataclass or None.
    """
    if not usage_dict:
        return None

    return UsageInfo(
        input_tokens=usage_dict.get("input_tokens", 0),
        output_tokens=usage_dict.get("output_tokens", 0),
        cache_creation_input_tokens=usage_dict.get("cache_creation_input_tokens", 0),
        cache_read_input_tokens=usage_dict.get("cache_read_input_tokens", 0),
    )


def parse_hook_data(data: dict[str, Any]) -> HookData:
    """Parse hook data dictionary into a typed HookData dataclass.

    Args:
        data: The raw hook data dictionary.

    Returns:
        A HookData dataclass.
    """
    return HookData(
        hook_event_name=data.get("hook_event_name", ""),
        session_id=data.get("session_id", ""),
        tool_name=data.get("tool_name"),
        tool_input=data.get("tool_input"),
        tool_response=data.get("tool_response"),
        tool_use_id=data.get("tool_use_id"),
        prompt=data.get("prompt"),
        message=data.get("message"),
        notification_type=data.get("notification_type"),
        usage=parse_usage(data.get("usage")),
        raw_hook_data=data,
        transcript_path=data.get("transcript_path"),
        cwd=data.get("cwd"),
        permission_mode=data.get("permission_mode"),
        stop_hook_active=data.get("stop_hook_active"),
        agent_id=data.get("agent_id"),
        agent_transcript_path=data.get("agent_transcript_path"),
        agent_type=data.get("agent_type"),
        source=data.get("source"),
        reason=data.get("reason"),
    )


def parse_hook_payload(payload: dict[str, Any]) -> AgentHookPayload:
    """Parse a complete webhook payload into a typed dataclass.

    Args:
        payload: The raw webhook payload dictionary.
            New format: {"webhook_type": ..., "webhook_payload": {...}}

    Returns:
        An AgentHookPayload dataclass.
    """
    webhook_payload = payload.get("webhook_payload", {})

    hook_data_dict = webhook_payload.get("hook_data", {})
    hook_metadata_dict = webhook_payload.get("hook_metadata")

    hook_metadata = None
    if hook_metadata_dict:
        hook_metadata = HookMetadata(
            hook_file_path=hook_metadata_dict.get("hook_file_path", ""),
            hook_name=hook_metadata_dict.get("hook_name", ""),
            hook_command=hook_metadata_dict.get("hook_command", ""),
        )

    return AgentHookPayload(
        webhook_type=payload.get("webhook_type", "agent_hook"),
        agent_hook_id=webhook_payload.get("agent_hook_id", ""),
        hook_data=parse_hook_data(hook_data_dict),
        hook_entry_id=webhook_payload.get("hook_entry_id", ""),
        hook_metadata=hook_metadata,
        hook_file_path=webhook_payload.get("hook_file_path", ""),
    )


# =============================================================================
# Type Guards
# =============================================================================


def is_bash_input(tool_input: ToolInput) -> bool:
    """Check if tool input is BashToolInput."""
    return isinstance(tool_input, BashToolInput)


def is_glob_input(tool_input: ToolInput) -> bool:
    """Check if tool input is GlobToolInput."""
    return isinstance(tool_input, GlobToolInput)


def is_read_input(tool_input: ToolInput) -> bool:
    """Check if tool input is ReadToolInput."""
    return isinstance(tool_input, ReadToolInput)


def is_write_input(tool_input: ToolInput) -> bool:
    """Check if tool input is WriteToolInput."""
    return isinstance(tool_input, WriteToolInput)


def is_edit_input(tool_input: ToolInput) -> bool:
    """Check if tool input is EditToolInput."""
    return isinstance(tool_input, EditToolInput)


def is_task_input(tool_input: ToolInput) -> bool:
    """Check if tool input is TaskToolInput."""
    return isinstance(tool_input, TaskToolInput)


def is_pre_tool_use(event: HookData) -> bool:
    """Check if event is PreToolUse."""
    return event.hook_event_name == "PreToolUse"


def is_post_tool_use(event: HookData) -> bool:
    """Check if event is PostToolUse."""
    return event.hook_event_name == "PostToolUse"


def is_user_prompt_submit(event: HookData) -> bool:
    """Check if event is UserPromptSubmit."""
    return event.hook_event_name == "UserPromptSubmit"


def is_notification(event: HookData) -> bool:
    """Check if event is Notification."""
    return event.hook_event_name == "Notification"


def is_session_start(event: HookData) -> bool:
    """Check if event is SessionStart."""
    return event.hook_event_name == "SessionStart"


def is_session_end(event: HookData) -> bool:
    """Check if event is SessionEnd."""
    return event.hook_event_name == "SessionEnd"


def is_stop(event: HookData) -> bool:
    """Check if event is Stop."""
    return event.hook_event_name == "Stop"


def is_subagent_stop(event: HookData) -> bool:
    """Check if event is SubagentStop."""
    return event.hook_event_name == "SubagentStop"
