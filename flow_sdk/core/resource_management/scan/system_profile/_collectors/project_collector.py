"""Project collector - projects enumeration."""

import json
from pathlib import Path

from ..utils import (
    _claude_home,
    load_jsonl,
    shorten_path,
)


def get_project_cwd(project_dir: Path) -> str | None:
    """Extract real cwd from project session files.

    Fast path:
      1) Inspect only the newest few session files.
      2) Read only the first handful of lines from each file.
    """

    def _extract_cwd_from_file(jsonl_file: Path, max_lines: int = 20) -> str | None:
        try:
            with open(jsonl_file, "r", encoding="utf-8") as f:
                for _ in range(max_lines):
                    line = f.readline()
                    if not line:
                        break
                    try:
                        entry = json.loads(line)
                        if cwd := entry.get("cwd"):
                            return cwd
                    except json.JSONDecodeError:
                        continue
        except IOError:
            return None
        return None

    def _safe_mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    session_files = sorted(project_dir.glob("*.jsonl"), key=_safe_mtime, reverse=True)

    # Check the most recent files first (usually enough).
    for jsonl_file in session_files[:3]:
        if cwd := _extract_cwd_from_file(jsonl_file):
            return cwd

    # Fallback: scan the rest only if needed.
    for jsonl_file in session_files[3:]:
        if cwd := _extract_cwd_from_file(jsonl_file, max_lines=50):
            return cwd

    return None


def get_projects() -> list[dict]:
    """Get all projects."""
    projects = []
    projects_dir = _claude_home() / "projects"

    if not projects_dir.exists():
        return projects

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue

        cwd = get_project_cwd(project_dir) or project_dir.name
        session_files = list(project_dir.glob("*.jsonl"))
        session_count = len(session_files)

        latest_activity = None
        total_messages = 0

        for sf in session_files:
            entries = load_jsonl(sf, limit=5)
            for entry in entries:
                if ts := entry.get("timestamp"):
                    if not latest_activity or ts > latest_activity:
                        latest_activity = ts
                    break

        projects.append(
            {
                "id": f"project:{project_dir.name}",
                "type": "project",
                "name": shorten_path(cwd),
                "scope": "user",
                "source_file": str(project_dir),
                "path": str(project_dir),
                "modified_at": latest_activity,
                "encoded_name": project_dir.name,
                "cwd": cwd,
                "session_count": session_count,
                "total_messages": total_messages,
            }
        )

    projects.sort(key=lambda x: x["modified_at"] or "", reverse=True)
    return projects
