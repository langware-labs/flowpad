"""Hook event type enum for Claude Code hooks."""

from __future__ import annotations

from flow_sdk._compat import StrEnum


class HookEventType(StrEnum):
    """Available Claude Code hook event types."""

    # User interaction hooks
    USER_PROMPT_SUBMIT = "UserPromptSubmit"
    """Triggered when user submits a prompt."""

    # Tool lifecycle hooks
    PRE_TOOL_USE = "PreToolUse"
    """Triggered before a tool is executed. Can block or modify input."""

    POST_TOOL_USE = "PostToolUse"
    """Triggered after a tool completes. Can run cleanup/validation."""

    POST_TOOL_USE_FAILURE = "PostToolUseFailure"
    """Triggered after a tool fails."""

    # Session hooks
    STOP = "Stop"
    """Triggered when Claude finishes responding."""

    STOP_FAILURE = "StopFailure"
    """Triggered when a turn ends due to an API error."""

    NOTIFICATION = "Notification"
    """Triggered when Claude needs user input."""

    SESSION_START = "SessionStart"
    """Triggered when session starts or resumes."""

    SESSION_END = "SessionEnd"
    """Triggered when session ends."""

    INSTRUCTIONS_LOADED = "InstructionsLoaded"
    """Triggered when CLAUDE.md or .claude/rules/*.md files are loaded."""

    # Context hooks
    PRE_COMPACT = "PreCompact"
    """Triggered before context compaction."""

    POST_COMPACT = "PostCompact"
    """Triggered after context compaction completes."""

    # Subagent hooks
    SUBAGENT_START = "SubagentStart"
    """Triggered when a subagent starts."""

    SUBAGENT_STOP = "SubagentStop"
    """Triggered when a subagent completes its task."""

    # Permission hooks
    PERMISSION_REQUEST = "PermissionRequest"
    """Triggered when a tool requests permission."""

    # Agent teams events
    TEAMMATE_IDLE = "TeammateIdle"
    """Triggered when a teammate is idle."""

    TASK_COMPLETED = "TaskCompleted"
    """Triggered when a task is completed."""

    # Configuration events
    CONFIG_CHANGE = "ConfigChange"
    """Triggered when configuration changes."""

    # Worktree events
    WORKTREE_CREATE = "WorktreeCreate"
    """Triggered when a worktree is created."""

    WORKTREE_REMOVE = "WorktreeRemove"
    """Triggered when a worktree is removed."""

    # MCP elicitation events
    ELICITATION = "Elicitation"
    """Triggered when an MCP server requests user input during a tool call."""

    ELICITATION_RESULT = "ElicitationResult"
    """Triggered after a user responds to an MCP elicitation."""

    # File system events
    CWD_CHANGED = "CwdChanged"
    """Triggered when the current working directory changes."""

    FILE_CHANGED = "FileChanged"
    """Triggered when a file is created, modified, or deleted."""
