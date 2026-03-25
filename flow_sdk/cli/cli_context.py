#!/usr/bin/env python3
"""
CLI Context module for managing paths and scopes throughout the flow CLI application.

Claude Code supports three scopes for hooks configuration:
1. User scope: ~/.claude/settings.json (global, applies to all projects)
2. Project scope: <repo_root>/.claude/settings.json (shared with team, committed)
3. Local scope: <repo_root>/.claude/settings.local.json (personal, not committed)
"""

import os
import subprocess
from pathlib import Path
from typing import Optional
from enum import Enum


class ClaudeScope(Enum):
    """Enumeration of Claude Code configuration scopes."""
    USER = "user"           # ~/.claude/settings.json
    PROJECT = "project"     # .claude/settings.json (committed)
    LOCAL = "local"         # .claude/settings.local.json (not committed)


class CLIContext:
    """
    Context manager for CLI paths and configuration.

    Provides access to:
    - Working directory
    - Repository root (if in a git repo)
    - User home directory
    - Claude Code settings file paths for different scopes
    """

    def __init__(self, working_dir: Optional[Path] = None):
        """
        Initialize the CLI context.

        Args:
            working_dir: The working directory to use. Defaults to current directory.
        """
        self.working_dir = Path(working_dir) if working_dir else Path.cwd()
        self.user_home = Path.home()
        self.repo_root = self._find_repo_root()
        self.api_config = self._init_api_config()

    def _init_api_config(self):
        """
        Initialize API configuration from environment variables.

        Returns:
            ApiConfig instance
        """
        from flow_sdk.client import ApiConfig

        # Create config from environment
        return ApiConfig()

    def _find_repo_root(self) -> Optional[Path]:
        """
        Find the git repository root starting from working_dir.

        Returns:
            Path to repo root, or None if not in a git repository
        """
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=self.working_dir,
                capture_output=True,
                text=True,
                check=True
            )
            return Path(result.stdout.strip())
        except (subprocess.CalledProcessError, FileNotFoundError):
            return None

    def get_claude_settings_path(self, scope: ClaudeScope) -> Path:
        """
        Get the path to Claude Code settings file for the specified scope.

        Args:
            scope: The scope (USER, PROJECT, or LOCAL)

        Returns:
            Path to the settings file

        Raises:
            ValueError: If PROJECT or LOCAL scope is requested but not in a git repo
        """
        if scope == ClaudeScope.USER:
            return self.user_home / ".claude" / "settings.json"

        elif scope == ClaudeScope.PROJECT:
            if not self.repo_root:
                raise ValueError("Cannot use PROJECT scope: not in a git repository")
            return self.repo_root / ".claude" / "settings.json"

        elif scope == ClaudeScope.LOCAL:
            if not self.repo_root:
                raise ValueError("Cannot use LOCAL scope: not in a git repository")
            return self.repo_root / ".claude" / "settings.local.json"

        else:
            raise ValueError(f"Invalid scope: {scope}")

    def get_claude_dir(self, scope: ClaudeScope) -> Path:
        """
        Get the .claude directory for the specified scope.

        Args:
            scope: The scope (USER, PROJECT, or LOCAL)

        Returns:
            Path to the .claude directory

        Raises:
            ValueError: If PROJECT or LOCAL scope is requested but not in a git repo
        """
        settings_path = self.get_claude_settings_path(scope)
        return settings_path.parent

    def is_in_repo(self) -> bool:
        """
        Check if the working directory is within a git repository.

        Returns:
            True if in a git repo, False otherwise
        """
        return self.repo_root is not None

    def get_available_scopes(self) -> list[ClaudeScope]:
        """
        Get list of available scopes based on current context.

        Returns:
            List of available ClaudeScope values
        """
        scopes = [ClaudeScope.USER]
        if self.is_in_repo():
            scopes.extend([ClaudeScope.PROJECT, ClaudeScope.LOCAL])
        return scopes

    def __repr__(self) -> str:
        """String representation of the context."""
        return (
            f"CLIContext(\n"
            f"  working_dir={self.working_dir},\n"
            f"  user_home={self.user_home},\n"
            f"  repo_root={self.repo_root},\n"
            f"  in_repo={self.is_in_repo()}\n"
            f")"
        )

    def get_scope_description(self, scope: ClaudeScope) -> str:
        """
        Get a human-readable description of a scope.

        Args:
            scope: The scope to describe

        Returns:
            Description string
        """
        descriptions = {
            ClaudeScope.USER: "User-wide settings (applies to all projects)",
            ClaudeScope.PROJECT: "Project settings (shared with team, committed to git)",
            ClaudeScope.LOCAL: "Local project settings (personal, not committed)"
        }
        return descriptions[scope]
