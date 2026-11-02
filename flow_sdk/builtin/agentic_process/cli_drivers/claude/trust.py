"""Claude Code's workspace trust, read — never written: accepting it stays the person's step in Claude's prompt."""

from __future__ import annotations

import json
from pathlib import Path


def claude_trusts(workdir: str | None) -> bool:
    """Whether Claude has its workspace trust accepted for ``workdir`` itself (``~/.claude.json``). A trusted folder
    above it does not count: Claude refuses --worktree there even with ``/`` trusted."""
    if not workdir:
        return False
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    try:
        settings = json.loads((get_instance_settings().user_home / ".claude.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    projects = settings.get("projects") if isinstance(settings, dict) else None
    if not isinstance(projects, dict):
        return False
    here = Path(workdir).expanduser().resolve()
    return bool((projects.get(str(here)) or {}).get("hasTrustDialogAccepted"))
