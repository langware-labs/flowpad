"""Indexer-backed project list for ComputeNode list-projects."""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flow_sdk.fs_records.claude.claude_project import ProjectFsRecord
from flow_sdk.fs_records.codex.codex_project import _read_codex_projects_from_config
from flow_sdk.fs_records._claude_projects import decode_claude_project_dir
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
from flow_sdk.fs_store.indexer.functions.codex_projects import codex_projects_fn
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.scope import Scope
from flow_sdk.instance_settings import get_instance_settings


PROJECT_RESOURCE_TYPE = "system_resource_claude_project"


def _project_indexer() -> FSIndexer:
    """Build the project-only slice of the canonical FS indexer."""
    idx = FSIndexer(roots=[
        FSRef(
            get_instance_settings().user_home,
            record_type=RecordType.USER_HOME_FOLDER,
            scope=Scope.USER.value,
        )
    ])
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_projects_fn)
    return idx


def _is_claude_project_ref(path: Path) -> bool:
    return ProjectFsRecord._is_claude_encoded_ref(path)


def _iso_from_mtime(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


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


def _project_id_for_cwd(cwd: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{canonical_posix_path(cwd)}"))


def _claude_session_stats(project_dir: Path) -> tuple[int, str | None]:
    session_files = list(project_dir.glob("*.jsonl"))
    if session_files:
        mtimes = []
        for path in session_files:
            try:
                mtimes.append(path.stat().st_mtime)
            except OSError:
                continue
        return len(session_files), _iso_from_mtime(max(mtimes) if mtimes else None)
    try:
        return 0, _iso_from_mtime(project_dir.stat().st_mtime)
    except OSError:
        return 0, None


def _codex_activity_by_cwd() -> dict[str, dict[str, Any]]:
    settings = get_instance_settings()
    codex_home = settings.user_home / ".codex"
    activity: dict[str, dict[str, Any]] = {}

    config_path = codex_home / "config.toml"
    config_mtime = None
    try:
        config_mtime = config_path.stat().st_mtime
    except OSError:
        pass
    for cwd in _read_codex_projects_from_config(config_path):
        canonical = canonical_posix_path(cwd)
        activity.setdefault(
            canonical,
            {
                "session_count": 0,
                "modified_at": _iso_from_mtime(config_mtime),
            },
        )

    sessions_root = settings.codex_sessions_dir
    if not sessions_root.is_dir():
        return activity

    for path in sessions_root.rglob("rollout-*.jsonl"):
        cwd = _read_codex_session_cwd(path)
        if not cwd:
            continue
        canonical = canonical_posix_path(cwd)
        item = activity.setdefault(
            canonical,
            {
                "session_count": 0,
                "modified_at": None,
            },
        )
        item["session_count"] = _int_field(item.get("session_count")) + 1
        try:
            modified_at = _iso_from_mtime(path.stat().st_mtime)
        except OSError:
            modified_at = None
        if modified_at and modified_at > (item.get("modified_at") or ""):
            item["modified_at"] = modified_at

    return activity


def _read_codex_session_cwd(path: Path) -> str | None:
    try:
        with open(path, "rb") as fh:
            head = fh.read(8192).decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in head.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            return None
        if raw.get("type") == "session_meta":
            payload = raw.get("payload") or {}
            cwd = payload.get("cwd")
            if isinstance(cwd, str) and ProjectFsRecord._is_valid_cwd(cwd):
                return cwd
            return None
    return None


def _merge_project(
    projects_by_cwd: dict[str, dict[str, Any]],
    cwd: str,
    *,
    claude: bool = False,
    codex: bool = False,
    encoded_name: str | None = None,
    session_count: int = 0,
    modified_at: str | None = None,
) -> None:
    item = projects_by_cwd.setdefault(
        cwd,
        {
            "id": _project_id_for_cwd(cwd),
            "type": PROJECT_RESOURCE_TYPE,
            "name": _display_name(cwd),
            "encoded_name": _encoded_name_for(cwd, encoded_name),
            "cwd": cwd,
            "session_count": 0,
            "claude_session_count": 0,
            "codex_session_count": 0,
            "modified_at": None,
            "scope": ["user"],
            "claude": False,
            "codex": False,
            "worker_types": [],
        },
    )
    if encoded_name:
        item["encoded_name"] = encoded_name
    if claude:
        item["claude"] = True
        item["claude_session_count"] = (
            _int_field(item.get("claude_session_count")) + session_count
        )
    if codex:
        item["codex"] = True
        item["codex_session_count"] = (
            _int_field(item.get("codex_session_count")) + session_count
        )
    item["session_count"] = (
        _int_field(item.get("claude_session_count"))
        + _int_field(item.get("codex_session_count"))
    )
    if modified_at and modified_at > (item.get("modified_at") or ""):
        item["modified_at"] = modified_at
    worker_types = []
    if item["claude"]:
        worker_types.append("claude")
    if item["codex"]:
        worker_types.append("codex")
    item["worker_types"] = worker_types


async def list_projects_from_indexer() -> dict[str, Any]:
    """Return one project row per canonical cwd.

    Single source of truth: ``get_all_projects()`` (Claude scan ∪ Codex scan ∪
    Project entity table, deduped + creates missing Project entities). This
    function then enriches each row with per-worker session counts read off
    disk — same shape the UI expected from the legacy implementation.
    """
    from flow_sdk.fs_records._claude_projects import _claude_projects_dir
    from flow_sdk.fs_records.all_projects import get_all_projects

    all_projects = await get_all_projects(create_missing=True)
    codex_activity = _codex_activity_by_cwd()
    claude_root = _claude_projects_dir()

    projects_by_cwd: dict[str, dict[str, Any]] = {}
    for info in all_projects:
        canonical = info.cwd
        if not ProjectFsRecord._is_valid_cwd(canonical):
            continue
        if "claude" in info.worker_types:
            encoded = canonical.replace("/", "-")
            session_count, modified_at = _claude_session_stats(claude_root / encoded)
            _merge_project(
                projects_by_cwd, canonical,
                claude=True, encoded_name=encoded,
                session_count=session_count, modified_at=modified_at,
            )
        if "codex" in info.worker_types:
            activity = codex_activity.get(canonical, {})
            _merge_project(
                projects_by_cwd, canonical,
                codex=True,
                session_count=_int_field(activity.get("session_count")),
                modified_at=activity.get("modified_at"),
            )
        if canonical not in projects_by_cwd:
            # Entity-only project (no Claude/Codex worker history yet)
            _merge_project(
                projects_by_cwd, canonical,
                modified_at=str(info.modified_at) if info.modified_at else None,
            )
        # Override id / name with the canonical entity values
        row = projects_by_cwd[canonical]
        row["id"] = info.project_id or row["id"]
        row["name"] = info.name or row["name"]

    projects = list(projects_by_cwd.values())
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
