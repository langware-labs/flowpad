"""Indexer-backed project list for ComputeNode list-projects."""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer
from flow_sdk.fs_store.indexer.functions.claude_projects import (
    _is_claude_encoded_ref,
    claude_projects_fn,
)
from flow_sdk.fs_store.indexer.functions.codex_projects import (
    _read_codex_projects_from_config,
    codex_projects_fn,
)
from flow_sdk.fs_store.operations.project_cleanup import summarize
from flow_sdk.fs_store.path_utils import canonical_posix_path, is_valid_project_cwd
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.scope import Scope
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.utils.serialization import iso_to_datetime

PROJECT_RESOURCE_TYPE = "system_resource_claude_project"


def _project_indexer() -> FSIndexer:
    """Build the project-only slice of the canonical FS indexer."""
    idx = FSIndexer(
        roots=[
            FSRef(
                get_instance_settings().user_home,
                record_type=RecordType.USER_HOME_FOLDER,
                scope=Scope.USER.value,
            )
        ]
    )
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_projects_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, codex_projects_fn)
    return idx


def _is_claude_project_ref(path: Path) -> bool:
    return _is_claude_encoded_ref(path)


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


def _int_field(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _project_id_for_cwd(cwd: str) -> str:
    # Same key + namespace as ``Project.derive_id_for_path`` (project.py). Kept as
    # its own function because that one returns None for a non-project cwd,
    # which this caller does not want — the FORMULA is what must not drift.
    return mint_uuid(f"project:{canonical_posix_path(cwd)}", namespace=uuid.NAMESPACE_DNS)


def _index_claude_dirs_by_cwd(claude_root: Path, *, include_temp: bool = False) -> dict[str, Path]:
    """Build {canonical_cwd: claude_dir} by reading each child's JSONL once.

    Claude's encoded-dir name is lossy (``/`` / `` `` / ``_`` → ``-``), so going
    cwd → dir via path encoding fails for paths with spaces or underscores. The
    ground truth is each child's JSONL ``cwd`` field, which
    ``decode_claude_project_dir`` already exposes.
    """
    from flow_sdk.fs_store.indexer.functions._claude_projects import decode_claude_project_dir

    out: dict[str, Path] = {}
    if not claude_root.is_dir():
        return out
    for child in claude_root.iterdir():
        if not child.is_dir():
            continue
        real = decode_claude_project_dir(child)
        if real is None or not is_valid_project_cwd(real, include_temp=include_temp):
            continue
        try:
            out[str(real.resolve())] = child
        except OSError:
            continue
    return out


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


def _copilot_activity_by_cwd() -> dict[str, dict[str, Any]]:
    root = get_instance_settings().user_home / ".copilot" / "session-state"
    activity: dict[str, dict[str, Any]] = {}
    if not root.is_dir():
        return activity
    for workspace in root.glob("*/workspace.yaml"):
        cwd = _read_copilot_workspace_cwd(workspace)
        if not cwd or not is_valid_project_cwd(cwd):
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
        event_path = workspace.parent / "events.jsonl"
        stat_path = event_path if event_path.exists() else workspace
        try:
            modified_at = _iso_from_mtime(stat_path.stat().st_mtime)
        except OSError:
            modified_at = None
        if modified_at and modified_at > (item.get("modified_at") or ""):
            item["modified_at"] = modified_at
    return activity


def _read_copilot_workspace_cwd(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("cwd:"):
            continue
        value = stripped.split(":", 1)[1].strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        return value or None
    return None


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
            if isinstance(cwd, str) and is_valid_project_cwd(cwd):
                return cwd
            return None
    return None


def _merge_project(
    projects_by_cwd: dict[str, dict[str, Any]],
    cwd: str,
    *,
    claude: bool = False,
    codex: bool = False,
    copilot: bool = False,
    claude_dir_name: str | None = None,
    session_count: int = 0,
    modified_at: str | None = None,
) -> None:
    item = projects_by_cwd.setdefault(
        cwd,
        {
            "id": _project_id_for_cwd(cwd),
            "record_project_id": _project_id_for_cwd(cwd),
            "type": PROJECT_RESOURCE_TYPE,
            "name": _display_name(cwd),
            "cwd": cwd,
            # `encoded_name` is a unique-per-project opaque id used by UI
            # selectors / React keys / activity-map lookups. When Claude has
            # walked this cwd we use the OBSERVED on-disk dir name from
            # ~/.claude/projects/<name>/ (matches Claude's actual encoding,
            # including spaces/underscores); otherwise we fall back to a
            # lossy synthetic derived from cwd so every row still has a
            # distinct, stable value (cwds are unique per project). The
            # synthetic isn't a valid Claude dir name — clients must NOT use
            # it to locate transcripts; that path goes through
            # ClaudeSessionRecord.discover() / _index_claude_dirs_by_cwd.
            "encoded_name": claude_dir_name or cwd.replace("/", "-"),
            "session_count": 0,
            "claude_session_count": 0,
            "codex_session_count": 0,
            "copilot_session_count": 0,
            "modified_at": None,
            "last_active_at": None,
            "scope": ["user"],
            "claude": False,
            "codex": False,
            "copilot": False,
            "worker_types": [],
        },
    )
    if claude_dir_name and item.get("encoded_name") != claude_dir_name:
        # Upgrade synthetic fallback to the observed Claude dir name once
        # we discover it (e.g. codex merge happened first, claude second).
        item["encoded_name"] = claude_dir_name
    if claude:
        item["claude"] = True
        item["claude_session_count"] = _int_field(item.get("claude_session_count")) + session_count
    if codex:
        item["codex"] = True
        item["codex_session_count"] = _int_field(item.get("codex_session_count")) + session_count
    if copilot:
        item["copilot"] = True
        item["copilot_session_count"] = _int_field(item.get("copilot_session_count")) + session_count
    item["session_count"] = (
        _int_field(item.get("claude_session_count"))
        + _int_field(item.get("codex_session_count"))
        + _int_field(item.get("copilot_session_count"))
    )
    if modified_at and modified_at > (item.get("modified_at") or ""):
        item["modified_at"] = modified_at
    worker_types = []
    if item["claude"]:
        worker_types.append("claude")
    if item["codex"]:
        worker_types.append("codex")
    if item["copilot"]:
        worker_types.append("copilot")
    item["worker_types"] = worker_types


def _recency_ms(item: dict[str, Any]) -> float:
    """Unified recency for the project sort: ``last_active_at`` (epoch-ms,
    stamped when the user opens the project or one of its assets) wins;
    ``modified_at`` (ISO, session-file mtimes) is the fallback timescale."""
    last_active = item.get("last_active_at")
    if last_active:
        return float(last_active)
    iso = item.get("modified_at")
    if iso:
        try:
            return iso_to_datetime(str(iso)).timestamp() * 1000
        except ValueError:
            pass
    return 0.0


async def list_projects_from_indexer() -> dict[str, Any]:
    """Return one project row per canonical cwd.

    Single source of truth: ``get_all_projects()`` (Claude scan ∪ Codex scan ∪
    Project entity table, deduped). Listing is deliberately read-only: a picker
    may discover hundreds of historical worker cwds, but only the path the user
    selects is materialized by ``useEnsureProject``. This function then enriches
    each row with per-worker session counts read off disk — same shape the UI
    expected from the legacy implementation.
    """
    from flow_sdk.fs_store.indexer.functions._claude_projects import _claude_projects_dir
    from flow_sdk.fs_store.operations.all_projects import get_all_projects

    all_projects = await get_all_projects(create_missing=False)
    codex_activity = _codex_activity_by_cwd()
    copilot_activity = _copilot_activity_by_cwd()
    # One pass over claude_root → cwd lookup; otherwise the per-project search
    # below would re-scan and re-decode every JSONL N times (lossy encoder
    # forces JSONL inspection).
    claude_dirs = _index_claude_dirs_by_cwd(_claude_projects_dir())

    projects_by_cwd: dict[str, dict[str, Any]] = {}
    for info in all_projects:
        canonical = info.cwd
        if not is_valid_project_cwd(canonical):
            continue
        if "claude" in info.worker_types:
            claude_dir = claude_dirs.get(str(Path(canonical).resolve()))
            if claude_dir is not None:
                session_count, modified_at = _claude_session_stats(claude_dir)
                _merge_project(
                    projects_by_cwd,
                    canonical,
                    claude=True,
                    claude_dir_name=claude_dir.name,
                    session_count=session_count,
                    modified_at=modified_at,
                )
            else:
                _merge_project(projects_by_cwd, canonical, claude=True)
        if "codex" in info.worker_types:
            activity = codex_activity.get(canonical, {})
            _merge_project(
                projects_by_cwd,
                canonical,
                codex=True,
                session_count=_int_field(activity.get("session_count")),
                modified_at=activity.get("modified_at"),
            )
        if "copilot" in info.worker_types or canonical in copilot_activity:
            activity = copilot_activity.get(canonical, {})
            _merge_project(
                projects_by_cwd,
                canonical,
                copilot=True,
                session_count=_int_field(activity.get("session_count")),
                modified_at=activity.get("modified_at"),
            )
        if canonical not in projects_by_cwd:
            # Entity-only project (no Claude/Codex worker history yet)
            _merge_project(
                projects_by_cwd,
                canonical,
                modified_at=str(info.modified_at) if info.modified_at else None,
            )
        # Override id / name with the canonical entity values. Keep the legacy
        # record_project_id separate for rows already stamped with uuid5(cwd).
        row = projects_by_cwd[canonical]
        row["id"] = info.project_id or row["id"]
        row["record_project_id"] = info.record_project_id or row.get("record_project_id")
        row["name"] = info.name or row["name"]
        # UI-open recency from the Project entity (stamped by the generic
        # ``activate`` action on project/asset open). Wins the recency sort
        # below; ``modified_at`` (session-file mtimes) is the fallback.
        row["last_active_at"] = info.last_active_at
        # Declared by `ProjectListItem.system`; the picker's `includeSystem:false`
        # filter compares against it, so an absent key silently disables it.
        row["system"] = info.system

    projects = list(projects_by_cwd.values())
    projects.sort(key=_recency_ms, reverse=True)

    claude_count = sum(1 for item in projects if item["claude"])
    codex_count = sum(1 for item in projects if item["codex"])
    copilot_count = sum(1 for item in projects if item["copilot"])
    both_count = sum(1 for item in projects if len(item["worker_types"]) > 1)
    none_count = sum(1 for item in projects if not item["worker_types"])

    return {
        "projects": projects,
        "total_count": len(projects),
        "claude_count": claude_count,
        "codex_count": codex_count,
        "copilot_count": copilot_count,
        "both_count": both_count,
        "none_count": none_count,
        # Cleanup candidates, counted here so the footer warning costs no second
        # call. Shallow signals only — one `listdir` per project, ~0.1s over
        # 1,250 rows. The per-project detail (file counts, git, harness state)
        # belongs to `project-cleanup-report`, which the user opens deliberately.
        "cleanup": summarize(projects).model_dump(),
    }
