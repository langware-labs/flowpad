"""Extractor + id mint for TODO_FILE records.

``~/.claude/todos/*.json`` — flat per-session/agent todo files written by
Claude Code (distinct from project ``tasks/<title>/header.json`` handled by
``task.py``). Discovery is the type's declared ``walk``
(``todo_file_type_info.py``). Read-only. Replaces ``user_collector.get_todos``
(minus its O(projects) project-correlation loop).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


def todo_identity_key(ref: FSRef | Path) -> str:
    return f"{RecordType.TODO_FILE}:todo:{Path(getattr(ref, 'path', ref)).stem}"


def extract_todo(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse one todo file into a record matching the legacy item shape."""
    path = Path(ref.path)
    filename = path.stem
    if "-agent-" in filename:
        parts = filename.rsplit("-agent-", 1)
        session_id = parts[0]
        agent_id = parts[1] if len(parts) > 1 else session_id
        is_sub_agent = session_id != agent_id
    else:
        session_id = filename
        agent_id = filename
        is_sub_agent = False

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        stat = path.stat()
    except (json.JSONDecodeError, OSError):
        return []

    if isinstance(data, list):
        entries = data
    elif isinstance(data, dict) and "todos" in data:
        entries = data.get("todos", [])
    else:
        entries = []

    completed = sum(1 for e in entries if e.get("status") == "completed")
    pending = sum(1 for e in entries if e.get("status") == "pending")
    in_progress = sum(1 for e in entries if e.get("status") == "in_progress")

    rec = FSRecord(
        type=RecordType.TODO_FILE,
        id=resolved_id,
        name=filename,
        scope="user",
        source_file=str(path),
        path=str(path),
        modified_at=datetime.fromtimestamp(stat.st_mtime).isoformat(),
        created_at=datetime.fromtimestamp(stat.st_ctime).isoformat(),
        session_id=session_id,
        agent_id=agent_id,
        is_sub_agent=is_sub_agent,
        entry_count=len(entries),
        completed_count=completed,
        pending_count=pending,
        in_progress_count=in_progress,
        entries=[
            {
                "content": e.get("content", ""),
                "status": e.get("status", "pending"),
                "activeForm": e.get("activeForm", ""),
            }
            for e in entries
        ],
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True))
    return [rec]
