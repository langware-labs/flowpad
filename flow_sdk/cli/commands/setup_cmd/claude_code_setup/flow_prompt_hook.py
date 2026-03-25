#!/usr/bin/env python3
"""
Claude Code hook script for all events.
Receives hook data via stdin and forwards to 'flow hooks report' command.

Supports all Claude Code hook events:
- UserPromptSubmit: User sends a prompt
- PreToolUse: Before tool execution
- PostToolUse: After tool execution
- Notification: Claude sends a notification
- Stop: Session stops
- SubagentStop: Subagent stops
"""

import json
import sys
import subprocess
import os


def infer_hook_type(data: dict) -> str:
    """Infer the hook type from the input data fields."""
    # Claude Code provides hook_event_name directly
    if "hook_event_name" in data:
        return data["hook_event_name"]

    # Fallback: Check for tool-related fields (PreToolUse/PostToolUse)
    tool_name = data.get("tool_name") or data.get("toolName")
    if tool_name:
        if any(k in data for k in ["tool_response", "toolResponse", "tool_result", "toolResult", "output"]):
            return "PostToolUse"
        else:
            return "PreToolUse"

    # Check for prompt field (UserPromptSubmit)
    if "prompt" in data:
        return "UserPromptSubmit"

    # Check for notification
    if "message" in data:
        return "Notification"

    # Check for stop events
    if any(k in data for k in ["stop_reason", "stopReason", "reason"]):
        if "subagent" in str(data).lower():
            return "SubagentStop"
        return "Stop"

    # Include raw keys in Unknown for debugging
    return f"Unknown({','.join(data.keys())})"


def main():
    try:
        # Read the hook input from stdin
        input_data = json.load(sys.stdin)

        # Add hook_type if not present
        if "hook_type" not in input_data:
            input_data["hook_type"] = infer_hook_type(input_data)

        # Run the flow hooks report command (pass environment for LOCAL_SERVER_PORT etc.)
        proc = subprocess.Popen(
            ["flow", "hooks", "report"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=os.environ.copy()
        )
        stdout, stderr = proc.communicate(input=json.dumps(input_data))

        # Print any output from the flow command
        if stdout:
            print(stdout, end='')

        # Exit with 0 to allow the hook to proceed
        sys.exit(0)

    except Exception as e:
        # Log error but don't block
        print(f"Flow hook error: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
