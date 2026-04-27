#!/usr/bin/env python3

import os
import sys
from pathlib import Path
from flow_sdk.cli.cli_command import CLICommand
from flow_sdk.cli.cli_context import CLIContext, ClaudeScope
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.hook_parser import HookParser
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.claude_hooks import setHook, removeHook
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.hook_events import EVENTS_NO_MATCHER, EVENTS_WITH_MATCHER
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.flow_metadata import FlowHookMetadata


def setup_claude_code(cmd: CLICommand):
    """
    Run the setup specific to Claude Code.

    Args:
        cmd: CLICommand with context and command details

    Returns:
        str: Setup result message
    """
    print("Setting up Claude Code integration...")

    context = cmd.context

    # Determine the scope to use
    scope = _determine_scope(context)
    print(f"Using scope: {scope.value} - {context.get_scope_description(scope)}")
    print(f"Settings path: {context.get_claude_settings_path(scope)}")

    print("Configuring Claude Code hooks...")

    from flow_sdk.builtin.flowpad_runner_wrapper import wrap_command

    success_count = 0
    total_count = len(EVENTS_NO_MATCHER) + len(EVENTS_WITH_MATCHER)

    # Set hooks for events without matchers
    for event_name in EVENTS_NO_MATCHER:
        flow_metadata = FlowHookMetadata.create(name=event_name.lower())
        hook_cmd = wrap_command(f"hooks report --name={event_name.lower()}")
        success = setHook(
            scope=scope,
            event_name=event_name,
            matcher=None,
            cmd=hook_cmd,
            context=context,
            flow_metadata=flow_metadata,
        )
        if success:
            print(f"  ✓ {event_name}")
            success_count += 1
        else:
            print(f"  ✗ {event_name} (failed)")

    # Set hooks for events with matchers (match all tools)
    for event_name in EVENTS_WITH_MATCHER:
        flow_metadata = FlowHookMetadata.create(name=event_name.lower())
        hook_cmd = wrap_command(f"hooks report --name={event_name.lower()}")
        success = setHook(
            scope=scope,
            event_name=event_name,
            matcher="*",
            cmd=hook_cmd,
            context=context,
            flow_metadata=flow_metadata,
        )
        if success:
            print(f"  ✓ {event_name} (matcher: *)")
            success_count += 1
        else:
            print(f"  ✗ {event_name} (failed)")

    print(f"Hooks configured: {success_count}/{total_count}")
    print("✓ Claude Code setup complete!")
    print("\n" + "="*50)
    print("🎉 Restart Claude and type 'hello' to start :)")
    print("="*50)

    return "Claude Code setup successful"


def _get_hook_script_path() -> Path:
    """
    Get the path to the flow_prompt_hook.py script.

    Returns:
        Path to the hook script
    """
    # Try to find the script in the installed package location
    try:
        import flow_sdk.cli.commands.setup_cmd.claude_code_setup
        package_dir = Path(commands.setup_cmd.claude_code_setup.__file__).parent
        hook_script = package_dir / "flow_prompt_hook.py"
        return hook_script
    except Exception:
        # Fallback to local installation
        return Path(__file__).parent / "flow_prompt_hook.py"


def _ensure_hook_script_exists(hook_script_path: Path):
    """
    Ensure the hook script exists, create if missing.

    Args:
        hook_script_path: Path where the hook script should be
    """
    hook_script_content = '''#!/usr/bin/env python3
"""
Claude Code hook script for UserPromptSubmit event.
Receives user prompt via stdin and forwards to 'flow prompt' command.
"""

import json
import sys
import subprocess


def main():
    try:
        # Read the hook input from stdin
        input_data = json.load(sys.stdin)

        # Extract the user's prompt
        user_prompt = input_data.get("prompt", "")

        # Run the flow prompt command
        result = subprocess.run(
            ["flow", "prompt", user_prompt],
            capture_output=True,
            text=True
        )

        # Print any output from the flow command
        if result.stdout:
            print(result.stdout, end='')

        # Exit with 0 to allow the prompt to proceed
        sys.exit(0)

    except Exception as e:
        # Log error but don't block the prompt
        print(f"Flow hook error: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
'''

    hook_script_path.parent.mkdir(parents=True, exist_ok=True)
    hook_script_path.write_text(hook_script_content)
    os.chmod(hook_script_path, 0o755)


def _determine_scope(context: CLIContext) -> ClaudeScope:
    """
    Determine which scope to use for setup.

    Priority:
    1. If in a git repo, use PROJECT scope (shared with team)
    2. Otherwise, use USER scope (global)

    Args:
        context: CLI context

    Returns:
        The scope to use
    """
    if context.is_in_repo():
        return ClaudeScope.PROJECT
    else:
        return ClaudeScope.USER


def add_flow_tracking_hook():
    """
    Example function to add Flow tracking hook to Claude Code.
    """
    hook_parser = HookParser()

    # Add a hook to track all tool usage
    hook_parser.add_hook(
        event_name="tool_use",
        matcher="*",
        hook_type="command",
        command="flow track tool-use"
    )

    hook_parser.save_hooks()
    print("✓ Flow tracking hook added successfully!")


def list_claude_hooks():
    """
    Example function to list all Claude Code hooks.
    """
    hook_parser = HookParser()

    events = hook_parser.list_events()

    if not events:
        print("No hooks configured.")
        return

    print("Configured hooks:")
    for event in events:
        print(f"\nEvent: {event}")
        matchers = hook_parser.list_matchers(event)
        for matcher in matchers:
            print(f"  Matcher: {matcher}")
            hooks = hook_parser.get_hook_details(event, matcher)
            if hooks:
                for hook in hooks:
                    print(f"    - Type: {hook.get('type')}")
                    print(f"      Command: {hook.get('command')}")


def remove_flow_hooks():
    """
    Example function to remove Flow-related hooks from Claude Code.
    """
    hook_parser = HookParser()

    # Remove all hooks with Flow commands
    removed = hook_parser.remove_hook(
        event_name="tool_use",
        command="flow track tool-use"
    )

    if removed:
        hook_parser.save_hooks()
        print("✓ Flow hooks removed successfully!")
    else:
        print("No Flow hooks found to remove.")
