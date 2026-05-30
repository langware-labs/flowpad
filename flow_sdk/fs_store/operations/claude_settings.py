"""Mutations on ``~/.claude.json`` (Claude Code's user settings file).

Relocated from the deleted ``system_profile/settings.py``. This is a write
operation, not a filesystem scan — it does not belong in the indexer.
"""

from __future__ import annotations

import json

from flow_sdk.instance_settings import get_instance_settings


def clear_skill_usage() -> int:
    """Clear all skill usage counters from ``~/.claude.json``.

    Returns the number of entries cleared.
    """
    claude_json_path = get_instance_settings().user_home / ".claude.json"
    if not claude_json_path.exists():
        return 0

    with open(claude_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cleared = len(data.get("skillUsage", {}))
    data["skillUsage"] = {}

    with open(claude_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    return cleared
