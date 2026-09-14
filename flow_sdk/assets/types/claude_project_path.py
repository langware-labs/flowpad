"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_IS_WINDOWS = sys.platform == "win32"


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
