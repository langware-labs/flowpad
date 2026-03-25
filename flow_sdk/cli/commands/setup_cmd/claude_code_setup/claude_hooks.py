#!/usr/bin/env python3
"""
Claude Code hooks management functions.
Provides high-level API for setting and removing hooks.
"""

from typing import Optional
from flow_sdk.cli.cli_context import CLIContext, ClaudeScope
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.hook_parser import HookParser
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.flow_metadata import FlowHookMetadata


def setHook(
    scope: ClaudeScope,
    event_name: str,
    matcher: Optional[str],
    cmd: str,
    context: Optional[CLIContext] = None,
    flow_metadata: Optional[FlowHookMetadata] = None
) -> bool:
    """
    Set a hook for a specific event in Claude Code settings.

    If flow_metadata is provided, the hook is marked as flow-managed.
    If a flow-managed hook already exists for this event/matcher, it is replaced.

    Args:
        scope: The Claude scope (PROJECT or USER)
        event_name: The event name (e.g., "UserPromptSubmit", "tool_use")
        matcher: Optional matcher pattern (None for events that don't use matchers)
        cmd: The command to execute (e.g., "flow ping hello")
        context: Optional CLIContext. If not provided, creates a new one.
        flow_metadata: Optional FlowHookMetadata. If provided, marks as flow-managed.

    Returns:
        bool: True if hook was set successfully, False otherwise

    Example:
        metadata = FlowHookMetadata.create(name="prompt")
        setHook(ClaudeScope.USER, "UserPromptSubmit", None, cmd, flow_metadata=metadata)
    """
    try:
        # Create context if not provided
        if context is None:
            context = CLIContext()

        # Initialize hook parser with the specified scope
        hook_parser = HookParser(context=context, scope=scope)

        # If flow_metadata provided, remove existing flow hooks first (replace behavior)
        if flow_metadata:
            hook_parser.remove_flow_hooks(event_name, matcher)

        # Add the hook
        hook_parser.add_hook(
            event_name=event_name,
            matcher=matcher,
            hook_type="command",
            command=cmd,
            flow_metadata=flow_metadata.to_dict() if flow_metadata else None
        )

        # Save the hooks configuration
        hook_parser.save_hooks()

        return True

    except Exception as e:
        print(f"Error setting hook: {e}")
        return False


def removeHook(
    scope: ClaudeScope,
    event_name: str,
    matcher: Optional[str],
    context: Optional[CLIContext] = None
) -> bool:
    """
    Remove flow-managed hooks for an event.

    Only removes hooks that have the "flow" metadata section.
    Non-flow hooks are left untouched.

    Args:
        scope: The Claude scope (PROJECT or USER)
        event_name: The event name (e.g., "UserPromptSubmit", "tool_use")
        matcher: Optional matcher pattern (None for events that don't use matchers)
        context: Optional CLIContext. If not provided, creates a new one.

    Returns:
        bool: True if a flow hook was found and removed, False otherwise

    Example:
        removeHook(ClaudeScope.PROJECT, "UserPromptSubmit", None)
        removeHook(ClaudeScope.USER, "tool_use", "bash")
    """
    try:
        # Create context if not provided
        if context is None:
            context = CLIContext()

        # Initialize hook parser with the specified scope
        hook_parser = HookParser(context=context, scope=scope)

        # Get flow-managed entries before removal (for logging)
        flow_entries = hook_parser.get_flow_entries(event_name)

        if not flow_entries:
            print(f"No flow-managed hooks found for event '{event_name}'")
            return False

        # Remove flow-managed hooks
        removed = hook_parser.remove_flow_hooks(event_name, matcher)

        if removed:
            hook_parser.save_hooks()
            for entry in flow_entries:
                flow_meta = entry.get("flow", {})
                flow_name = flow_meta.get("name", "unnamed")
                print(f"✓ Removed flow hook: {flow_name} (version {flow_meta.get('version', '?')})")

        return removed

    except Exception as e:
        print(f"Error removing hook: {e}")
        return False
