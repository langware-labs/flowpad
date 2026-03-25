"""
Print reporter - formats and prints hook events to console.
"""

import json
from datetime import datetime
from typing import Dict, Any
from .base import BaseReporter

# ANSI color codes
COLORS = {
    'SessionStart': '\033[97m',        # White (bright)
    'SessionEnd': '\033[90m',          # Gray
    'UserPromptSubmit': '\033[95m',    # Magenta
    'PreToolUse': '\033[93m',          # Yellow
    'PostToolUse': '\033[92m',         # Green
    'PermissionRequest': '\033[33m',   # Orange/Brown
    'Notification': '\033[96m',        # Cyan
    'Stop': '\033[91m',                # Red
    'SubagentStop': '\033[94m',        # Blue
    'PreCompact': '\033[35m',          # Purple
}
RESET = '\033[0m'
BOLD = '\033[1m'
DIM = '\033[2m'

# Event icons
ICONS = {
    'SessionStart': '🚀',
    'SessionEnd': '🏁',
    'UserPromptSubmit': '💬',
    'PreToolUse': '🔧',
    'PostToolUse': '✅',
    'PermissionRequest': '🔐',
    'Notification': '📢',
    'Stop': '⏹️',
    'SubagentStop': '🤖',
    'PreCompact': '📦',
}


class PrintReporter(BaseReporter):
    """
    Reporter that formats and prints hook events to console.

    Features:
    - Colored output based on event type
    - Icons for visual identification
    - Formatted timestamps
    - Truncated long content
    """

    def __init__(self):
        """Initialize the print reporter."""
        pass

    def _format_event(self, event: Dict[str, Any]) -> str:
        """Format a hook event for console display."""
        hook_type = event.get('hook_type', event.get('type', 'Unknown'))
        timestamp = datetime.now().strftime('%H:%M:%S')

        color = COLORS.get(hook_type, '\033[0m')
        icon = ICONS.get(hook_type, '📌')

        lines = []
        lines.append(f"\n{color}{BOLD}{icon} [{timestamp}] ═══ {hook_type} ═══{RESET}")

        # Event-specific formatting
        if hook_type == 'SessionStart':
            session_id = event.get('session_id', '')[:16]
            source = event.get('source', 'unknown')
            if session_id:
                lines.append(f"{color}  Session: {session_id}...{RESET}")
            lines.append(f"{color}  Source: {source}{RESET}")

        elif hook_type == 'SessionEnd':
            session_id = event.get('session_id', '')[:16]
            reason = event.get('reason', 'unknown')
            if session_id:
                lines.append(f"{color}  Session: {session_id}...{RESET}")
            lines.append(f"{color}  Reason: {reason}{RESET}")

        elif hook_type == 'UserPromptSubmit':
            prompt = event.get('prompt', '')
            lines.append(f"{color}  Prompt: {prompt[:200]}{'...' if len(prompt) > 200 else ''}{RESET}")

        elif hook_type == 'PreToolUse':
            tool_name = event.get('tool_name', 'unknown')
            tool_input = event.get('tool_input', {})
            lines.append(f"{color}  Tool: {tool_name}{RESET}")
            if tool_input:
                input_str = json.dumps(tool_input, indent=2)[:300]
                lines.append(f"{DIM}  Input: {input_str}{'...' if len(str(tool_input)) > 300 else ''}{RESET}")

        elif hook_type == 'PostToolUse':
            tool_name = event.get('tool_name', 'unknown')
            response = str(event.get('tool_response', ''))[:200]
            lines.append(f"{color}  Tool: {tool_name}{RESET}")
            lines.append(f"{DIM}  Response: {response}{'...' if len(str(event.get('tool_response', ''))) > 200 else ''}{RESET}")

        elif hook_type == 'PermissionRequest':
            tool_name = event.get('tool_name', 'unknown')
            tool_input = event.get('tool_input', {})
            lines.append(f"{color}  Tool: {tool_name}{RESET}")
            if tool_input:
                input_str = json.dumps(tool_input, indent=2)[:300]
                lines.append(f"{DIM}  Input: {input_str}{'...' if len(str(tool_input)) > 300 else ''}{RESET}")

        elif hook_type == 'Notification':
            message = event.get('message', '')
            notification_type = event.get('notification_type', '')
            lines.append(f"{color}  Message: {message}{RESET}")
            if notification_type:
                lines.append(f"{DIM}  Type: {notification_type}{RESET}")

        elif hook_type == 'Stop':
            session_id = event.get('session_id', '')[:16]
            stop_hook_active = event.get('stop_hook_active', False)
            if session_id:
                lines.append(f"{color}  Session: {session_id}...{RESET}")
            lines.append(f"{DIM}  Hook Active: {stop_hook_active}{RESET}")

        elif hook_type == 'SubagentStop':
            agent_id = event.get('agent_id', '')
            stop_hook_active = event.get('stop_hook_active', False)
            if agent_id:
                lines.append(f"{color}  Agent: {agent_id[:16]}...{RESET}")
            lines.append(f"{DIM}  Hook Active: {stop_hook_active}{RESET}")

        elif hook_type == 'PreCompact':
            trigger = event.get('trigger', 'unknown')
            custom_instructions = event.get('custom_instructions', '')
            lines.append(f"{color}  Trigger: {trigger}{RESET}")
            if custom_instructions:
                lines.append(f"{DIM}  Instructions: {custom_instructions[:100]}...{RESET}")

        lines.append(f"{color}{'─' * 50}{RESET}")

        return '\n'.join(lines)

    async def report(self, event: Dict[str, Any]) -> None:
        """
        Format and print event to console.

        Args:
            event: Hook event data dictionary
        """
        output = self._format_event(event)
        print(output, flush=True)

    async def get_recent(self) -> list:
        """
        Print reporter doesn't store events.

        Returns:
            Empty list (print reporter doesn't maintain history)
        """
        return []
