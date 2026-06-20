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


ProcessIndex = dict[str, tuple[str, Optional[str]]]
WorkerHistoryProvider = Callable[[int, ProcessIndex], Awaitable[list[WorkerHistoryEntry]]]


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


def _project_id_for(cwd: Optional[str], encoded: Optional[str]) -> Optional[str]:
    """Compute a project_id that the Entity layer also uses.

    ``Project.allocate_id`` (flow_sdk/builtin/project.py) keys on the real mount
    path: ``uuid5(DNS, f"project:{mount_path}")``. We mirror that here so the
    id we return matches the Project entity that gets materialized for the same
    cwd — the tab-strip filter in ``useActiveTerminals`` checks Project entity
    ids, not the ``ClaudeProjectFsRecord`` (encoded-name) ids.

    Fallback to the encoded form only when no real cwd is known (rare — empty
    or never-touched session). That fallback id won't equal a Project entity id
    but is still a stable identifier for the row.
    """
    if cwd:
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
    """Map ``session_id → (agentic_process_id, name)`` from live entity rows.

    Whatever ends up in this index is openable via ``AgenticProcess.getById``
    on the client — by construction, since we sourced it from the same store.
    """
    index: ProcessIndex = {}
    for proc in processes:
        sid = proc.session_id
        if not sid or sid in index:
            continue
        raw_name = getattr(proc, "name", None)
        name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else None
        index[sid] = (proc.id, name)
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


def _collect_claude_entries_sync(
    limit: int, process_index: ProcessIndex
) -> list[WorkerHistoryEntry]:
    """Blocking body of ``get_claude_worker_history``. Runs under ``to_thread``."""
    from flow_sdk.fs_store.indexer.functions.claude_sessions import extract_claude_session_from_path
    from flow_sdk.instance_settings import get_instance_settings

    projects_dir = get_instance_settings().claude_projects_dir
    if not projects_dir.is_dir():
        return []

    # Stat every JSONL, sort by mtime desc, keep the top ``over_fetch``.
    # Skip scratch encoded dirs (tmp/var-folders/flow-sessions) at walk time so
    # transient test sessions don't crowd real user work out of the slice.
    candidates: list[tuple[float, Path]] = []
    for proj_dir in projects_dir.iterdir():
        if not proj_dir.is_dir() or _is_scratch_encoded_dir(proj_dir.name):
            continue
        for jsonl in proj_dir.glob("*.jsonl"):
            try:
                candidates.append((jsonl.stat().st_mtime, jsonl))
            except OSError:
                continue
    candidates.sort(key=lambda x: -x[0])
    # Each JSONL has a unique session_id, so no dedup loss. Over-fetch
    # generously so the top-N has room for project-scoped filtering on the
    # client and for sessions whose envelope parse rejects them below.
    candidates = candidates[: max(limit + 5, limit * 4 + 50)]

    history_prompt_index = _build_history_latest_prompt_index()

    result: list[WorkerHistoryEntry] = []
    seen: set[str] = set()

    from flow_sdk.fs_store.indexer.functions.claude_sessions import ensure_claude_session_stats  # noqa: PLC0415

    for mtime, jsonl_path in candidates:
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

        sid = session.session_id
        if not sid or sid in seen:
            continue
        seen.add(sid)

        sd = object.__getattribute__(session, "__dict__")
        cwd = sd.get("cwd") or None
        if _is_scratch_cwd(cwd):
            # Belt-and-suspenders for sessions whose encoded dir name slipped
            # past the scratch prefix check (e.g. unusual path encodings).
            continue
        project_encoded = sd.get("project_encoded_name") or jsonl_path.parent.name

        git_branch: Optional[str] = sd.get("git_branch") or None
        message_count: Optional[int] = sd.get("message_count") or None
        last_user_message: Optional[str] = sd.get("last_user_message")

        # Name priority: AgenticProcess.name (user/upsert-set) > Claude's
        # ``custom_title`` (set by ``/rename`` or Claude's own auto-summary,
        # written as ``{"type":"custom-title"}`` lines) > ``slug`` (first-line
        # envelope, auto-generated from the opening prompt). Without these
        # fallbacks the row would be unnamed for any session that was never
        # opened through Flowpad — that's the majority of on-disk Claude
        # sessions. ``_pick_name`` filters out session_id / UUID-like values,
        # so a trivial session still falls through to ``last_prompt`` rendering.
        ap_id, ap_name = process_index.get(sid, (None, None))
        name = _pick_name(
            custom_title=ap_name,
            slug=sd.get("custom_title") or None,
            display=session.slug or None,
            session_id=sid,
        )
        last_prompt = _pick_last_prompt(
            last_user_message or history_prompt_index.get(sid),
        )

        result.append(
            WorkerHistoryEntry(
                worker_type=WorkerType.CLAUDE,
                worker_id=sid,
                project_id=_project_id_for(cwd, project_encoded),
                project_name=_basename(cwd) or (project_encoded or None),
                project_cwd=cwd,
                last_active_time=datetime.fromtimestamp(mtime, tz=timezone.utc),
                name=name,
                last_prompt=last_prompt,
                git_branch=git_branch,
                message_count=message_count,
                agentic_process_id=ap_id,
            )
        )

    return result


