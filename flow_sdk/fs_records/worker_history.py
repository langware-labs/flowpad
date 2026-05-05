"""Unified worker history surface for the "Recent Sessions" UI.

Per-worker providers (currently only ``get_claude_worker_history``) collect
sessions from each agent's native history source. ``get_worker_history``
merges, deduplicates, sorts and caps the combined list so the frontend can
render it from a single response.

Adding a new worker (e.g. codex) is a one-line addition to
``WORKER_HISTORY_PROVIDERS``.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

from pydantic import BaseModel

logger = logging.getLogger(__name__)


class WorkerType(str, Enum):
    CLAUDE = "claude"
    CODEX = "codex"


class WorkerHistoryEntry(BaseModel):
    worker_type: WorkerType
    worker_id: str
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    project_cwd: Optional[str] = None
    last_active_time: datetime
    name: Optional[str] = None
    git_branch: Optional[str] = None
    message_count: Optional[int] = None
    agentic_process_id: Optional[str] = None


WorkerHistoryProvider = Callable[[int], list[WorkerHistoryEntry]]


def _is_uuid_like(s: Optional[str]) -> bool:
    if not s:
        return False
    try:
        uuid.UUID(s)
        return True
    except (ValueError, AttributeError):
        return False


def _basename(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    name = Path(path.rstrip("/\\")).name
    return name or None


def _pick_name(
    *,
    custom_title: Optional[str],
    slug: Optional[str],
    last_user_message: Optional[str],
    display: Optional[str],
    session_id: str,
) -> Optional[str]:
    for cand in (custom_title, slug, last_user_message, display):
        if not cand:
            continue
        v = cand.strip()
        if not v or v == session_id or _is_uuid_like(v):
            continue
        return f"{v[:80]}…" if len(v) > 80 else v
    return None


def _project_id_from_encoded(encoded: Optional[str]) -> Optional[str]:
    """Mirror ``ClaudeProjectFsRecord._project_id`` so the two systems agree on ids."""
    if not encoded:
        return None
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{encoded}"))


def _coerce_datetime(value: object) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        ts = value / 1000 if value > 1e12 else value
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _build_agentic_process_index() -> dict[str, str]:
    """Map ``worker_session_id → agentic_process record id`` (single disk scan)."""
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord

    index: dict[str, str] = {}
    try:
        records = AgenticProcessRecord.discover()
    except Exception as e:
        logger.warning("[worker_history] discover agentic_process failed: %s", e)
        return index
    for rec in records:
        sid = rec.worker_session_id
        if sid and sid not in index:
            index[sid] = rec.id
    return index


def _build_history_latest_prompt_index() -> dict[str, str]:
    """Map ``session_id → most-recent display string`` from ``~/.claude/history.jsonl``.

    Used as a fallback for the display name when a session has no ``custom_title``,
    ``slug`` or ``last_user_message`` of its own.
    """
    from flow_sdk.fs_records.claude.claude_history_entry import ClaudeHistoryEntryFsRecord

    index: dict[str, str] = {}
    try:
        entries = ClaudeHistoryEntryFsRecord.discover()  # ascending by timestamp
    except Exception as e:
        logger.debug("[worker_history] history discover failed: %s", e)
        return index
    for entry in entries:
        sid = getattr(entry, "session_id", "") or ""
        if not sid:
            continue
        disp = getattr(entry, "display", "") or ""
        if disp:
            # Iterating ascending ⇒ later writes win ⇒ index ends with newest prompt per session.
            index[sid] = disp
    return index


def get_claude_worker_history(limit: int) -> list[WorkerHistoryEntry]:
    """Return the most-recent N Claude sessions, newest first.

    Sources sessions from on-disk transcripts (``~/.claude/projects/<enc>/<sid>.jsonl``)
    rather than from ``~/.claude/history.jsonl``. The history file only logs *user
    prompts*; sessions that were resumed/active today but whose latest prompt is older
    are missing from it. The transcript file's mtime is the canonical "last active"
    signal.
    """
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
    from flow_sdk.instance_settings import get_instance_settings

    projects_dir = get_instance_settings().claude_projects_dir
    if not projects_dir.is_dir():
        return []

    # Stat every JSONL, sort by mtime desc, keep the top ``over_fetch``.
    candidates: list[tuple[float, Path]] = []
    for proj_dir in projects_dir.iterdir():
        if not proj_dir.is_dir():
            continue
        for jsonl in proj_dir.glob("*.jsonl"):
            try:
                candidates.append((jsonl.stat().st_mtime, jsonl))
            except OSError:
                continue
    candidates.sort(key=lambda x: -x[0])
    # Each JSONL has a unique session_id, so no dedup loss — small +5 buffer for
    # the rare skip (parse failure / empty session_id).
    candidates = candidates[: limit + 5]

    process_index = _build_agentic_process_index()
    history_prompt_index = _build_history_latest_prompt_index()

    result: list[WorkerHistoryEntry] = []
    seen: set[str] = set()

    for mtime, jsonl_path in candidates:
        try:
            session = ClaudeSessionRecord.from_jsonl(jsonl_path)
        except Exception as e:
            logger.debug("[worker_history] from_jsonl failed for %s: %s", jsonl_path, e)
            continue

        sid = session.session_id
        if not sid or sid in seen:
            continue
        seen.add(sid)

        sd = object.__getattribute__(session, "__dict__")
        cwd = sd.get("cwd") or None
        slug = sd.get("slug") or None
        custom_title = sd.get("custom_title") or None
        project_encoded = sd.get("project_encoded_name") or jsonl_path.parent.name

        # ``git_branch``, ``message_count``, ``last_user_message`` are lazy
        # ``_SessionStatsProp`` fields. First access triggers a full JSONL parse
        # (~10–50ms per typical session); the result is cached on the record.
        git_branch: Optional[str] = None
        message_count: Optional[int] = None
        last_user_message: Optional[str] = None
        try:
            git_branch = session.git_branch or None
            message_count = session.message_count or None
            last_user_message = session.last_user_message
        except Exception as e:
            logger.debug("[worker_history] stats read failed for %s: %s", sid, e)

        name = _pick_name(
            custom_title=custom_title,
            slug=slug,
            last_user_message=last_user_message or history_prompt_index.get(sid),
            display=None,
            session_id=sid,
        )

        result.append(
            WorkerHistoryEntry(
                worker_type=WorkerType.CLAUDE,
                worker_id=sid,
                project_id=_project_id_from_encoded(project_encoded),
                project_name=_basename(cwd) or (project_encoded or None),
                project_cwd=cwd,
                last_active_time=datetime.fromtimestamp(mtime, tz=timezone.utc),
                name=name,
                git_branch=git_branch,
                message_count=message_count,
                agentic_process_id=process_index.get(sid),
            )
        )

    return result


def get_codex_worker_history(limit: int) -> list[WorkerHistoryEntry]:
    raise NotImplementedError("codex worker history not yet implemented")


WORKER_HISTORY_PROVIDERS: dict[WorkerType, WorkerHistoryProvider] = {
    WorkerType.CLAUDE: get_claude_worker_history,
    # WorkerType.CODEX: get_codex_worker_history,  # future
}


def _agentic_process_only_entries(
    seen: set[tuple[WorkerType, str]],
) -> list[WorkerHistoryEntry]:
    """Surface AgenticProcessRecords whose session is absent from any worker's history file."""
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord

    extra: list[WorkerHistoryEntry] = []
    try:
        records = AgenticProcessRecord.discover()
    except Exception as e:
        logger.warning("[worker_history] discover agentic_process: %s", e)
        return extra

    for rec in records:
        sid = rec.worker_session_id
        if not sid:
            continue
        # Per ts_sdk/src/process/agentic-process.ts:539, an unset worker_type
        # means claude — that's what AgenticProcess.spawn produces today.
        worker_type = WorkerType.CLAUDE
        key = (worker_type, sid)
        if key in seen:
            continue

        last_active = _coerce_datetime(getattr(rec, "updated_date", None)) or datetime.now(
            tz=timezone.utc
        )

        extra.append(
            WorkerHistoryEntry(
                worker_type=worker_type,
                worker_id=sid,
                project_id=rec.project_id or _project_id_from_encoded(rec.project_encoded_name),
                project_name=None,
                project_cwd=None,
                last_active_time=last_active,
                name=getattr(rec, "name", None) or None,
                git_branch=None,
                message_count=None,
                agentic_process_id=rec.id,
            )
        )

    return extra


def get_worker_history(limit: int = 10) -> list[WorkerHistoryEntry]:
    """Unified, deduplicated worker history across every registered provider."""
    collected: list[WorkerHistoryEntry] = []
    seen: set[tuple[WorkerType, str]] = set()

    for worker_type, provider in WORKER_HISTORY_PROVIDERS.items():
        try:
            entries = provider(limit)
        except NotImplementedError:
            continue
        except Exception as e:
            logger.warning("[worker_history] provider %s failed: %s", worker_type, e)
            continue
        for entry in entries:
            key = (entry.worker_type, entry.worker_id)
            if key in seen:
                continue
            seen.add(key)
            collected.append(entry)

    collected.extend(_agentic_process_only_entries(seen))
    collected.sort(key=lambda e: e.last_active_time, reverse=True)
    return collected[:limit]
