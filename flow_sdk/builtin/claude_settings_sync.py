"""
Utility module for syncing AgentHook entities to Claude Code settings.json files.

This module handles:
- Writing hooks to the appropriate settings.json based on hook_scope
- Removing hooks when AgentHook entities are deleted
- Generating the command that calls back to FlowPad API
"""

import json
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.config import default_service_config
from flow_sdk.core.urls.service_urls import urls_service

if TYPE_CHECKING:
    from flow_sdk.builtin.agent_hook import AgentHook, HookScope
else:
    from flow_sdk.builtin.agent_hook import HookScope


def _build_matcher_str(hook: "AgentHook") -> str:
    """Build matcher string from hook matcher dict, defaults to '*'."""
    if hook.matcher:
        if "tool_name" in hook.matcher:
            return hook.matcher["tool_name"]
        if "pattern" in hook.matcher:
            return hook.matcher["pattern"]
    return "*"


def get_settings_path(hook_scope: "HookScope", project_path: Optional[Path] = None) -> Path:
    """Get the path to the Claude Code settings file based on scope."""
    scope_str = hook_scope.value.lower() if hasattr(hook_scope, "value") else str(hook_scope).lower()

    if scope_str == "user":
        return Path.home() / ".claude" / "settings.json"
    elif scope_str in ("project", "local"):
        base_path = project_path if project_path else Path.cwd()
        filename = "settings.json" if scope_str == "project" else "settings.local.json"
        return base_path / ".claude" / filename
    else:
        raise ValueError(f"Unknown hook scope: {hook_scope}")


def load_settings(settings_path: Path) -> dict[str, Any]:
    """Load settings from JSON file, creating empty structure if not exists."""
    if settings_path.exists():
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logging.warning(f"Failed to load settings from {settings_path}: {e}")
            return {"hooks": {}}
    return {"hooks": {}}


def save_settings(settings_path: Path, settings: dict[str, Any]) -> None:
    """Save settings to JSON file, creating directories if needed."""
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)


def _resolve_backend_url() -> str:
    """Resolve the backend URL, with desktop mode fallback."""
    svc = default_service_config.service_urls_config
    if svc and hasattr(svc, "api_url"):
        return svc.api_url
    # Desktop mode: service_urls_config is not set, use local server
    port = os.environ.get("LOCAL_SERVER_PORT", "9007")
    return f"http://localhost:{port}"


def get_webhook_listen_url(backend_url: str | None = None) -> str:
    """
    Build the full webhook/listen endpoint URL.

    Args:
        backend_url: The FlowPad backend URL (defaults to service config api_url)

    Returns:
        Full URL to the webhook/listen endpoint (e.g., http://localhost:9007/api/v1/webhook/listen)
    """
    if backend_url is None:
        backend_url = _resolve_backend_url()

    # Build the webhook/listen endpoint path: /api/v1/webhook/listen
    listen_path = f"{urls_service.api.api_prefix}/webhook/listen"

    # Combine with backend_url to get full URL (strip to avoid trailing spaces)
    return f"{backend_url}{listen_path}".strip()


def generate_hook_command(hook_id: str, event_name: str, name: str | None = None) -> str:
    """
    Generate the command that Claude Code will execute when the hook fires.

    Uses a wrapper script (~/.claude/flowpad_hook.sh or .ps1) instead of
    calling `flow` directly. The wrapper checks if `flow` exists and exits
    silently if not, preventing stale hooks from breaking Claude after
    flowpad is uninstalled.

    The hook name is embedded in the command itself (via --name) so that
    cleanup can identify hooks even after Claude Code strips custom keys
    like flow_metadata from settings.json (additionalProperties: false).

    Args:
        hook_id: The AgentHook entity ID
        event_name: The name of the event that triggers the hook
        name: Optional hook name (e.g. "flowpad_sniffer")

    Returns:
        Shell command string using the wrapper script
    """
    from flow_sdk.builtin.flowpad_runner_wrapper import wrap_command

    args = f"hooks report --hook-entry-id={hook_id}"
    if event_name == "PermissionRequest":
        args += " --wait-for-response"
    if name:
        args += f" --name={name}"
    return wrap_command(args)


