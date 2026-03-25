#!/usr/bin/env python3
"""
Claude Code hook script for UserPromptSubmit event.
Receives user prompt via stdin and calls 'flow ping' command.
"""

import json
import sys
import subprocess
import os
from pathlib import Path


def main():
    try:
        # Read the hook input from stdin
        input_data = json.load(sys.stdin)

        # Extract the user's prompt
        user_prompt = input_data.get("prompt", "")

        # Try to find flow_cli.py in the package
        # First try the installed location
        try:
            from flow_sdk.cli import flow_cli
            flow_cli_path = Path(flow_cli.__file__)
        except ImportError:
            # Fallback to relative path from this script
            flow_cli_path = Path(__file__).parent.parent.parent.parent / "flow_cli.py"

        # Run the flow ping command with the prompt
        if flow_cli_path.exists():
            result = subprocess.run(
                ["python3", str(flow_cli_path), "ping", user_prompt],
                capture_output=True,
                text=True,
                timeout=5
            )
        else:
            # Try using installed flow command
            result = subprocess.run(
                ["flow", "ping", user_prompt],
                capture_output=True,
                text=True,
                timeout=5
            )

        # Print any output from the flow command
        if result.stdout:
            print(result.stdout, end='', file=sys.stderr)

        # Exit with 0 to allow the prompt to proceed
        sys.exit(0)

    except Exception as e:
        # Log error but don't block the prompt
        print(f"Flow ping hook error: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
