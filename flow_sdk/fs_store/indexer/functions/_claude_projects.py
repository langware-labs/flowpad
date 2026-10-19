"""Shared helper for resolving real filesystem paths of Claude-tracked projects.

Claude stores per-project data in ~/.claude/projects/<encoded>/ where <encoded>
is the project path with '/' replaced by '-'. This encoding is ambiguous for
paths containing hyphens (e.g. /Users/foo/my-app → -Users-foo-my-app, which
decodes incorrectly to /Users/foo/my/app).

The reliable fix: read the 'cwd' field from a session JSONL file inside the
project directory, which stores the original unencoded path.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

from flow_sdk.assets.types.claude_project_path import decode_claude_project_dir


def _claude_projects_dir() -> Path:
    """Per-instance ~/.claude/projects (call-time, via InstanceSettings)."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().claude_projects_dir


# Match Windows encoded project names: starts with drive letter, e.g. "C-Users-<user-name>-project"









def iter_claude_project_paths(include_temp: bool = False) -> Iterator[Path]:
    """Yield the real filesystem path for each known Claude project.

    Uses 'cwd' from session JSONL files as the authoritative source.
    Falls back to the encoded-name decode for projects with no JSONL files
    (e.g. brand-new projects or memory-only entries).
    Only yields paths that exist on disk.

    Args:
        include_temp: If False (default), skip paths inside the system
            temporary directory.  Old agentic-process runs leave orphaned
            ``flow-process-*`` temp dirs registered here; excluding them
            prevents their ``.claude/agents/`` contents from polluting
            agent discovery and the scan index.
    """
    projects_dir = _claude_projects_dir()
    if not projects_dir.is_dir():
        return

    from flow_sdk.fs_store.path_utils import is_valid_project_cwd  # noqa: PLC0415

    seen: set[Path] = set()
    for project_dir in sorted(projects_dir.iterdir()):
        if not project_dir.is_dir():
            continue

        real = decode_claude_project_dir(project_dir)
        if real is None:
            # Windows-only: encoded name lacked a drive letter — undecodable.
            continue

        if not is_valid_project_cwd(real, include_temp=include_temp):
            continue

        try:
            rp = real.resolve()
        except OSError:
            continue
        if rp in seen:
            continue
        try:
            if not real.is_dir():
                continue
        except OSError:
            continue
        seen.add(rp)
        yield real