async def sync_hook_to_settings(hook: "AgentHook", project_path: Optional[Path] = None) -> bool:
    """
    Sync an AgentHook entity to Claude Code settings.json.

    Args:
        hook: The AgentHook entity to sync
        project_path: Optional project path for PROJECT/LOCAL scopes.
                     If None for PROJECT/LOCAL scopes, attempts to find git repo root.

    Returns:
        True if sync was successful, False otherwise
    """
    try:
        if not hook.id:
            logging.warning("Cannot sync hook without ID")
            return False

        # For PROJECT/LOCAL scopes, try fallback options if project_path not provided
        if hook.hook_scope in (HookScope.PROJECT, HookScope.LOCAL) and project_path is None:
            # Fallback: Try CLAUDE_PROJECT_DIR environment variable (set by Claude Code)
            claude_project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
            if claude_project_dir:
                project_path = Path(claude_project_dir)
            else:
                # No project_path available - log warning and use current directory
                logging.warning(
                    f"[AgentHook] No project_path provided for {hook.hook_scope} scope hook {hook.id}, "
                    f"and CLAUDE_PROJECT_DIR environment variable is not set. "
                    f"Using current directory: {Path.cwd()}. "
                    f"This may cause hooks to be written to the wrong location. "
                    f"Claude Code may not find hooks in this location. "
                    f"Please ensure project_id is provided in the payload for PROJECT/LOCAL scope hooks."
                )
                project_path = Path.cwd()

        settings_path = get_settings_path(hook.hook_scope, project_path)
        settings = load_settings(settings_path)

        if "hooks" not in settings:
            settings["hooks"] = {}

        event_name = hook.event

        # Initialize event entry list if not exists
        if event_name not in settings["hooks"]:
            settings["hooks"][event_name] = []

        # Find existing FlowPad hook entry for this hook ID, or create new
        hook_entries = settings["hooks"][event_name]
        existing_entry_idx = None

        for idx, entry in enumerate(hook_entries):
            hooks_list = entry.get("hooks", [])
            for h in hooks_list:
                cmd = h.get("command", "")
                if f"--hook-entry-id={hook.id}" in cmd:
                    existing_entry_idx = idx
                    break
            if existing_entry_idx is not None:
                break

        # Build the hook command (embed hook_name for durable identification)
        hook_name = getattr(hook, "hook_name", None) or hook.name or hook.id
        command = hook.command if hook.command else generate_hook_command(hook.id, event_name, name=hook_name)

        # Build matcher string from matcher dict
        matcher_str = _build_matcher_str(hook)

        # Create the hook entry in Claude Code format
        # Identity is carried in the command string (--hook-entry-id, --name)
        # so it survives Claude Code stripping unknown keys.
        new_entry = {
            "matcher": matcher_str,
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                }
            ],
        }

        if existing_entry_idx is not None:
            # Update existing entry
            hook_entries[existing_entry_idx] = new_entry
        else:
            # Add new entry
            hook_entries.append(new_entry)

        # Update entry index on the hook
        hook.entry_index = existing_entry_idx if existing_entry_idx is not None else len(hook_entries) - 1

        save_settings(settings_path, settings)
        return True

    except Exception as e:
        logging.error(f"Failed to sync hook to settings: {e}")
        return False


async def remove_hook_from_settings(hook: "AgentHook", project_path: Optional[Path] = None) -> bool:
    """
    Remove an AgentHook from Claude Code settings.json.

    Args:
        hook: The AgentHook entity to remove
        project_path: Optional project path for PROJECT/LOCAL scopes.
                     If None for PROJECT/LOCAL scopes, attempts to resolve from project_id.

    Returns:
        True if removal was successful, False otherwise
    """
    try:
        if not hook.id:
            logging.warning("Cannot remove hook without ID")
            return False

        # Resolve project_path for PROJECT/LOCAL scopes (same logic as sync_hook_to_settings)
        if hook.hook_scope in (HookScope.PROJECT, HookScope.LOCAL) and project_path is None:
            # Try to resolve from project_id if available
            if hasattr(hook, "project_id") and hook.project_id:
                from flow_sdk.builtin.project import Project

                project = await Project.get_by_id(hook.project_id)
                if project and hasattr(project, "fs_storage_mount_path") and project.fs_storage_mount_path:
                    project_path = Path(project.fs_storage_mount_path)

            if project_path is None:
                # Fallback: Try CLAUDE_PROJECT_DIR environment variable
                claude_project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
                if claude_project_dir:
                    project_path = Path(claude_project_dir)
                else:
                    # Last resort: use current directory (with warning)
                    logging.warning(
                        f"[AgentHook] No project_path resolved for {hook.hook_scope} scope hook {hook.id} during deletion. "
                        f"Using current directory: {Path.cwd()}"
                    )
                    project_path = Path.cwd()

        settings_path = get_settings_path(hook.hook_scope, project_path)

        if not settings_path.exists():
            return True  # Nothing to remove

        settings = load_settings(settings_path)

        if "hooks" not in settings:
            return True

        event_name = hook.event

        if event_name not in settings["hooks"]:
            return True

        hook_entries = settings["hooks"][event_name]

        # Find and remove entries with our hook ID
        new_entries = []
        removed = False

        for idx, entry in enumerate(hook_entries):
            hooks_list = entry.get("hooks", [])

            def _is_our_hook(h: dict) -> bool:
                cmd = h.get("command", "")
                return f"--hook-entry-id={hook.id}" in cmd

            filtered_hooks = [h for h in hooks_list if not _is_our_hook(h)]

            if len(filtered_hooks) < len(hooks_list):
                removed = True

            if filtered_hooks:
                entry["hooks"] = filtered_hooks
                new_entries.append(entry)

        settings["hooks"][event_name] = new_entries

        # Clean up empty event entries
        if not settings["hooks"][event_name]:
            del settings["hooks"][event_name]

        save_settings(settings_path, settings)

        if removed:
            logging.info(f"Removed AgentHook {hook.id} from {settings_path}")

        return True

    except Exception as e:
        logging.error(f"Failed to remove hook from settings: {e}")
        return False


