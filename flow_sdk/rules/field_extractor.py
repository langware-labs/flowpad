"""Extract fields from hook input data for trigger.py scripts."""

from __future__ import annotations

from typing import Any


def extract_field(
    field: str,
    tool_name: str | None,
    tool_input: dict[str, Any] | None,
    input_data: dict[str, Any],
) -> str | None:
    """Extract a specific field from hook input data.

    Args:
        field: The field to extract ('command', 'content', 'file_path', 'user_prompt', etc.).
        tool_name: The name of the tool (e.g., 'Bash', 'Write', 'Edit').
        tool_input: The tool's input parameters.
        input_data: The full hook input data.

    Returns:
        The extracted field value as a string, or None if not found.
    """
    tool_input = tool_input or {}
    hooks_data = input_data.get("hooks_data", {})

    if field == "command":
        # Bash command
        if tool_name == "Bash":
            return tool_input.get("command")
        # Also check hooks_data for Bash commands
        if hooks_data.get("tool_name") == "Bash":
            return hooks_data.get("tool_input", {}).get("command")
        return None

    elif field == "content":
        # File content being written (Write tool)
        if tool_name == "Write":
            return tool_input.get("content")
        if hooks_data.get("tool_name") == "Write":
            return hooks_data.get("tool_input", {}).get("content")
        return None

    elif field == "new_string":
        # Replacement text (Edit tool)
        if tool_name == "Edit":
            return tool_input.get("new_string")
        if hooks_data.get("tool_name") == "Edit":
            return hooks_data.get("tool_input", {}).get("new_string")
        return None

    elif field == "old_string":
        # Text being replaced (Edit tool)
        if tool_name == "Edit":
            return tool_input.get("old_string")
        if hooks_data.get("tool_name") == "Edit":
            return hooks_data.get("tool_input", {}).get("old_string")
        return None

    elif field == "file_path":
        # Target file path (Write, Edit, Read)
        if tool_name in ("Write", "Edit", "Read"):
            return tool_input.get("file_path")
        tool_in_hooks = hooks_data.get("tool_name")
        if tool_in_hooks in ("Write", "Edit", "Read"):
            return hooks_data.get("tool_input", {}).get("file_path")
        return None

    elif field == "user_prompt":
        # User's input (UserPromptSubmit)
        return (
            hooks_data.get("prompt")
            or hooks_data.get("command")
            or input_data.get("prompt")
            or input_data.get("command")
        )

    elif field == "tool_name":
        # The tool being used
        return tool_name or hooks_data.get("tool_name")

    elif field == "hook_event":
        # The hook event type
        return hooks_data.get("hookEvent") or hooks_data.get("hook_event")

    elif field == "transcript":
        # Full transcript content
        transcript = input_data.get("transcript", [])
        if transcript:
            return "\n".join(str(entry) for entry in transcript)
        return None

    # Generic field extraction from tool_input
    if tool_input and field in tool_input:
        return str(tool_input[field])

    # Try hooks_data.tool_input
    if hooks_data.get("tool_input") and field in hooks_data["tool_input"]:
        return str(hooks_data["tool_input"][field])

    return None


def get_tool_info(input_data: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    """Extract tool name and tool input from hook data.

    Args:
        input_data: The hook input data.

    Returns:
        Tuple of (tool_name, tool_input).
    """
    hooks_data = input_data.get("hooks_data", {})

    tool_name = hooks_data.get("tool_name") or hooks_data.get("toolName")
    tool_input = hooks_data.get("tool_input") or hooks_data.get("toolInput") or {}

    return tool_name, tool_input


def get_hook_event(input_data: dict[str, Any]) -> str:
    """Get the hook event type from input data.

    Args:
        input_data: The hook input data.

    Returns:
        The hook event type as a string.
    """
    hooks_data = input_data.get("hooks_data", {})
    return str(
        hooks_data.get("hookEvent")
        or hooks_data.get("hook_event")
        or hooks_data.get("event")
        or ""
    )


def get_user_prompt(input_data: dict[str, Any]) -> str:
    """Get the user's prompt from input data.

    Args:
        input_data: The hook input data.

    Returns:
        The user's prompt as a string.
    """
    hooks_data = input_data.get("hooks_data", {})
    return str(
        hooks_data.get("prompt")
        or hooks_data.get("command")
        or input_data.get("prompt")
        or input_data.get("command")
        or ""
    )


def is_tool_match(input_data: dict[str, Any], tool_pattern: str) -> bool:
    """Check if the current tool matches a pattern.

    Args:
        input_data: The hook input data.
        tool_pattern: A regex pattern or exact tool name to match.

    Returns:
        True if the tool matches.
    """
    import re

    tool_name, _ = get_tool_info(input_data)
    if not tool_name:
        return False

    # Try exact match first
    if tool_name == tool_pattern:
        return True

    # Try regex match
    try:
        return bool(re.match(tool_pattern, tool_name))
    except re.error:
        return False


def get_bash_command(input_data: dict[str, Any]) -> str | None:
    """Convenience function to get Bash command from input data.

    Args:
        input_data: The hook input data.

    Returns:
        The Bash command string, or None if not a Bash tool use.
    """
    tool_name, tool_input = get_tool_info(input_data)
    if tool_name == "Bash":
        return tool_input.get("command")
    return None


def get_file_operation(input_data: dict[str, Any]) -> dict[str, Any] | None:
    """Get file operation details from Write or Edit tool use.

    Args:
        input_data: The hook input data.

    Returns:
        Dict with 'tool', 'file_path', 'content' (for Write) or 'old_string'/'new_string' (for Edit).
    """
    tool_name, tool_input = get_tool_info(input_data)

    if tool_name == "Write":
        return {
            "tool": "Write",
            "file_path": tool_input.get("file_path"),
            "content": tool_input.get("content"),
        }
    elif tool_name == "Edit":
        return {
            "tool": "Edit",
            "file_path": tool_input.get("file_path"),
            "old_string": tool_input.get("old_string"),
            "new_string": tool_input.get("new_string"),
        }
    elif tool_name == "Read":
        return {
            "tool": "Read",
            "file_path": tool_input.get("file_path"),
        }

    return None
