#!/usr/bin/env python3
"""Tests for claude_hooks.py functions."""

import json
import subprocess
import tempfile
from pathlib import Path
import pytest
from flow_sdk.cli.cli_context import CLIContext, ClaudeScope
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.claude_hooks import setHook, removeHook
from flow_sdk.cli.commands.setup_cmd.claude_code_setup.flow_metadata import FlowHookMetadata


def test_set_hook_user_scope():
    """Test setHook creates hook in USER scope."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create a temporary context with custom paths
        tmp_path = Path(tmpdir)
        user_home = tmp_path / "home"
        user_home.mkdir()

        # Create .claude directory
        claude_dir = user_home / ".claude"
        claude_dir.mkdir()

        # Create a context pointing to our temp directory
        context = CLIContext(working_dir=str(tmp_path))
        # Override user_home for testing
        context.user_home = user_home

        # Set a hook
        success = setHook(
            scope=ClaudeScope.USER,
            event_name="UserPromptSubmit",
            matcher=None,
            cmd="flow prompt test",
            context=context
        )

        assert success is True

        # Verify the settings file was created
        settings_file = user_home / ".claude" / "settings.json"
        assert settings_file.exists()

        # Verify the hook was added
        with open(settings_file) as f:
            settings = json.load(f)

        assert "hooks" in settings
        assert "UserPromptSubmit" in settings["hooks"]


def test_set_hook_project_scope():
    """Test setHook creates hook in PROJECT scope."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        # Initialize a real git repo
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)

        # Create .claude directory
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()

        context = CLIContext(working_dir=str(tmp_path))

        # Set a hook
        success = setHook(
            scope=ClaudeScope.PROJECT,
            event_name="UserPromptSubmit",
            matcher=None,
            cmd="flow prompt test",
            context=context
        )

        assert success is True

        # Verify the settings file was created
        settings_file = tmp_path / ".claude" / "settings.json"
        assert settings_file.exists()

        # Verify the hook was added
        with open(settings_file) as f:
            settings = json.load(f)

        assert "hooks" in settings
        assert "UserPromptSubmit" in settings["hooks"]


def test_remove_hook_flow_command():
    """Test removeHook removes flow commands."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        # Initialize a real git repo
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)

        # Create .claude directory
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()

        context = CLIContext(working_dir=str(tmp_path))

        # First, set a hook with flow metadata (so it's flow-managed)
        flow_metadata = FlowHookMetadata.create(name="test")
        setHook(
            scope=ClaudeScope.PROJECT,
            event_name="UserPromptSubmit",
            matcher=None,
            cmd="flow prompt test",
            context=context,
            flow_metadata=flow_metadata
        )

        # Now remove it
        success = removeHook(
            scope=ClaudeScope.PROJECT,
            event_name="UserPromptSubmit",
            matcher=None,
            context=context
        )

        assert success is True

        # Verify the hook was removed
        settings_file = tmp_path / ".claude" / "settings.json"
        with open(settings_file) as f:
            settings = json.load(f)

        # Hook should be removed or empty
        if "hooks" in settings and "UserPromptSubmit" in settings["hooks"]:
            # If the event still exists, it should be empty
            assert len(settings["hooks"]["UserPromptSubmit"]) == 0


def test_remove_hook_preserves_non_flow_commands():
    """Test removeHook does not remove non-flow commands."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        # Initialize a real git repo
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)

        # Create .claude directory and settings file
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()

        settings_file = claude_dir / "settings.json"

        # Manually create settings with a non-flow hook
        settings = {
            "hooks": {
                "UserPromptSubmit": [
                    {
                        "type": "command",
                        "command": "echo 'not a flow command'"
                    }
                ]
            }
        }

        with open(settings_file, "w") as f:
            json.dump(settings, f)

        context = CLIContext(working_dir=str(tmp_path))

        # Try to remove hooks
        success = removeHook(
            scope=ClaudeScope.PROJECT,
            event_name="UserPromptSubmit",
            matcher=None,
            context=context
        )

        # Should return False because no flow hooks were found
        assert success is False

        # Verify the non-flow hook is still there
        with open(settings_file) as f:
            updated_settings = json.load(f)

        assert "hooks" in updated_settings
        assert "UserPromptSubmit" in updated_settings["hooks"]
        assert len(updated_settings["hooks"]["UserPromptSubmit"]) == 1
        assert updated_settings["hooks"]["UserPromptSubmit"][0]["command"] == "echo 'not a flow command'"


def test_remove_hook_no_hooks():
    """Test removeHook returns False when no hooks exist."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        # Initialize a real git repo
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)

        # Create .claude directory
        claude_dir = tmp_path / ".claude"
        claude_dir.mkdir()

        context = CLIContext(working_dir=str(tmp_path))

        # Try to remove a hook that doesn't exist
        success = removeHook(
            scope=ClaudeScope.PROJECT,
            event_name="UserPromptSubmit",
            matcher=None,
            context=context
        )

        assert success is False