async def sync_sniffer_hook_to_settings(hook: "AgentHook", project_path: Optional[Path] = None) -> bool:
    """
    Sync a sniffer AgentHook to Claude Code settings.json for ALL hook events.

    Creates or updates a catch-all hook entry for each event, using a sniffer marker
    so it can be removed cleanly later.
    """
    from flow_sdk.builtin.agent_hook import DEFAULT_LISTENED_HOOKS

    try:
        if not hook.id:
            logging.warning("Cannot sync sniffer hook without ID")
            return False

        settings_path = get_settings_path(hook.hook_scope, project_path)
        settings = load_settings(settings_path)

        if "hooks" not in settings:
            settings["hooks"] = {}

        # Clean any existing sniffer entries to avoid duplicates (including orphaned entries from old sniffers)
        events_to_delete = []
        for event_name, hook_entries in settings["hooks"].items():
            if not isinstance(hook_entries, list):
                continue
            new_entries = []
            for entry in hook_entries:
                hooks_list = entry.get("hooks", [])

                def _is_sniffer_or_ours(h: dict) -> bool:
                    cmd = h.get("command", "")
                    return "--name=flowpad_sniffer" in cmd or f"--hook-entry-id={hook.id}" in cmd

                filtered_hooks = [h for h in hooks_list if not _is_sniffer_or_ours(h)]
                if filtered_hooks:
                    entry["hooks"] = filtered_hooks
                    new_entries.append(entry)
            if new_entries:
                settings["hooks"][event_name] = new_entries
            else:
                events_to_delete.append(event_name)

        for event_name in events_to_delete:
            del settings["hooks"][event_name]

        matcher_str = _build_matcher_str(hook)

        for event_name in DEFAULT_LISTENED_HOOKS:
            hook_entries = settings["hooks"].setdefault(event_name, [])

            existing_entry_idx = None
            for idx, entry in enumerate(hook_entries):
                hooks_list = entry.get("hooks", [])
                for h in hooks_list:
                    cmd = h.get("command", "")
                    if "--name=flowpad_sniffer" in cmd or f"--hook-entry-id={hook.id}" in cmd:
                        existing_entry_idx = idx
                        break
                if existing_entry_idx is not None:
                    break

            command = hook.command if hook.command else generate_hook_command(hook.id, event_name, name="flowpad_sniffer")
            new_entry = {
                "matcher": matcher_str,
                "hooks": [
                    {
                        "type": "command",
                        "command": command,
                    }
                ],
            }

            if existing_entry_idx is not None:
                hook_entries[existing_entry_idx] = new_entry
            else:
                hook_entries.append(new_entry)

        save_settings(settings_path, settings)
        return True

    except Exception as e:
        logging.error(f"Failed to sync sniffer hook to settings: {e}")
        return False


async def remove_sniffer_hook_from_settings(hook: "AgentHook", project_path: Optional[Path] = None) -> bool:
    """
    Remove sniffer hook entries from Claude Code settings.json for ALL hook events.
    """
    try:
        if not hook.id:
            logging.warning("Cannot remove sniffer hook without ID")
            return False

        settings_path = get_settings_path(hook.hook_scope, project_path)
        if not settings_path.exists():
            return True

        settings = load_settings(settings_path)
        if "hooks" not in settings:
            return True

        events_to_delete = []
        for event_name, hook_entries in settings["hooks"].items():
            if not isinstance(hook_entries, list):
                continue
            new_entries = []
            for entry in hook_entries:
                hooks_list = entry.get("hooks", [])

                def _is_sniffer(h: dict) -> bool:
                    cmd = h.get("command", "")
                    return "--name=flowpad_sniffer" in cmd

                filtered_hooks = [h for h in hooks_list if not _is_sniffer(h)]
                if filtered_hooks:
                    entry["hooks"] = filtered_hooks
                    new_entries.append(entry)
            if new_entries:
                settings["hooks"][event_name] = new_entries
            else:
                events_to_delete.append(event_name)

        for event_name in events_to_delete:
            del settings["hooks"][event_name]

        save_settings(settings_path, settings)
        return True

    except Exception as e:
        logging.error(f"Failed to remove sniffer hook from settings: {e}")
        return False