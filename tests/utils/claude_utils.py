"""Claude Code utility functions for testing."""

import os
import subprocess
import shutil
from typing import Optional, List
from pathlib import Path


def find_claude() -> Optional[str]:
    """
    Find the Claude Code executable in a cross-platform way.

    This function uses shutil.which() which works on all platforms:
    - Unix/Linux/macOS: searches PATH
    - Windows: searches PATH and PATHEXT

    Returns:
        str: Path to claude executable if found, None otherwise

    Example:
        >>> claude_path = find_claude()
        >>> if claude_path:
        ...     print(f"Claude found at: {claude_path}")
        ... else:
        ...     print("Claude not found")
    """
    return shutil.which("claude")


def check_claude_available() -> tuple[bool, Optional[str]]:
    """
    Check if Claude Code is available and return its path.

    This is a convenience wrapper around find_claude() that returns
    both a boolean status and the path.

    Returns:
        tuple: (is_available: bool, path: Optional[str])
            - is_available: True if claude command is found
            - path: Path to claude executable, or None if not found

    Example:
        >>> available, path = check_claude_available()
        >>> if available:
        ...     print(f"Claude available at: {path}")
        ... else:
        ...     print("Claude not available")
    """
    path = find_claude()
    return (path is not None, path)


def run_claude(
    workdir: Path,
    prompt: Optional[str] = None,
    extra_args: Optional[List[str]] = None,
    debug: bool = True,
    skip_permissions: bool = True
) -> subprocess.Popen:
    """
    Run Claude Code in a subprocess and return the process handle.

    Args:
        workdir: Working directory for Claude Code
        prompt: Optional prompt text (will use -p flag if provided)
        extra_args: Optional list of additional arguments
        debug: Whether to include --debug flag (default: True)
        skip_permissions: Whether to include --dangerously-skip-permissions (default: True)

    Returns:
        subprocess.Popen: The Claude Code process

    Example:
        >>> process = run_claude(Path("/tmp/test"), prompt="hi")
        >>> # ... wait for process ...
        >>> stdout, stderr = process.communicate(timeout=5)
        >>> print(f"Exit code: {process.returncode}")
    """
    command = ["claude"]

    # Add prompt if provided
    if prompt:
        command.extend(["-p", prompt])

    # Add --dangerously-skip-permissions for tests (default)
    if skip_permissions:
        command.append("--dangerously-skip-permissions")

    # Add debug flag if requested (default)
    if debug:
        command.append("--debug")

    # Add any extra arguments
    if extra_args:
        command.extend(extra_args)

    print(f"  Running command: {' '.join(command)}")

    # Unset CLAUDECODE so the subprocess doesn't refuse to start
    # when tests are run from within a Claude Code session.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    return subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(workdir),
        env=env,
    )
