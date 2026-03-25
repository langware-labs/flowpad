#!/usr/bin/env python3
"""
CLI Command class for parsing and executing flow CLI commands.
"""

from pathlib import Path
from typing import List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.cli.cli_context import CLIContext


class CLICommand:
    """
    Represents a CLI command with parsing and execution capabilities.

    The command can be executed either as an installed command (e.g., 'flow ping hello')
    or using Python directly (e.g., 'python3 flow_cli.py ping hello').

    The command can also hold a CLIContext for passing to command handlers.
    """

    def __init__(self, command: str, use_python: bool = False, context: Optional["CLIContext"] = None):
        """
        Initialize a CLI command.

        Args:
            command: The command string (e.g., "ping hello" or "setup claude-code")
            use_python: If True, use 'python3 flow_cli.py' instead of 'flow' command
            context: Optional CLIContext for the command execution
        """
        self.command = command.strip()
        self.use_python = use_python
        self.context = context
        self._parse_command()

    def _parse_command(self):
        """Parse the command string into components."""
        parts = self.command.split()
        if not parts:
            self.subcommand = None
            self.args = []
        else:
            self.subcommand = parts[0]
            self.args = parts[1:] if len(parts) > 1 else []

    @property
    def executable_args(self) -> List[str]:
        """
        Get the executable arguments for subprocess.

        Returns:
            List of arguments suitable for subprocess.run()
        """
        if self.use_python:
            # Get the path to flow_cli.py
            project_root = Path(__file__).parent
            flow_cli_path = project_root / "flow_cli.py"
            return ["python3", str(flow_cli_path)] + ([self.subcommand] if self.subcommand else []) + self.args
        else:
            # Use installed flow command
            return ["flow"] + ([self.subcommand] if self.subcommand else []) + self.args

    @property
    def command_str(self) -> str:
        """
        Get the command as a string suitable for display.

        Returns:
            Command string for display/logging
        """
        if self.use_python:
            return f"python3 flow_cli.py {self.command}"
        else:
            return f"flow {self.command}"

    def __repr__(self) -> str:
        """String representation of the command."""
        context_info = f", context={self.context is not None}" if self.context else ""
        return f"CLICommand(command='{self.command}', use_python={self.use_python}{context_info})"

    def __str__(self) -> str:
        """User-friendly string representation."""
        return self.command_str
