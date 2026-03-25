"""
Shared utility functions for Claude Code settings file paths.

This module provides reusable functions for determining Claude Code settings.json
file paths based on scope, handling Windows/Unix differences and project paths.
"""

import os
import sys
from pathlib import Path
from typing import Optional, Union

# Platform constant (matching flowpad.config)
PLATFORM_WIN32 = "win32"


def get_user_home_path() -> Path:
    """
    Get the user home directory path, handling Windows and Unix.

    Returns:
        Path to user home directory
    """
    if sys.platform == PLATFORM_WIN32:
        return Path(os.environ.get("USERPROFILE", ""))
    return Path.home()


def get_claude_settings_path(
    scope: Union[str, object],
    project_path: Optional[Path] = None,
    require_repo: bool = False,
    repo_root: Optional[Path] = None,
) -> Path:
    """
    Get the path to Claude Code settings file based on scope.

    Args:
        scope: The scope (string "user", "project", or "local", or an enum with a .value attribute)
        project_path: Optional project path for PROJECT/LOCAL scopes.
                     If None, uses current working directory.
        require_repo: If True, raises ValueError for PROJECT/LOCAL when not in repo.
                     Used by CLIContext which requires git repo.
        repo_root: Optional repo root path. If provided and require_repo=True,
                  uses this instead of checking for git repo.

    Returns:
        Path to the settings.json file

    Raises:
        ValueError: If scope is invalid or require_repo=True and not in repo
    """
    # Convert scope to string if it's an enum
    if isinstance(scope, str):
        scope_lower = scope.lower()
    elif hasattr(scope, "value"):
        scope_lower = str(scope.value).lower()
    else:
        scope_lower = str(scope).lower()

    if scope_lower == "user":
        home = get_user_home_path()
        return home / ".claude" / "settings.json"

    elif scope_lower in ("project", "local"):
        if require_repo and repo_root is None:
            raise ValueError(f"Cannot use {scope_lower.upper()} scope: not in a git repository")

        # Use project_path if provided, otherwise fall back to repo_root or cwd
        base_path = repo_root if repo_root else (project_path if project_path else Path.cwd())

        filename = "settings.json" if scope_lower == "project" else "settings.local.json"
        settings_path = base_path / ".claude" / filename
        return settings_path

    else:
        raise ValueError(f"Unknown hook scope: {scope}")
