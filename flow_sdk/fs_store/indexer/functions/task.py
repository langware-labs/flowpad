"""Indexer function: REAL_PROJECT_CWD -> TASK.

Emits one TASK FSRef per `<project>/tasks/<title>/manifest.json` found.
Scan stage enumerates paths only; the task id, title, status, and other
fields live inside the manifest and get extracted at the index (parse)
stage.

Mirrors `flow_sdk/fs_records/notification_scanner.py:30-54` — the same
walk that imports manifests into Task entities on startup.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


async def task_fn(
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
            manifest = task_dir / "manifest.json"
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
