"""CLI runner utility for testing flow commands."""

import os
import subprocess
from pathlib import Path


def self_run_cli(command: str):
    """
    Run the flow CLI as if it was invoked from command line.

    Args:
        command: The command string (e.g., "ping hello" or "setup claude-code")

    Returns:
        subprocess.CompletedProcess result
    """
    # Run through flow_cli.py directly (not the installed `flow` console script)
    flow_cli_path = Path(__file__).parent.parent.parent / "flow_sdk" / "cli" / "flow_cli.py"
    argv = ["python3", str(flow_cli_path), *command.split()]

    # Set up environment with PYTHONPATH
    project_root = Path(__file__).parent.parent.parent.parent.parent
    env = os.environ.copy()
    env["PYTHONPATH"] = str(project_root)

    # Run the CLI using the parsed executable args
    result = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        env=env,
        timeout=10
    )

    return result
