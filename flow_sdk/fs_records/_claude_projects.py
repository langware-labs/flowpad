"""Shared helper for resolving real filesystem paths of Claude-tracked projects.

Claude stores per-project data in ~/.claude/projects/<encoded>/ where <encoded>
is the project path with '/' replaced by '-'. This encoding is ambiguous for
paths containing hyphens (e.g. /Users/foo/my-app → -Users-foo-my-app, which
decodes incorrectly to /Users/foo/my/app).

The reliable fix: read the 'cwd' field from a session JSONL file inside the
project directory, which stores the original unencoded path.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Iterator


_IS_WINDOWS = sys.platform == "win32"


def _claude_projects_dir() -> Path:
    """Per-instance ~/.claude/projects (call-time, via InstanceSettings)."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().claude_projects_dir


def _invalid_project_roots() -> set[Path]:
    """Paths that MUST never be yielded as a "project" — walking them would
    enumerate the entire machine. Resolved per-call so test-mode isolation
    correctly excludes the sandbox user_home."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return {
        Path("/").resolve(),
        get_instance_settings().user_home.resolve(),
    }

# Match Windows encoded project names: starts with drive letter, e.g. "C-Users-<user-name>-project"
_WIN_ENCODED_RE = re.compile(r"^([A-Za-z])-(.*)")


def _real_path_from_jsonl(project_dir: Path) -> Path | None:
    """Return the real project path by reading 'cwd' from a session JSONL file.

    Only reads the first JSONL file found and at most the first 50 lines —
    cwd appears near the top of any active session file.
    """
    jsonl_files = sorted(project_dir.glob("*.jsonl"))
    if not jsonl_files:
        return None
    try:
        with jsonl_files[0].open(encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= 50:
                    break
                if '"cwd"' not in line:
                    continue
                try:
                    data = json.loads(line)
                    cwd = data.get("cwd")
                    if cwd and isinstance(cwd, str):
                        return Path(cwd)
                except (json.JSONDecodeError, ValueError):
                    continue
    except OSError:
        pass
    return None


def decode_claude_project_dir(project_dir: Path) -> Path | None:
    """Resolve the real filesystem path for a ``~/.claude/projects/<encoded>/`` dir.

    Reads ``cwd`` from a session JSONL file when available (authoritative),
    falling back to the ambiguous encoded-name decode otherwise. The fallback
    cannot recover the original because Claude's encoder collapses ``/``,
    ``-``, ``_``, ``.``, and `` `` all to ``-``. Returns ``None`` only on
    Windows when the encoded name lacks a recognizable drive letter.
    """
    real = _real_path_from_jsonl(project_dir)
    if real is not None:
        return real
    encoded = project_dir.name
    if _IS_WINDOWS:
        m = _WIN_ENCODED_RE.match(encoded)
        if not m:
            return None
        drive, rest = m.group(1), m.group(2)
        return Path(f"{drive}:\\" + rest.replace("-", "\\"))
    return Path("/" + encoded.lstrip("-").replace("-", "/"))


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

    from flow_sdk.utils.file_system import is_temp_path  # noqa: PLC0415

    invalid_roots = _invalid_project_roots()
    seen: set[Path] = set()
    for project_dir in sorted(projects_dir.iterdir()):
        if not project_dir.is_dir():
            continue

        real = decode_claude_project_dir(project_dir)
        if real is None:
            # Windows-only: encoded name lacked a drive letter — undecodable.
            continue

        if not include_temp and is_temp_path(real):
            continue

        try:
            rp = real.resolve()
        except OSError:
            continue
        if rp in invalid_roots:
            # Stale cwd pointing at / or $HOME — ignore, not a real project.
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
