"""Claude Code's workspace trust, read — never written: accepting it stays the person's step in Claude's prompt."""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.instance_settings import get_instance_settings

#: ``~/.claude.json``'s projects map, kept until the file changes (it is megabytes, and read per worktree launch).
_cached: tuple[tuple[float, int], dict] | None = None


def _projects() -> dict:
    global _cached
    path = get_instance_settings().user_home / ".claude.json"
    try:
        stat = path.stat()
    except OSError:
        return {}
    key = (stat.st_mtime, stat.st_size)
    if _cached is None or _cached[0] != key:
        try:
            settings = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        projects = settings.get("projects") if isinstance(settings, dict) else None
        _cached = (key, projects if isinstance(projects, dict) else {})
    return _cached[1]


def claude_trusts(workdir: str | None) -> bool:
    """Whether Claude has its workspace trust accepted for ``workdir`` itself. A trusted folder above it does not
    count: Claude refuses --worktree there even with ``/`` trusted."""
    if not workdir:
        return False
    entry = _projects().get(str(Path(workdir).expanduser().resolve())) or {}
    return bool(entry.get("hasTrustDialogAccepted"))
