"""CLI runner utility for testing flow commands."""

import os
import subprocess
from pathlib import Path
from flow_sdk.cli.cli_command import CLICommand


def self_run_cli(command: str):
    """
    Run the flow CLI as if it was invoked from command line.

    Args:
        command: The command string (e.g., "ping hello" or "setup claude-code")

    Returns:
        subprocess.CompletedProcess result
    """
    # Parse the command using CLICommand
    cli_cmd = CLICommand(command, use_python=True)

    # Set up environment with PYTHONPATH
    project_root = Path(__file__).parent.parent.parent.parent.parent
    env = os.environ.copy()
    env["PYTHONPATH"] = str(project_root)

    # Run the CLI using the parsed executable args
    result = subprocess.run(
        cli_cmd.executable_args,
        capture_output=True,
        text=True,
        env=env,
        timeout=10
    )

    return result
