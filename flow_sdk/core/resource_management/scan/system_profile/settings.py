"""Settings - load settings from various sources."""

from .utils import (
    _claude_home,
    _claude_project_dir,
    _user_home,
    load_json,
)


def get_user_settings() -> dict | None:
    """Get ~/.claude/settings.json"""
    return load_json(_claude_home() / "settings.json")


def get_project_settings() -> dict | None:
    """Get .claude/settings.json"""
    return load_json(_claude_project_dir() / "settings.json")


def get_project_local_settings() -> dict | None:
    """Get .claude/settings.local.json"""
    return load_json(_claude_project_dir() / "settings.local.json")


def get_legacy_settings() -> dict | None:
    """Get ~/.claude.json"""
    return load_json(_user_home() / ".claude.json")


def clear_skill_usage() -> int:
    """Clear all skill usage counters from ~/.claude.json.

    Returns the number of entries cleared.
    """
    import json

    claude_json_path = _user_home() / ".claude.json"
    if not claude_json_path.exists():
        return 0

    with open(claude_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cleared = len(data.get("skillUsage", {}))
    data["skillUsage"] = {}

    with open(claude_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    return cleared


def get_all_settings() -> dict:
    """Get all settings from all sources."""
    return {
        "user": get_user_settings(),
        "project": get_project_settings(),
        "project_local": get_project_local_settings(),
        "legacy": get_legacy_settings(),
    }
