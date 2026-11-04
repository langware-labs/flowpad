"""Mutations on ``~/.claude.json`` (Claude Code's user settings file).

Relocated from the deleted ``system_profile/settings.py``. This is a write
operation, not a filesystem scan — it does not belong in the indexer.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.instances.atomic import write_json_atomic


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


def write_claude_flags(*, trust_folder: str | None = None, onboarding: bool = False, bypass: bool = False) -> None:
    """The launch card's fixes, written as Claude's own answers (atomic; a corrupt file raises, untouched)."""
    path = get_instance_settings().user_home / ".claude.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if trust_folder:  # Claude keys a Windows folder with forward slashes
        folder = Path(trust_folder).expanduser().resolve()
        data.setdefault("projects", {}).setdefault(folder.as_posix() if os.name == "nt" else str(folder), {})["hasTrustDialogAccepted"] = True
    if onboarding:
        data.update(hasCompletedOnboarding=True, theme=data.get("theme", "dark"))
    if bypass:
        data["bypassPermissionsModeAccepted"] = True
    write_json_atomic(path, data)
