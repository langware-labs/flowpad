#!/usr/bin/env python3

import json
import os
from typing import Dict, List, Optional, Any
from pathlib import Path
from flow_sdk.cli.cli_context import CLIContext, ClaudeScope


class HookParser:
    """
    A class to manage Claude Code hooks configuration.

    Handles reading, writing, and modifying hooks in Claude settings.json format:
    {
      "hooks": {
        "EventName": [
          {
            "matcher": "ToolPattern",
            "hooks": [
              {
                "type": "command",
                "command": "your-command-here"
              }
            ]
          }
        ]
      }
    }

    Supports three scopes:
    - USER: ~/.claude/settings.json (global)
    - PROJECT: <repo>/.claude/settings.json (shared with team)
    - LOCAL: <repo>/.claude/settings.local.json (personal, not committed)
    """

    def __init__(self, hooks_file_path: Optional[str] = None,
                 context: Optional[CLIContext] = None,
                 scope: Optional[ClaudeScope] = None):
        """
        Initialize the HookParser with a settings file path or context.

        Args:
            hooks_file_path: Direct path to the settings file (for testing).
                           If None, uses context and scope.
            context: CLI context with path information.
            scope: The scope to use (USER, PROJECT, or LOCAL).
                  Defaults to USER if context is provided but scope is not.
        """
        if hooks_file_path:
            # Direct path provided (e.g., for testing)
            self.hooks_file_path = Path(hooks_file_path)
        elif context:
            # Use context to determine path based on scope
            if scope is None:
                scope = ClaudeScope.USER
            self.hooks_file_path = context.get_claude_settings_path(scope)
        else:
            # Fallback to default user settings
            home = Path.home()
            self.hooks_file_path = home / ".claude" / "settings.json"

        self.settings_data: Dict[str, Any] = {}
        self._load_settings()

    def _load_settings(self):
        """Load settings from the JSON file."""
        if self.hooks_file_path.exists():
            try:
                with open(self.hooks_file_path, 'r') as f:
                    self.settings_data = json.load(f)
                    # Ensure hooks key exists
                    if "hooks" not in self.settings_data:
                        self.settings_data["hooks"] = {}
            except json.JSONDecodeError as e:
                print(f"Error parsing settings file: {e}")
                self.settings_data = {"hooks": {}}
        else:
            # Initialize with empty hooks structure
            self.settings_data = {"hooks": {}}

    def save_hooks(self):
        """Save the settings data to the JSON file."""
        # Create directory if it doesn't exist
        self.hooks_file_path.parent.mkdir(parents=True, exist_ok=True)

        # Clean up invalid null values (Claude expects arrays, not null)
        hooks = self.settings_data.get("hooks", {})
        keys_to_remove = [k for k, v in hooks.items() if v is None]
        for k in keys_to_remove:
            del hooks[k]

        with open(self.hooks_file_path, 'w') as f:
            json.dump(self.settings_data, f, indent=2)

    def get_hooks(self) -> Dict[str, Any]:
        """
        Get all hooks data.

        Returns:
            The complete hooks data structure
        """
        return self.settings_data.get("hooks", {})

    def get_event_hooks(self, event_name: str) -> List[Dict[str, Any]]:
        """
        Get all hooks for a specific event.

        Args:
            event_name: The name of the event (e.g., "tool_use", "message_sent")

        Returns:
            List of hook configurations for the event, or empty list if none exist
        """
        return self.settings_data["hooks"].get(event_name, [])

    def add_hook(self, event_name: str, matcher: Optional[str], hook_type: str,
                 command: str, flow_metadata: Optional[Dict[str, Any]] = None, **kwargs):
        """
        Add a new hook for an event.

        Args:
            event_name: The name of the event (e.g., "tool_use", "UserPromptSubmit")
            matcher: The pattern to match (e.g., "ToolName", "Grep", "*").
                    Use None for events like UserPromptSubmit that don't use matchers.
            hook_type: The type of hook (e.g., "command")
            command: The command to execute
            flow_metadata: Optional dict with flow-specific metadata to store in the entry.
                          If provided, marks this as a flow-managed hook.
                          Example: {"managed": True, "version": "1.0", "name": "prompt"}
            **kwargs: Additional hook properties
        """
        if event_name not in self.settings_data["hooks"]:
            self.settings_data["hooks"][event_name] = []

        # Create the hook object
        hook_obj = {
            "type": hook_type,
            "command": command,
            **kwargs
        }

        # Events like UserPromptSubmit don't use matchers
        if matcher is None:
            # Find existing flow entry without matcher (if flow_metadata provided)
            # or find any entry without matcher (if no flow_metadata)
            matcher_entry = None
            for entry in self.settings_data["hooks"][event_name]:
                if "matcher" not in entry:
                    # If we're adding a flow hook, look for existing flow entry
                    if flow_metadata and "flow" in entry:
                        matcher_entry = entry
                        break
                    elif not flow_metadata and "flow" not in entry:
                        matcher_entry = entry
                        break

            if matcher_entry:
                # Add to existing entry
                matcher_entry["hooks"].append(hook_obj)
                # Update flow metadata if provided
                if flow_metadata:
                    matcher_entry["flow"] = flow_metadata
            else:
                # Create new entry without matcher
                new_entry = {
                    "hooks": [hook_obj]
                }
                if flow_metadata:
                    new_entry["flow"] = flow_metadata
                self.settings_data["hooks"][event_name].append(new_entry)
        else:
            # Check if matcher already exists
            matcher_entry = None
            for entry in self.settings_data["hooks"][event_name]:
                if entry.get("matcher") == matcher:
                    matcher_entry = entry
                    break

            if matcher_entry:
                # Add to existing matcher
                matcher_entry["hooks"].append(hook_obj)
                # Update flow metadata if provided
                if flow_metadata:
                    matcher_entry["flow"] = flow_metadata
            else:
                # Create new matcher entry
                new_entry = {
                    "matcher": matcher,
                    "hooks": [hook_obj]
                }
                if flow_metadata:
                    new_entry["flow"] = flow_metadata
                self.settings_data["hooks"][event_name].append(new_entry)

    def remove_hook(self, event_name: str, matcher: Optional[str] = None,
                   command: Optional[str] = None) -> bool:
        """
        Remove hook(s) from an event.

        Args:
            event_name: The name of the event
            matcher: Optional matcher pattern. If provided, removes all hooks for this matcher.
                    If None, command must be provided.
            command: Optional command string. If provided, removes hooks with this command.

        Returns:
            True if any hooks were removed, False otherwise
        """
        if event_name not in self.settings_data["hooks"]:
            return False

        removed = False
        event_hooks = self.settings_data["hooks"][event_name]

        if matcher:
            # Remove entire matcher entry
            original_len = len(event_hooks)
            self.settings_data["hooks"][event_name] = [
                entry for entry in event_hooks
                if entry.get("matcher") != matcher
            ]
            removed = len(self.settings_data["hooks"][event_name]) < original_len
        elif command:
            # Remove hooks with specific command
            for entry in event_hooks:
                original_len = len(entry["hooks"])
                entry["hooks"] = [
                    hook for hook in entry["hooks"]
                    if hook.get("command") != command
                ]
                if len(entry["hooks"]) < original_len:
                    removed = True

            # Clean up empty matcher entries
            self.settings_data["hooks"][event_name] = [
                entry for entry in event_hooks
                if entry["hooks"]
            ]

        # Clean up empty event entries
        if not self.settings_data["hooks"][event_name]:
            del self.settings_data["hooks"][event_name]

        return removed

    def update_matcher(self, event_name: str, old_matcher: str,
                      new_matcher: str) -> bool:
        """
        Update a matcher pattern for an event.

        Args:
            event_name: The name of the event
            old_matcher: The current matcher pattern
            new_matcher: The new matcher pattern

        Returns:
            True if matcher was updated, False if not found
        """
        if event_name not in self.settings_data["hooks"]:
            return False

        for entry in self.settings_data["hooks"][event_name]:
            if entry.get("matcher") == old_matcher:
                entry["matcher"] = new_matcher
                return True

        return False

    def list_events(self) -> List[str]:
        """
        List all event names that have hooks configured.

        Returns:
            List of event names
        """
        return list(self.settings_data["hooks"].keys())

    def list_matchers(self, event_name: str) -> List[str]:
        """
        List all matchers for a specific event.

        Args:
            event_name: The name of the event

        Returns:
            List of matcher patterns
        """
        if event_name not in self.settings_data["hooks"]:
            return []

        return [entry.get("matcher", "") for entry in self.settings_data["hooks"][event_name]]

    def clear_event(self, event_name: str) -> bool:
        """
        Clear all hooks for a specific event.

        Args:
            event_name: The name of the event

        Returns:
            True if event was cleared, False if it didn't exist
        """
        if event_name in self.settings_data["hooks"]:
            del self.settings_data["hooks"][event_name]
            return True
        return False

    def clear_all(self):
        """Clear all hooks from the configuration."""
        self.settings_data["hooks"] = {}

    def get_hook_details(self, event_name: str, matcher: str) -> Optional[List[Dict[str, Any]]]:
        """
        Get detailed information about hooks for a specific event and matcher.

        Args:
            event_name: The name of the event
            matcher: The matcher pattern

        Returns:
            List of hook details, or None if not found
        """
        if event_name not in self.settings_data["hooks"]:
            return None

        for entry in self.settings_data["hooks"][event_name]:
            if entry.get("matcher") == matcher:
                return entry.get("hooks", [])

        return None

    def is_flow_managed(self, entry: Dict[str, Any]) -> bool:
        """
        Check if a hook entry is managed by flow.

        Args:
            entry: A hook entry from the hooks list

        Returns:
            True if the entry has flow metadata, False otherwise
        """
        return "flow" in entry

    def get_flow_entries(self, event_name: str) -> List[Dict[str, Any]]:
        """
        Get all flow-managed entries for an event.

        Args:
            event_name: The name of the event

        Returns:
            List of entries that have flow metadata
        """
        if event_name not in self.settings_data["hooks"]:
            return []

        event_hooks = self.settings_data["hooks"].get(event_name)
        if event_hooks is None:
            return []

        return [entry for entry in event_hooks if self.is_flow_managed(entry)]

    def remove_flow_hooks(self, event_name: str, matcher: Optional[str] = None) -> bool:
        """
        Remove all flow-managed hooks for an event.

        Only removes entries that have the "flow" metadata section.
        Non-flow hooks are left untouched.

        Args:
            event_name: The name of the event
            matcher: Optional matcher pattern. If provided, only removes flow hooks
                    with this matcher.

        Returns:
            True if any flow hooks were removed, False otherwise
        """
        if event_name not in self.settings_data["hooks"]:
            return False

        event_hooks = self.settings_data["hooks"].get(event_name)
        if event_hooks is None:
            return False

        original_len = len(event_hooks)

        # Filter out flow-managed entries (optionally matching a specific matcher)
        if matcher is not None:
            self.settings_data["hooks"][event_name] = [
                entry for entry in event_hooks
                if not (self.is_flow_managed(entry) and entry.get("matcher") == matcher)
            ]
        else:
            self.settings_data["hooks"][event_name] = [
                entry for entry in event_hooks
                if not self.is_flow_managed(entry)
            ]

        removed = len(self.settings_data["hooks"][event_name]) < original_len

        # Clean up empty event entries
        if not self.settings_data["hooks"][event_name]:
            del self.settings_data["hooks"][event_name]

        return removed

    def __str__(self) -> str:
        """String representation of the hooks configuration."""
        return json.dumps(self.settings_data, indent=2)