def _collect_codex_entries_sync(
    limit: int, process_index: ProcessIndex
) -> list[WorkerHistoryEntry]:
    """Blocking body of ``get_codex_worker_history``. Runs under ``to_thread``."""
    from flow_sdk.fs_store.indexer.functions.codex_sessions import extract_codex_session_from_path
    from flow_sdk.instance_settings import get_instance_settings

    sessions_root = get_instance_settings().codex_sessions_dir
    if not sessions_root.is_dir():
        return []

    candidates: list[tuple[float, Path]] = []
    for jsonl in sessions_root.rglob("rollout-*.jsonl"):
        try:
            candidates.append((jsonl.stat().st_mtime, jsonl))
        except OSError:
            continue
    candidates.sort(key=lambda x: -x[0])
    # Same generous over-fetch as Claude; scratch filter is applied post-parse
    # because codex rollouts live in date-sharded dirs (cwd known only after
    # reading the envelope).
    candidates = candidates[: max(limit + 5, limit * 4 + 50)]

    result: list[WorkerHistoryEntry] = []
    seen: set[str] = set()

    from flow_sdk.fs_store.indexer.functions.codex_sessions import ensure_codex_session_stats  # noqa: PLC0415

    for mtime, jsonl_path in candidates:
        try:
            # include_content=False: see the Claude branch above — worker-history
            # never reads `session.content`, so skip the full-transcript parse.
            session = extract_codex_session_from_path(jsonl_path, include_content=False)
            ensure_codex_session_stats(session)  # populate message_count, last_user_message, etc.
        except Exception as e:
            logger.debug("[worker_history] codex from_jsonl failed for %s: %s", jsonl_path, e)
            continue

        sid = session.session_id
        if not sid or sid in seen:
            continue
        seen.add(sid)

        sd = object.__getattribute__(session, "__dict__")
        cwd = sd.get("cwd") or None
        if _is_scratch_cwd(cwd):
            continue

        message_count: Optional[int] = None
        last_user_message: Optional[str] = None
        try:
            mc = sd.get("message_count") or 0
            message_count = mc if mc > 0 else None
            last_user_message = sd.get("last_user_message")
        except Exception as e:
            logger.debug("[worker_history] codex stats read failed for %s: %s", sid, e)

        # Codex sessions never carry their own title — name comes from the
        # AgenticProcess entity if one exists for this session, else None.
        last_prompt = _pick_last_prompt(last_user_message)
        ap_id, ap_name = process_index.get(sid, (None, None))

        result.append(
            WorkerHistoryEntry(
                worker_type=WorkerType.CODEX,
                worker_id=sid,
                project_id=_project_id_for(cwd, None),
                project_name=_basename(cwd),
                project_cwd=cwd,
                last_active_time=datetime.fromtimestamp(mtime, tz=timezone.utc),
                name=ap_name,
                last_prompt=last_prompt,
                git_branch=None,
                message_count=message_count,
                agentic_process_id=ap_id,
            )
        )

    return result


