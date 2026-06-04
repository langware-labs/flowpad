"""Indexer function: REAL_PROJECT_CWD -> TASK.

Emits one TASK FSRef per `<project>/tasks/<title>/manifest.json` (or
`header.json`) found at the scan stage. The task id, title, status, and other
fields live inside the manifest and get extracted at the index (parse) stage
via ``extract_task``.

Replaces the deleted ``TaskResource`` subclass.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flow_sdk._compat import StrEnum
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


# ---------------------------------------------------------------------------
# Domain enums (moved from flow_sdk/fs_records/task.py)
# ---------------------------------------------------------------------------


class TaskStatus(StrEnum):
    TO_DO = "to_do"
    IN_PROGRESS = "in_progress"
    DONE = "done"


class TaskType(StrEnum):
    TASK = "Task"
    ANALYSIS = "analysis"
    SKILL_CREATION = "skill_creation"


def task_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        tasks_dir = Path(node.path) / "tasks"
        if not tasks_dir.is_dir():
            continue
        for task_dir in sorted(tasks_dir.iterdir()):
            # Skip the "spec" sibling used for task specs (legacy convention).
            if not task_dir.is_dir() or task_dir.name == "spec":
                continue
            manifest = task_dir / "header.json"
            if not manifest.is_file():
                continue
            key = str(manifest.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(manifest, record_type=RecordType.TASK, parent=node)
            )
    return out


# ---------------------------------------------------------------------------
# Helpers (moved from TaskResource)
# ---------------------------------------------------------------------------


def _unwrap_task_envelope(data: Any) -> dict:
    """Some manifest.json files wrap the task fields under a ``data`` key
    (legacy/external format). Unwrap when present so callers see flat fields."""
    if isinstance(data, dict) and isinstance(data.get("data"), dict) and (
        "id" in data["data"] or "task_id" in data["data"]
    ):
        return data["data"]
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Id helpers
# ---------------------------------------------------------------------------


def task_gen_id(ref: FSRef) -> str:
    """Return the task id from manifest JSON.

    Id = ``task_id`` field inside the manifest.json (or ``id`` field as
    fallback). Falls back to the parent directory name when the manifest is
    unreadable.  This preserves the same formula that ``TaskResource.getId``
    used, so DB rows keyed by that value remain valid.
    """
    try:
        data = json.loads(ref._path.read_text(encoding="utf-8"))
        data = _unwrap_task_envelope(data)
        return str(data.get("task_id") or data.get("id") or ref._path.parent.name)
    except (json.JSONDecodeError, OSError):
        return ref._path.parent.name


# ---------------------------------------------------------------------------
# Extractor (replaces TaskResource._from_fsref_sync)
# ---------------------------------------------------------------------------


def extract_task(ref: FSRef) -> list:
    """Parse a task manifest.json into a Record.

    Replaces ``TaskResource._from_fsref_sync``.
    """
    from flow_sdk.fs_store.fs_record import FSRecord  # local import avoids circular

    manifest = ref._path
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    data = _unwrap_task_envelope(data)
    task_id = data.get("task_id") or data.get("id")
    if not task_id:
        return []
    name = data.get("title") or data.get("name") or manifest.parent.name
    status = data.get("status") or "to_do"
    kwargs: dict[str, Any] = {
        "type": RecordType.TASK,
        "id": task_id,
        "name": name,
        "status": status,
    }
    for key in ("description", "objective", "task_type"):
        if key in data:
            kwargs[key] = data[key]
    rec = FSRecord(**kwargs)
    rec.source_file = str(manifest)
    return [rec]
