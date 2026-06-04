#!/usr/bin/env python3
"""
Flow prompt command handler.
Called by Claude Code hook on UserPromptSubmit events.
"""

from flow_sdk.cli.cli_command import CLICommand
from flow_sdk.cli.config_manager import get_config_value, set_config_value, setup_defaults
import requests
from flow_sdk.instance_settings import get_instance_settings


def onboard():
    """
    Run first-time onboarding for Flow.
    """
    print("\n" + "="*60)
    print("🌊 WELCOME TO FLOW! 🌊")
    print("="*60)
    print("\nOnboarding...")
    print("✓ Flow is now tracking your coding sessions!")
    print("✓ You can use 'flow config list' to see your configuration")
    print("✓ Happy coding!")
    print("="*60 + "\n")

    # Clear the first-time flag
    set_config_value("first_time_prompt", "false")


def handle_prompt(user_prompt):
    """
    Handle a user prompt from Claude Code.

    Args:
        user_prompt: The prompt text from the user

    Returns:
        str: Response message (if any)
    """
    # Check if this is the first time
    first_time = get_config_value("first_time_prompt")

    if first_time is None or first_time == "true":
        # First time - run onboarding
        onboard()
    else:
        # Not first time - just a regular prompt
        # You can add tracking logic here if needed
        pass

    # Send prompt to local server for testing/tracking
    try:
        port = get_instance_settings().port
        url = f"http://127.0.0.1:{port}/prompt"
        requests.get(url, params={"prompt_text": user_prompt}, timeout=5)
    except Exception:
        # Silently fail if server is not available
        pass

    # Return empty string to not interfere with Claude's processing
    return ""


def run_prompt_command(user_prompt, cmd: CLICommand):
    """
    Main entry point for 'flow prompt' command.

    Args:
        user_prompt: The user's prompt text
        cmd: CLICommand with context and command details
    """
    return handle_prompt(user_prompt)
