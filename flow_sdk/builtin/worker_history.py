"""Unified worker history surface for the "Recent Sessions" UI.

Per-worker providers collect sessions from each
agent's native history source. ``get_worker_history`` merges, deduplicates,
sorts and caps the combined list so the frontend can render it from a single
response.

The ``agentic_process_id`` baked onto each row is sourced from the live
``AgenticProcess`` entity store (not the on-disk fs record). That guarantees
the id resolves via ``AgenticProcess.getById`` on the client — no split-brain
between the list endpoint and the click-time entity fetch.

Adding a new worker is a one-line addition to ``WORKER_HISTORY_PROVIDERS``.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)


# Claude/codex/copilot all append bookkeeping lines on resume/attach
# (``mode`` / ``permission-mode`` for Claude; ``token_count`` / ``shutdown``
# for the others). Those lines bump the file mtime without representing real
# user activity, so a session untouched for days reads as "just now" if the row
# uses mtime. Derive "last active" from the last line that actually carries a
# content ``timestamp`` instead. Tail-only read keeps this cheap across the
# whole candidate slice; the mtime fallback covers the rare case where the
# final message is larger than the tail window (mtime is the best signal then).
_LAST_TS_TAIL_BYTES = 65536


def _last_content_timestamp(path: Path, mtime: float) -> datetime:
    """Last in-content ``timestamp`` for a worker JSONL, falling back to mtime."""
    import json  # noqa: PLC0415

    try:
        with open(path, "rb") as fh:
            size = fh.seek(0, 2)  # seek to end → file size, no extra stat()
            if size > _LAST_TS_TAIL_BYTES:
                fh.seek(-_LAST_TS_TAIL_BYTES, 2)
                chunk = fh.read()
                # First line is likely truncated mid-JSON; drop it.
                chunk = chunk.split(b"\n", 1)[1] if b"\n" in chunk else b""
            else:
                fh.seek(0)
                chunk = fh.read()
        for line in reversed(chunk.split(b"\n")):
            line = line.strip()
            if not line or b"timestamp" not in line:
                continue
            try:
                raw = json.loads(line)
            except Exception:
                continue
            dt = _coerce_datetime(raw.get("timestamp"))
            if dt:
                return dt
    except OSError:
        pass
    return datetime.fromtimestamp(mtime, tz=timezone.utc)


class WorkerType(str, Enum):
    CLAUDE = "claude"
    CODEX = "codex"
    COPILOT = "copilot"


class WorkerHistoryEntry(BaseModel):
    worker_type: WorkerType
    worker_id: str
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    project_cwd: Optional[str] = None
    last_active_time: datetime
    name: Optional[str] = None
    last_prompt: Optional[str] = None
    git_branch: Optional[str] = None
    message_count: Optional[int] = None
    agentic_process_id: Optional[str] = None
    # Epoch-ms open-recency stamp of the backing AgenticProcess entity (the
    # generic ``activate`` action fired on every open). ``last_active_time`` is
    # transcript CONTENT recency only; clients that sort by "last active OR
    # last opened" take max(last_active_time, last_active_at).
    last_active_at: Optional[int] = None


ProcessIndex = dict[str, tuple[str, Optional[str], Optional[int]]]
# A provider may be asked to restrict its disk walk to a set of project_ids
# (the active scope). ``None`` means "no scope" → the legacy global top-N walk.
ScopeProjectIds = Optional[set[str]]
WorkerHistoryProvider = Callable[
    [int, ProcessIndex, ScopeProjectIds, Optional[dict[str, str]]],
    Awaitable[list[WorkerHistoryEntry]],
]


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


# Encoded-name prefixes for cwd paths that produce throwaway sessions: pytest
# tmpdirs, file-op-e2e fixtures, flow-cli scratch sessions. They flood the
# top-N-by-mtime slice during a QA cycle and crowd out real user work.
_SCRATCH_ENCODED_PREFIXES: tuple[str, ...] = (
    "-private-var-folders-",
    "-var-folders-",
    "-private-tmp-",
    "-tmp-",
    "-history-merge-test-",  # ui/tests/long_tests/history_merge.test.ts fixtures
    f"-Users-{Path.home().name}--flow-sessions-",
    f"-Users-{Path.home().name}--flow-dev-records-workflow-",
)

# Same set keyed by absolute path — applied to codex sessions whose dir layout
# is date-sharded, so we only know the cwd after parsing the rollout envelope.
_SCRATCH_CWD_PREFIXES: tuple[str, ...] = (
    "/private/var/folders/",
    "/var/folders/",
    "/private/tmp/",
    "/tmp/",
    f"{Path.home()}/.flow/sessions/",
    f"{Path.home()}/.flow/dev/records/workflow/",
)


def _is_scratch_encoded_dir(encoded_name: str) -> bool:
    return any(encoded_name.startswith(p) for p in _SCRATCH_ENCODED_PREFIXES)


def _is_scratch_cwd(cwd: Optional[str]) -> bool:
    if not cwd:
        return False
    return any(cwd.startswith(p) for p in _SCRATCH_CWD_PREFIXES)


def _pick_name(
    *,
    custom_title: Optional[str],
    slug: Optional[str],
    display: Optional[str],
    session_id: str,
) -> Optional[str]:
    """A real session title — never the last user prompt.

    The prompt is returned separately via ``_pick_last_prompt`` so the UI can
    render name + prompt as distinct lines.
    """
    for cand in (custom_title, slug, display):
        if not cand:
            continue
        v = cand.strip()
        if not v or v == session_id or _is_uuid_like(v):
            continue
        return f"{v[:80]}…" if len(v) > 80 else v
    return None


def _pick_last_prompt(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    return f"{v[:120]}…" if len(v) > 120 else v


async def _cwd_to_project_id() -> dict[str, str]:
    """Canonical project cwd → Project **entity** id.

    Lets history entries carry the real entity id (not the path-derived alias),
    so they match the entity ids clients send and the per-project cap buckets by
    one key per project. Best-effort; a cwd with no Project entity is absent.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    out: dict[str, str] = {}
    for proj in await Project.get_all():
        mount = getattr(proj, "fs_storage_mount_path", None)
        if mount:
            out[canonical_posix_path(mount)] = proj.id
    return out


