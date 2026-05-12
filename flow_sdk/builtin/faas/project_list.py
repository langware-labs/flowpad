"""Indexer-backed project list for ComputeNode list-projects."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from flow_sdk.fs_records.claude.claude_project import ProjectFsRecord
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions, default_roots
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
from flow_sdk.fs_store.indexer.functions.codex_projects import codex_projects_fn
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.fs_store.record_types import RecordType


PROJECT_RESOURCE_TYPE = "system_resource_claude_project"


def _project_indexer() -> FSIndexer:
    """Build the project-only slice of the canonical FS indexer."""
    roots = [
        root
        for root in default_roots()
        if root.record_type == RecordType.USER_HOME_FOLDER
    ]
    idx = FSIndexer(roots=roots)
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_projects_fn)
    return idx


def _is_claude_project_ref(path: Path) -> bool:
    return ProjectFsRecord._is_claude_encoded_ref(path)


def _display_name(cwd: str, record_name: str | None = None) -> str:
    name = record_name or ""
    if name and name != cwd:
        return name
    trimmed = cwd.rstrip("/")
    return os.path.basename(trimmed) or cwd


def _encoded_name_for(cwd: str, encoded_path: str | None) -> str:
    if encoded_path:
        return encoded_path
    return cwd.replace("/", "-") or cwd


def _int_field(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


async def list_projects_from_indexer() -> dict[str, Any]:
    """Return one project row per canonical cwd using FSIndexer project records.

    The returned provenance flags are derived from the current indexer scan,
    not from historical record state, so a project can accurately be Claude,
    Codex, both, or neither when merged with other project sources in the UI.
    """
    refs = await _project_indexer().scan(IndexerOptions(verbose=False))
    project_refs = [ref for ref in refs if ref.record_type == RecordType.PROJECT]

    projects_by_cwd: dict[str, dict[str, Any]] = {}
    records_by_cwd: dict[str, ProjectFsRecord] = {}

    for ref in project_refs:
        ref_path = Path(ref._path)
        is_claude = _is_claude_project_ref(ref_path)
        try:
            records = await ProjectFsRecord.from_fsref(ref)
        except Exception:
            logging.exception("Failed to index project ref %s", ref.path)
            continue
        for record in records:
            cwd = canonical_posix_path(record.cwd)
            if not cwd:
                continue
            records_by_cwd[cwd] = record
            item = projects_by_cwd.setdefault(
                cwd,
                {
                    "claude": False,
                    "codex": False,
                    "encoded_name": None,
                },
            )
            if is_claude:
                item["claude"] = True
                item["encoded_name"] = record.data.get("encoded_path") or ref_path.name
            else:
                item["codex"] = True

    projects: list[dict[str, Any]] = []
    for cwd, source_flags in projects_by_cwd.items():
        record = ProjectFsRecord.find_by_cwd(cwd) or records_by_cwd.get(cwd)
        data = record.data if record is not None else {}
        claude = bool(source_flags.get("claude"))
        codex = bool(source_flags.get("codex"))
        worker_types = []
        if claude:
            worker_types.append("claude")
        if codex:
            worker_types.append("codex")

        encoded_name = _encoded_name_for(
            cwd,
            source_flags.get("encoded_name") or data.get("encoded_path"),
        )
        modified_at = data.get("last_session_at") or data.get("last_indexed_at")
        session_count = _int_field(data.get("session_count"))

        projects.append(
            {
                "id": record.id if record is not None else f"project:{cwd}",
                "type": PROJECT_RESOURCE_TYPE,
                "name": _display_name(cwd, data.get("name")),
                "encoded_name": encoded_name,
                "cwd": cwd,
                "session_count": session_count,
                "modified_at": modified_at,
                "scope": ["user"],
                "claude": claude,
                "codex": codex,
                "worker_types": worker_types,
            }
        )

    projects.sort(key=lambda item: item.get("modified_at") or "", reverse=True)

    claude_count = sum(1 for item in projects if item["claude"])
    codex_count = sum(1 for item in projects if item["codex"])
    both_count = sum(1 for item in projects if item["claude"] and item["codex"])
    none_count = sum(1 for item in projects if not item["claude"] and not item["codex"])

    return {
        "projects": projects,
        "total_count": len(projects),
        "claude_count": claude_count,
        "codex_count": codex_count,
        "both_count": both_count,
        "none_count": none_count,
    }
