"""Test trigger script for unit testing.

This trigger activates when 'test_keyword' is found in the input.
It demonstrates different action types based on hook event type.
"""

from flow_sdk.rules.trigger_executor import Action


def _get_text_to_check(hooks_data: dict) -> str:
    """Extract the relevant text to check based on hook event type."""
    hook_event = hooks_data.get("hookEvent", hooks_data.get("hook_event_name", ""))

    if hook_event == "UserPromptSubmit":
        return hooks_data.get("prompt", "")
    elif hook_event in ("PreToolUse", "PostToolUse"):
        tool_input = hooks_data.get("tool_input", {})
        # Check command for Bash, file_path for file operations
        return str(tool_input.get("command", "")) + str(tool_input.get("file_path", ""))
    elif hook_event == "SessionStart":
        return hooks_data.get("source", "")
    elif hook_event == "Notification":
        return hooks_data.get("message", "")
    elif hook_event == "SubagentStop":
        return hooks_data.get("agent_type", "")
    else:
        # For Stop, PreCompact, PermissionRequest - check raw data
        return str(hooks_data)


def evaluate(hooks_data: dict, transcript: list) -> Action | list[Action] | None:
    """Evaluate hook data and return Action(s) if triggered."""
    hook_event = hooks_data.get("hookEvent", hooks_data.get("hook_event_name", ""))
    text = _get_text_to_check(hooks_data)

    if "test_keyword" not in text.lower():
        return None  # No trigger

    # Check for dangerous command pattern (for block action testing)
    if hook_event == "PreToolUse" and "dangerous" in text.lower():
        return Action(
            type="block",
            params={"reason": "Blocked dangerous command containing test_keyword"},
        )

    # Default: add_context action
    return Action(
        type="add_context",
        params={"content": f"Test context triggered by {hook_event}: test_keyword found"},
    )