def _collect_copilot_entries_sync(
    limit: int, process_index: ProcessIndex
) -> list[WorkerHistoryEntry]:
    """Blocking body of ``get_copilot_worker_history``. Runs under ``to_thread``."""
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
        copilot_session_state_root,
        read_copilot_session_meta,
    )

    root = copilot_session_state_root()
    if not root.is_dir():
        return []

    candidates: list[tuple[float, Path]] = []
    for jsonl in root.glob("*/events.jsonl"):
        try:
            candidates.append((jsonl.stat().st_mtime, jsonl))
        except OSError:
            continue
    candidates.sort(key=lambda x: -x[0])
    candidates = candidates[: max(limit + 5, limit * 4 + 50)]

    result: list[WorkerHistoryEntry] = []
    seen: set[str] = set()
    for mtime, jsonl_path in candidates:
        meta = read_copilot_session_meta(jsonl_path)
        sid = str(meta.get("id") or jsonl_path.parent.name)
        if not sid or sid in seen:
            continue
        seen.add(sid)

        cwd = meta.get("cwd") or None
        if _is_scratch_cwd(cwd):
            continue

        message_count, last_user_message = _copilot_stats(jsonl_path)
        last_prompt = _pick_last_prompt(last_user_message)
        ap_id, ap_name = process_index.get(sid, (None, None))
        result.append(
            WorkerHistoryEntry(
                worker_type=WorkerType.COPILOT,
                worker_id=sid,
                project_id=_project_id_for(cwd, None),
                project_name=_basename(cwd),
                project_cwd=cwd,
                last_active_time=datetime.fromtimestamp(mtime, tz=timezone.utc),
                name=ap_name,
                last_prompt=last_prompt,
                git_branch=None,
                message_count=message_count,
                agentic_process_id=ap_id,
            )
        )
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
    limit: int, process_index: Optional[ProcessIndex] = None
) -> list[WorkerHistoryEntry]:
    """Return the most-recent N Claude sessions, newest first.

    Sources sessions from on-disk transcripts (``~/.claude/projects/<enc>/<sid>.jsonl``)
    rather than from ``~/.claude/history.jsonl``. The history file only logs *user
    prompts*; sessions that were resumed/active today but whose latest prompt is older
    are missing from it. The transcript file's mtime is the canonical "last active"
    signal.
    """
    idx = process_index if process_index is not None else {}
    return await asyncio.to_thread(_collect_claude_entries_sync, limit, idx)


async def get_codex_worker_history(
    limit: int, process_index: Optional[ProcessIndex] = None
) -> list[WorkerHistoryEntry]:
    """Return the most-recent N Codex sessions, newest first.

    Walks ``$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl``, sorts by mtime
    desc, and parses only the top-N for envelope + lazy stats. Mirrors the
    Claude provider's stat-then-parse pattern.
    """
    idx = process_index if process_index is not None else {}
    return await asyncio.to_thread(_collect_codex_entries_sync, limit, idx)


async def get_copilot_worker_history(
    limit: int, process_index: Optional[ProcessIndex] = None
) -> list[WorkerHistoryEntry]:
    """Return the most-recent N Copilot sessions, newest first."""
    idx = process_index if process_index is not None else {}
    return await asyncio.to_thread(_collect_copilot_entries_sync, limit, idx)


WORKER_HISTORY_PROVIDERS: dict[WorkerType, WorkerHistoryProvider] = {
    WorkerType.CLAUDE: get_claude_worker_history,
    WorkerType.CODEX: get_codex_worker_history,
    WorkerType.COPILOT: get_copilot_worker_history,
}


def _agentic_process_only_entries(
    processes: list["AgenticProcess"],
    seen: set[tuple[WorkerType, str]],
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
                project_id=proc.project_id or _project_id_for(workdir, None),
                project_name=_basename(workdir),
                project_cwd=workdir,
                last_active_time=last_active,
                name=getattr(proc, "name", None) or None,
                git_branch=None,
                message_count=None,
                agentic_process_id=proc.id,
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


async def get_worker_history(limit: int = 10) -> list[WorkerHistoryEntry]:
    """Unified, deduplicated worker history across every registered provider."""
    processes = await _load_agentic_processes()
    process_index = _build_agentic_process_index(processes)

    collected: list[WorkerHistoryEntry] = []
    seen: set[tuple[WorkerType, str]] = set()

    for worker_type, provider in WORKER_HISTORY_PROVIDERS.items():
        try:
            entries = await provider(limit, process_index)
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

    collected.extend(_agentic_process_only_entries(processes, seen))
    collected.sort(key=lambda e: e.last_active_time, reverse=True)
    return collected[:limit]


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


async def get_worker_session_name(
    worker_type: object,
    session_id: str,
    *,
    jsonl_path: Optional[Path] = None,
) -> Optional[str]:
    """Generic display title for ONE worker session — the same value that
    ``WorkerHistoryEntry.name`` (and therefore the ``history_entry`` list) carries,
    resolved for a single session id.

    Priority matches the history collectors: the owning ``AgenticProcess.name``
    first, then — for Claude only — the session's own ``custom_title``/``slug``
    (Codex/Copilot carry no on-file title, so they name only through an owning
    process). Returns ``None`` when nothing names it, so the caller can leave the
    existing label untouched. ``jsonl_path`` (when known) skips a path re-resolve.
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
    if wt is WorkerType.CLAUDE and jsonl_path is not None:
        custom_title, slug = await asyncio.to_thread(_claude_file_title_sync, jsonl_path)

    # Same arg→priority mapping as ``_collect_claude_entries_sync``:
    # AgenticProcess.name > Claude custom_title > Claude slug.
    return _pick_name(
        custom_title=ap_name,
        slug=custom_title,
        display=slug,
        session_id=session_id,
    )