def _project_id_for(
    cwd: Optional[str],
    encoded: Optional[str],
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> Optional[str]:
    """The owning project's entity id for a session cwd.

    When ``cwd_to_pid`` (canonical cwd → entity id) resolves the cwd, returns the
    real Project **entity** id — so entries match the ids clients send and bucket
    by one key per project. Falls back to the path-derived record **alias**
    (``uuid5(DNS, "project:"+cwd)`` == ``Project.derive_id_for_path``) when no
    Project entity exists for the cwd, and to the encoded form when there's no cwd.
    """
    if cwd:
        if cwd_to_pid:
            from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
            rid = cwd_to_pid.get(canonical_posix_path(cwd))
            if rid:
                return rid
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{cwd}"))
    if encoded:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{encoded}"))
    return None


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


def _normalize_worker_type(wt: object) -> WorkerType:
    """Map AgenticProcess.worker_type (flowpad_types enum) → local WorkerType.

    The entity's enum carries ``claude_code``/``unsecured_claude``/``codex``
    etc.; the UI surface distinguishes claude/codex/copilot. None defaults
    to claude — matches ``AgenticProcess.spawn``'s legacy default.
    """
    if wt is None:
        return WorkerType.CLAUDE
    val = (wt.value if hasattr(wt, "value") else str(wt)).lower()
    if "codex" in val:
        return WorkerType.CODEX
    if "copilot" in val:
        return WorkerType.COPILOT
    return WorkerType.CLAUDE


def _build_agentic_process_index(processes: list["AgenticProcess"]) -> ProcessIndex:
    """Map ``session_id → (agentic_process_id, name, last_active_at)`` from
    live entity rows.

    Whatever ends up in this index is openable via ``AgenticProcess.getById``
    on the client — by construction, since we sourced it from the same store.
    ``last_active_at`` (epoch-ms, the ``activate`` open stamp) rides along so
    worker-history rows can expose open-recency next to transcript recency.
    """
    index: ProcessIndex = {}
    for proc in processes:
        sid = proc.session_id
        if not sid or sid in index:
            continue
        raw_name = getattr(proc, "name", None)
        name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else None
        last_active_at = getattr(proc, "last_active_at", None)
        index[sid] = (proc.id, name, last_active_at if isinstance(last_active_at, int) else None)
    return index


def _build_history_latest_prompt_index() -> dict[str, str]:
    """Map ``session_id → most-recent display string`` from ``~/.claude/history.jsonl``.

    Used as a fallback for the display name when a session has no ``custom_title``,
    ``slug`` or ``last_user_message`` of its own.
    """
    # Read ~/.claude/history.jsonl directly. The ClaudeHistoryEntryFsRecord
    # subclass was deleted; this inline reader replaces its .discover().
    import json
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    index: dict[str, str] = {}
    try:
        history_path = get_instance_settings().claude_history_path
    except Exception as e:
        logger.debug("[worker_history] cannot resolve claude_history_path: %s", e)
        return index
    if not history_path.is_file():
        return index
    try:
        with open(history_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                sid = raw.get("sessionId", "") or ""
                disp = raw.get("display", "") or ""
                if sid and disp:
                    index[sid] = disp  # newest wins (ascending iteration)
    except OSError as e:
        logger.debug("[worker_history] history read failed: %s", e)
    return index


def _claude_dir_cwd(path: Path) -> Optional[str]:
    """The ``cwd`` recorded in a Claude session's envelope head — cheap (no
    content parse). All sessions in a ``~/.claude/projects/<enc>/`` directory
    share one cwd, so one peek maps the whole directory to a project_id."""
    from flow_sdk.fs_store.indexer.functions.claude_sessions import (
        extract_claude_session_from_path,
    )

    try:
        s = extract_claude_session_from_path(path, include_content=False)
        return object.__getattribute__(s, "__dict__").get("cwd") or None
    except Exception:  # noqa: BLE001
        return None


def _open_history_cache():
    """Instance-scoped :class:`WorkerSessionStatsCache`, or None if settings are
    unavailable — collectors then run fully uncached. Never raises."""
    try:
        from flow_sdk.builtin.worker_history_cache import WorkerSessionStatsCache  # noqa: PLC0415
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        return WorkerSessionStatsCache(get_instance_settings().worker_history_cache_path)
    except Exception as e:  # noqa: BLE001 — cache is best-effort by contract
        logger.debug("[worker_history] cache unavailable: %s", e)
        return None


# Candidate tuples carry the full stat snapshot: (mtime, path, mtime_ns, size).
# mtime keeps the existing sort/fallback semantics; (mtime_ns, size) are the
# cache validators — a payload is served only while the file is byte-identical
# to when it was parsed.
_Candidate = tuple[float, Path, int, int]


def _cache_lookup(cache, candidates: list[_Candidate]) -> dict[str, dict]:
    """Batched cache read for a finalized candidate slice. ``{}`` when uncached."""
    if cache is None or not candidates:
        return {}
    return cache.get_many([(str(p), mns, sz) for _, p, mns, sz in candidates])


def _cache_store(cache, pending: list[tuple[str, int, int, str, dict]]) -> None:
    if cache is not None and pending:
        cache.put_many(pending)


def _payload_last_active(payload: dict, mtime: float) -> datetime:
    return _coerce_datetime(payload.get("last_content_ts")) or datetime.fromtimestamp(
        mtime, tz=timezone.utc
    )


def _collect_claude_entries_sync(
    limit: int, process_index: ProcessIndex, project_ids: ScopeProjectIds = None,
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> list[WorkerHistoryEntry]:
    """Blocking body of ``get_claude_worker_history``. Runs under ``to_thread``."""
    from flow_sdk.fs_store.indexer.functions.claude_sessions import extract_claude_session_from_path
    from flow_sdk.instance_settings import get_instance_settings

    projects_dir = get_instance_settings().claude_projects_dir
    if not projects_dir.is_dir():
        return []

    scoped = project_ids is not None

    # Stat every JSONL, sort by mtime desc, keep the top ``over_fetch``.
    # Skip scratch encoded dirs (tmp/var-folders/flow-sessions) at walk time so
    # transient test sessions don't crowd real user work out of the slice.
    #
    # When a scope is given we must NOT apply a global mtime truncation — that
    # is exactly what hid an under-active project's sessions behind busier ones.
    # Claude groups every project's sessions in one directory, so we resolve
    # each directory to its project_id (one envelope-head peek per dir) and keep
    # only the matching directories, then take that project's most-recent
    # ``limit`` files. Cost stays bounded: we never parse non-matching dirs.
    candidates: list[_Candidate] = []
    for proj_dir in projects_dir.iterdir():
        if not proj_dir.is_dir() or _is_scratch_encoded_dir(proj_dir.name):
            continue
        dir_files: list[_Candidate] = []
        for jsonl in proj_dir.glob("*.jsonl"):
            try:
                st = jsonl.stat()
                dir_files.append((st.st_mtime, jsonl, st.st_mtime_ns, st.st_size))
            except OSError:
                continue
        if not dir_files:
            continue
        if scoped:
            newest = max(dir_files, key=lambda x: x[0])[1]
            pid = _project_id_for(_claude_dir_cwd(newest), proj_dir.name, cwd_to_pid)
            if pid not in project_ids:
                continue
            # Per-scope cap: only the newest ``limit`` files of a matched dir can
            # survive the cap downstream — parsing more would be wasted work.
            dir_files.sort(key=lambda x: -x[0])
            dir_files = dir_files[:limit]
        candidates.extend(dir_files)
    candidates.sort(key=lambda x: -x[0])
    if not scoped:
        # Each JSONL has a unique session_id, so no dedup loss. Over-fetch
        # generously so the top-N has room for project-scoped filtering on the
        # client and for sessions whose envelope parse rejects them below.
        candidates = candidates[: max(limit + 5, limit * 4 + 50)]

    history_prompt_index = _build_history_latest_prompt_index()

    result: list[WorkerHistoryEntry] = []
    seen: set[str] = set()

    from flow_sdk.fs_store.indexer.functions.claude_sessions import ensure_claude_session_stats  # noqa: PLC0415

    cache = _open_history_cache()
    cached = _cache_lookup(cache, candidates)
    pending: list[tuple[str, int, int, str, dict]] = []

    for mtime, jsonl_path, mtime_ns, size in candidates:
        payload = cached.get(str(jsonl_path))
        if payload is None:
            try:
                # include_content=False: worker-history reads only envelope + lazy
                # stats and never touches `session.content`, so skip the full
                # per-file transcript parse (worker_summary_log) that otherwise
                # dominates this endpoint's latency across all candidates.
                session = extract_claude_session_from_path(jsonl_path, include_content=False)
                ensure_claude_session_stats(session)  # populate message_count, last_user_message, git_branch, etc.
            except Exception as e:
                logger.debug("[worker_history] from_jsonl failed for %s: %s", jsonl_path, e)
                continue
            sd = object.__getattribute__(session, "__dict__")
            payload = {
                "session_id": session.session_id,
                "cwd": sd.get("cwd") or None,
                "project_encoded_name": sd.get("project_encoded_name") or None,
                "slug": session.slug or None,
                "custom_title": sd.get("custom_title") or None,
                "git_branch": sd.get("git_branch") or None,
                "message_count": sd.get("message_count") or None,
                "last_user_message": sd.get("last_user_message"),
                "last_content_ts": _last_content_timestamp(jsonl_path, mtime).isoformat(),
            }
            # Cached even when the filters below reject the row — the next
            # request then rejects it from the payload instead of re-parsing.
            pending.append((str(jsonl_path), mtime_ns, size, "claude", payload))

        sid = payload.get("session_id")
        if not sid or sid in seen:
            continue
        seen.add(sid)

        cwd = payload.get("cwd") or None
        if _is_scratch_cwd(cwd):
            # Belt-and-suspenders for sessions whose encoded dir name slipped
            # past the scratch prefix check (e.g. unusual path encodings).
            # Re-checked on cache hits too, so filter changes apply without
            # cache invalidation.
            continue
        project_encoded = payload.get("project_encoded_name") or jsonl_path.parent.name

        git_branch: Optional[str] = payload.get("git_branch") or None
        message_count: Optional[int] = payload.get("message_count") or None
        last_user_message: Optional[str] = payload.get("last_user_message")

        # Name priority: AgenticProcess.name (user/upsert-set) > Claude's
        # ``custom_title`` (set by ``/rename`` or Claude's own auto-summary,
        # written as ``{"type":"custom-title"}`` lines) > ``slug`` (first-line
        # envelope, auto-generated from the opening prompt). Without these
        # fallbacks the row would be unnamed for any session that was never
        # opened through Flowpad — that's the majority of on-disk Claude
        # sessions. ``_pick_name`` filters out session_id / UUID-like values,
        # so a trivial session still falls through to ``last_prompt`` rendering.
        ap_id, ap_name, ap_last_active_at = process_index.get(sid, (None, None, None))
        name = _pick_name(
            custom_title=ap_name,
            slug=payload.get("custom_title") or None,
            display=payload.get("slug") or None,
            session_id=sid,
        )
        last_prompt = _pick_last_prompt(
            last_user_message or history_prompt_index.get(sid),
        )

        result.append(
            WorkerHistoryEntry(
                worker_type=WorkerType.CLAUDE,
                worker_id=sid,
                project_id=_project_id_for(cwd, project_encoded, cwd_to_pid),
                project_name=_basename(cwd) or (project_encoded or None),
                project_cwd=cwd,
                last_active_time=_payload_last_active(payload, mtime),
                name=name,
                last_prompt=last_prompt,
                git_branch=git_branch,
                message_count=message_count,
                agentic_process_id=ap_id,
                last_active_at=ap_last_active_at,
            )
        )

    _cache_store(cache, pending)
    return result


def _collect_codex_entries_sync(
    limit: int, process_index: ProcessIndex, project_ids: ScopeProjectIds = None,
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> list[WorkerHistoryEntry]:
    """Blocking body of ``get_codex_worker_history``. Runs under ``to_thread``."""
    from flow_sdk.fs_store.indexer.functions.codex_sessions import extract_codex_session_from_path
    from flow_sdk.instance_settings import get_instance_settings

    sessions_root = get_instance_settings().codex_sessions_dir
    if not sessions_root.is_dir():
        return []

    scoped = project_ids is not None

    candidates: list[_Candidate] = []
    for jsonl in sessions_root.rglob("rollout-*.jsonl"):
        try:
            st = jsonl.stat()
            candidates.append((st.st_mtime, jsonl, st.st_mtime_ns, st.st_size))
        except OSError:
            continue
    candidates.sort(key=lambda x: -x[0])
    if not scoped:
        # Same generous over-fetch as Claude; scratch filter is applied post-parse
        # because codex rollouts live in date-sharded dirs (cwd known only after
        # reading the envelope). When scoped we parse every candidate and filter
        # by project_id below so an under-active project isn't truncated away.
        candidates = candidates[: max(limit + 5, limit * 4 + 50)]

    result: list[WorkerHistoryEntry] = []
    seen: set[str] = set()
    # When scoped, candidates are mtime-desc and the result is capped at ``limit``
    # per project downstream — so stop parsing once every in-scope project has its
    # newest ``limit`` rows, instead of parsing every date-sharded rollout file.
    scope_counts: dict[str, int] = {}

    from flow_sdk.fs_store.indexer.functions.codex_sessions import ensure_codex_session_stats  # noqa: PLC0415

    cache = _open_history_cache()
    cached = _cache_lookup(cache, candidates)
    pending: list[tuple[str, int, int, str, dict]] = []

    for mtime, jsonl_path, mtime_ns, size in candidates:
        if scoped and all(scope_counts.get(p, 0) >= limit for p in project_ids):
            break
        payload = cached.get(str(jsonl_path))
        if payload is None:
            try:
                # include_content=False: see the Claude branch above — worker-history
                # never reads `session.content`, so skip the full-transcript parse.
                session = extract_codex_session_from_path(jsonl_path, include_content=False)
                ensure_codex_session_stats(session)  # populate message_count, last_user_message, etc.
            except Exception as e:
                logger.debug("[worker_history] codex from_jsonl failed for %s: %s", jsonl_path, e)
                continue
            sd = object.__getattribute__(session, "__dict__")
            payload = {
                "session_id": session.session_id,
                "cwd": sd.get("cwd") or None,
                "message_count": sd.get("message_count") or None,
                "last_user_message": sd.get("last_user_message"),
                "last_content_ts": _last_content_timestamp(jsonl_path, mtime).isoformat(),
            }
            pending.append((str(jsonl_path), mtime_ns, size, "codex", payload))

        sid = payload.get("session_id")
        if not sid or sid in seen:
            continue
        seen.add(sid)

        cwd = payload.get("cwd") or None
        if _is_scratch_cwd(cwd):
            continue
        pid = _project_id_for(cwd, None, cwd_to_pid)
        if scoped and pid not in project_ids:
            continue
        if scoped:
            scope_counts[pid] = scope_counts.get(pid, 0) + 1

        mc = payload.get("message_count") or 0
        message_count: Optional[int] = mc if mc > 0 else None
        last_user_message: Optional[str] = payload.get("last_user_message")

        # Codex sessions never carry their own title — name comes from the
        # AgenticProcess entity if one exists for this session, else None.
        last_prompt = _pick_last_prompt(last_user_message)
        ap_id, ap_name, ap_last_active_at = process_index.get(sid, (None, None, None))

        result.append(
            WorkerHistoryEntry(
                worker_type=WorkerType.CODEX,
                worker_id=sid,
                project_id=pid,
                project_name=_basename(cwd),
                project_cwd=cwd,
                last_active_time=_payload_last_active(payload, mtime),
                name=ap_name,
                last_prompt=last_prompt,
                git_branch=None,
                message_count=message_count,
                agentic_process_id=ap_id,
                last_active_at=ap_last_active_at,
            )
        )

    _cache_store(cache, pending)
    return result


def _collect_copilot_entries_sync(
    limit: int, process_index: ProcessIndex, project_ids: ScopeProjectIds = None,
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> list[WorkerHistoryEntry]:
    """Blocking body of ``get_copilot_worker_history``. Runs under ``to_thread``."""
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
        copilot_session_state_root,
        read_copilot_session_meta,
    )

    root = copilot_session_state_root()
    if not root.is_dir():
        return []

    scoped = project_ids is not None

    candidates: list[_Candidate] = []
    for jsonl in root.glob("*/events.jsonl"):
        try:
            st = jsonl.stat()
            candidates.append((st.st_mtime, jsonl, st.st_mtime_ns, st.st_size))
        except OSError:
            continue
    candidates.sort(key=lambda x: -x[0])
    if not scoped:
        candidates = candidates[: max(limit + 5, limit * 4 + 50)]

    result: list[WorkerHistoryEntry] = []
    seen: set[str] = set()
    # See the codex collector: when scoped, stop once each in-scope project has
    # its newest ``limit`` rows rather than parsing every session dir.
    scope_counts: dict[str, int] = {}

    cache = _open_history_cache()
    cached = _cache_lookup(cache, candidates)
    pending: list[tuple[str, int, int, str, dict]] = []

    for mtime, jsonl_path, mtime_ns, size in candidates:
        if scoped and all(scope_counts.get(p, 0) >= limit for p in project_ids):
            break
        payload = cached.get(str(jsonl_path))
        if payload is None:
            meta = read_copilot_session_meta(jsonl_path)
            message_count, last_user_message = _copilot_stats(jsonl_path)
            payload = {
                "session_id": str(meta.get("id") or jsonl_path.parent.name),
                "cwd": meta.get("cwd") or None,
                "message_count": message_count,
                "last_user_message": last_user_message,
                "last_content_ts": _last_content_timestamp(jsonl_path, mtime).isoformat(),
            }
            pending.append((str(jsonl_path), mtime_ns, size, "copilot", payload))

        sid = payload.get("session_id")
        if not sid or sid in seen:
            continue
        seen.add(sid)

        cwd = payload.get("cwd") or None
        if _is_scratch_cwd(cwd):
            continue
        pid = _project_id_for(cwd, None, cwd_to_pid)
        if scoped and pid not in project_ids:
            continue
        if scoped:
            scope_counts[pid] = scope_counts.get(pid, 0) + 1

        last_prompt = _pick_last_prompt(payload.get("last_user_message"))
        ap_id, ap_name, ap_last_active_at = process_index.get(sid, (None, None, None))
        result.append(
            WorkerHistoryEntry(
                worker_type=WorkerType.COPILOT,
                worker_id=sid,
                project_id=pid,
                project_name=_basename(cwd),
                project_cwd=cwd,
                last_active_time=_payload_last_active(payload, mtime),
                name=ap_name,
                last_prompt=last_prompt,
                git_branch=None,
                message_count=payload.get("message_count"),
                agentic_process_id=ap_id,
                last_active_at=ap_last_active_at,
            )
        )
    _cache_store(cache, pending)
    return result


def _copilot_stats(jsonl_path: Path) -> tuple[Optional[int], Optional[str]]:
    import json

    count = 0
    last_user: Optional[str] = None
    try:
        with jsonl_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if raw.get("type") == "user.message":
                    count += 1
                    data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
                    content = data.get("content")
                    if isinstance(content, str) and content.strip():
                        last_user = content.strip()
    except OSError:
        return None, None
    return (count if count > 0 else None), last_user


async def get_claude_worker_history(
    limit: int,
    process_index: Optional[ProcessIndex] = None,
    project_ids: ScopeProjectIds = None,
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> list[WorkerHistoryEntry]:
    """Return the most-recent N Claude sessions, newest first.

    Sources sessions from on-disk transcripts (``~/.claude/projects/<enc>/<sid>.jsonl``)
    rather than from ``~/.claude/history.jsonl``. The history file only logs *user
    prompts*; sessions that were resumed/active today but whose latest prompt is older
    are missing from it. The transcript file's mtime is the canonical "last active"
    signal.

    When ``project_ids`` is given the walk is restricted to those projects so an
    under-active project's sessions aren't truncated behind busier ones.
    """
    idx = process_index if process_index is not None else {}
    return await asyncio.to_thread(_collect_claude_entries_sync, limit, idx, project_ids, cwd_to_pid)


async def get_codex_worker_history(
    limit: int,
    process_index: Optional[ProcessIndex] = None,
    project_ids: ScopeProjectIds = None,
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> list[WorkerHistoryEntry]:
    """Return the most-recent N Codex sessions, newest first.

    Walks ``$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl``, sorts by mtime
    desc, and parses only the top-N for envelope + lazy stats. Mirrors the
    Claude provider's stat-then-parse pattern.
    """
    idx = process_index if process_index is not None else {}
    return await asyncio.to_thread(_collect_codex_entries_sync, limit, idx, project_ids, cwd_to_pid)


async def get_copilot_worker_history(
    limit: int,
    process_index: Optional[ProcessIndex] = None,
    project_ids: ScopeProjectIds = None,
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> list[WorkerHistoryEntry]:
    """Return the most-recent N Copilot sessions, newest first."""
    idx = process_index if process_index is not None else {}
    return await asyncio.to_thread(_collect_copilot_entries_sync, limit, idx, project_ids, cwd_to_pid)


WORKER_HISTORY_PROVIDERS: dict[WorkerType, WorkerHistoryProvider] = {
    WorkerType.CLAUDE: get_claude_worker_history,
    WorkerType.CODEX: get_codex_worker_history,
    WorkerType.COPILOT: get_copilot_worker_history,
}


def _agentic_process_only_entries(
    processes: list["AgenticProcess"],
    seen: set[tuple[WorkerType, str]],
    project_ids: ScopeProjectIds = None,
    cwd_to_pid: Optional[dict[str, str]] = None,
) -> list[WorkerHistoryEntry]:
    """Surface AgenticProcess entities whose session is absent from any worker's history file."""
    extra: list[WorkerHistoryEntry] = []
    for proc in processes:
        sid = proc.session_id
        if not sid:
            continue
        worker_type = _normalize_worker_type(getattr(proc, "worker_type", None))
        key = (worker_type, sid)
        if key in seen:
            continue

        if project_ids is not None:
            workdir_for_scope = getattr(proc, "workdir", None) or None
            proc_pid = proc.project_id or _project_id_for(workdir_for_scope, None, cwd_to_pid)
            if proc_pid not in project_ids:
                continue

        # Skip transient APs: scratch workdir, bare-home workdir (no project
        # context), or no project anchor at all. These come from test fixtures
        # (file-op-e2e, compute_node tests, hundreds of zombie APs whose
        # updated_date is constantly "right now") and crowd out real sessions.
        # Real sessions whose cwd really is $HOME still surface via the JSONL
        # walk in ``_collect_claude_entries_sync`` — that path requires a
        # transcript, which is the actual signal of real work.
        workdir = getattr(proc, "workdir", None) or None
        if _is_scratch_cwd(workdir):
            continue
        if workdir:
            try:
                if Path(workdir).resolve() == Path.home().resolve():
                    continue
            except (OSError, ValueError):
                pass
        if not workdir and not getattr(proc, "project_id", None):
            continue

        last_active = _coerce_datetime(getattr(proc, "updated_date", None)) or datetime.now(
            tz=timezone.utc
        )

        extra.append(
            WorkerHistoryEntry(
                worker_type=worker_type,
                worker_id=sid,
                project_id=proc.project_id or _project_id_for(workdir, None, cwd_to_pid),
                project_name=_basename(workdir),
                project_cwd=workdir,
                last_active_time=last_active,
                name=getattr(proc, "name", None) or None,
                git_branch=None,
                message_count=None,
                agentic_process_id=proc.id,
                last_active_at=(
                    proc.last_active_at if isinstance(getattr(proc, "last_active_at", None), int) else None
                ),
            )
        )

    return extra


async def _load_agentic_processes() -> list["AgenticProcess"]:
    """Best-effort fetch of all AgenticProcess entities. Returns ``[]`` on failure."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    try:
        return await AgenticProcess.get_all()
    except Exception as e:
        logger.warning("[worker_history] AgenticProcess.get_all failed: %s", e)
        return []


async def get_worker_history(
    limit: int = 10, project_ids: ScopeProjectIds = None
) -> list[WorkerHistoryEntry]:
    """Unified, deduplicated worker history across every registered provider.

    The ``limit`` is applied **per project scope**, not as a single global
    top-N: each project's most-recent ``limit`` sessions survive, so a project
    you haven't touched lately is never squeezed out of the slice by a busier
    one. ``project_ids`` (the active scope) restricts the walk to those projects
    and is threaded into the providers so under-active projects aren't truncated
    at the disk-walk layer either.
    """
    # Stamp entries with the real Project entity id (not the path-derived alias)
    # so they match the entity ids clients scope by and the per-project cap
    # buckets one key per project. A cwd with no Project entity falls back to the
    # alias (and simply won't match an entity-id scope — the active scope is
    # always a materialized project).
    cwd_to_pid = await _cwd_to_project_id()

    processes = await _load_agentic_processes()
    process_index = _build_agentic_process_index(processes)

    collected: list[WorkerHistoryEntry] = []
    seen: set[tuple[WorkerType, str]] = set()

    # Providers run concurrently (each is one ``to_thread`` hop over its own
    # disk corpus) — wall time is max(provider), not sum. Results are folded in
    # registration order so dedup precedence is unchanged. The call happens
    # inside ``_run`` so even a synchronously-raising provider is captured by
    # ``return_exceptions`` instead of escaping ``gather(*...)``.
    async def _run(provider: WorkerHistoryProvider) -> list[WorkerHistoryEntry]:
        return await provider(limit, process_index, project_ids, cwd_to_pid)

    provider_results = await asyncio.gather(
        *(_run(provider) for provider in WORKER_HISTORY_PROVIDERS.values()),
        return_exceptions=True,
    )
    for worker_type, entries in zip(WORKER_HISTORY_PROVIDERS, provider_results):
        if isinstance(entries, NotImplementedError):
            continue
        if isinstance(entries, BaseException):
            logger.warning("[worker_history] provider %s failed: %s", worker_type, entries)
            continue
        for entry in entries:
            key = (entry.worker_type, entry.worker_id)
            if key in seen:
                continue
            seen.add(key)
            collected.append(entry)

    collected.extend(_agentic_process_only_entries(processes, seen, project_ids, cwd_to_pid))
    collected.sort(key=lambda e: e.last_active_time, reverse=True)

    if project_ids is not None:
        collected = [e for e in collected if e.project_id in project_ids]

    # Per-scope cap: keep up to ``limit`` rows per project_id group (None =
    # the user/unscoped bucket), preserving the global recency order. Replaces
    # the old global ``collected[:limit]`` that dropped under-active projects.
    counts: dict[Optional[str], int] = {}
    capped: list[WorkerHistoryEntry] = []
    for entry in collected:
        bucket = entry.project_id
        n = counts.get(bucket, 0)
        if n >= limit:
            continue
        counts[bucket] = n + 1
        capped.append(entry)
    return capped


def _claude_file_title_sync(jsonl_path: Path) -> tuple[Optional[str], Optional[str]]:
    """``(custom_title, slug)`` for a Claude session file — the on-file title
    fields ``_collect_claude_entries_sync`` feeds to ``_pick_name``. Returns
    ``(None, None)`` on any parse failure."""
    try:
        from flow_sdk.fs_store.indexer.functions.claude_sessions import (
            extract_claude_session_from_path,
        )

        session = extract_claude_session_from_path(jsonl_path, include_content=False)
        sd = object.__getattribute__(session, "__dict__")
        return (sd.get("custom_title") or None, session.slug or None)
    except Exception as e:  # noqa: BLE001
        logger.debug("[worker_history] claude title read failed for %s: %s", jsonl_path, e)
        return (None, None)


def _claude_first_prompt_sync(jsonl_path: Path) -> Optional[str]:
    """First real user prompt in a Claude transcript head, whitespace-collapsed.

    The default-name fallback source for headless sessions: an SDK-launched
    (``-p``/stream-json) Claude session never receives a ``slug``/``aiTitle``
    on file — only interactive CLI sessions do — so title-only resolution
    leaves those processes nameless forever. Head-bounded like the envelope
    reads (``_iter_head_json``); returns ``None`` when no user line is found.
    """
    try:
        from flow_sdk.fs_store.indexer.functions.claude_sessions import _iter_head_json

        for raw in _iter_head_json(jsonl_path):
            if raw.get("type") != "user" or raw.get("isMeta"):
                continue
            content = (raw.get("message") or {}).get("content")
            if isinstance(content, list):
                content = next(
                    (p.get("text") for p in content if isinstance(p, dict) and p.get("type") == "text"),
                    None,
                )
            if isinstance(content, str) and content.strip():
                return " ".join(content.split())
    except OSError as e:
        logger.debug("[worker_history] claude first-prompt read failed for %s: %s", jsonl_path, e)
    return None


async def get_worker_session_name(
    worker_type: object,
    session_id: str,
    *,
    jsonl_path: Optional[Path] = None,
    prompt_fallback: bool = False,
) -> Optional[str]:
    """Generic display title for ONE worker session — the same value that
    ``WorkerHistoryEntry.name`` (and therefore the ``history_entry`` list) carries,
    resolved for a single session id.

    Priority matches the history collectors: the owning ``AgenticProcess.name``
    first, then — for Claude only — the session's own ``custom_title``/``slug``
    (Codex/Copilot carry no on-file title, so they name only through an owning
    process). Returns ``None`` when nothing names it, so the caller can leave the
    existing label untouched. ``jsonl_path`` (when known) skips a path re-resolve.

    ``prompt_fallback=True`` adds a LAST-resort rung: the transcript's first
    user prompt. The history list must NOT use it (it renders name and
    last-prompt as two separate lines), but the default-name stamp does —
    headless (SDK-launched) sessions carry no on-file title at all, and
    without this rung they stay nameless on every UI surface.
    """
    if not session_id:
        return None
    wt = _normalize_worker_type(worker_type)
    # One filtered lookup for the owning process — NOT the full ``get_all()`` +
    # index the history list builds; this runs per single transcript open.
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    proc = await AgenticProcess.get_by_session_id(session_id)
    raw_name = getattr(proc, "name", None) if proc else None
    ap_name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else None

    custom_title: Optional[str] = None
    slug: Optional[str] = None
    first_prompt: Optional[str] = None
    if wt is WorkerType.CLAUDE and jsonl_path is not None:
        custom_title, slug = await asyncio.to_thread(_claude_file_title_sync, jsonl_path)
        if prompt_fallback and not (ap_name or custom_title or slug):
            first_prompt = await asyncio.to_thread(_claude_first_prompt_sync, jsonl_path)

    # Same arg→priority mapping as ``_collect_claude_entries_sync``:
    # AgenticProcess.name > Claude custom_title > Claude slug.
    return (
        _pick_name(
            custom_title=ap_name,
            slug=custom_title,
            display=slug,
            session_id=session_id,
        )
        # _pick_name applies the shared trim / 80-char cap / not-an-id filter
        # to the prompt rung too.
        or _pick_name(custom_title=first_prompt, slug=None, display=None, session_id=session_id)
    )
