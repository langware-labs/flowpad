"""Walker + extractor + helpers for CLAUDE_SESSION records.

Source: ``~/.claude/projects/<encoded-path>/<session-id>.jsonl``. Each line
is a JSON entry with envelope (sessionId, cwd, version, gitBranch, slug,
timestamp, uuid) plus a type-specific payload.

Replaces the deleted ``ClaudeSessionRecord`` subclass. Read-only — Claude
Code owns the JSONL files; the indexer never writes them.

Public helpers used outside the indexer:
- ``extract_claude_session_from_path(path)`` — build a Record from a JSONL
  path (replaces ``ClaudeSessionRecord.from_jsonl``).
- ``discover_claude_session_paths_iter(limit)`` — yield session JSONL paths
  (replaces ``ClaudeSessionRecord.discover_paths_iter``).
- ``get_claude_session(uid, project=None)`` — find a session by id
  (replaces ``ClaudeSessionRecord.get``).
- ``ensure_claude_session_stats(rec)`` — lazy-populate stat fields onto the
  Record (replaces ``_SessionStatsProp`` descriptors on attr access).
- ``claude_session_status(rec)`` — WorkerStatus from the JSONL tail
  (replaces the ``.status`` property).
- ``claude_session_is_active(rec)`` — mtime-based active check (replaces
  the ``is_active`` PropertyRecord descriptor).
- ``claude_session_start_time(rec)`` — first JSONL timestamp (replaces the
  ``start_time`` PropertyRecord descriptor).
- ``claude_session_filtered_entries(rec)`` / ``claude_session_transcript_entries(rec)``
  — load transcript entries.
- ``claude_session_to_transcript_dicts(rec, include_raw_json=False)`` —
  serialize transcript for API responses.
- ``claude_session_to_dict(rec)`` — full to_dict including lazy stats.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from flow_sdk.builtin.worker_status import WorkerStatus, _tail_status
from flow_sdk.fs_store.indexer.functions._claude_session_stats import (
    _get_session_batch_stats,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings

_HEAD_LINES = 64
_TAIL_BYTES = 16384

# Fields populated onto the record by ensure_claude_session_stats. Mirror of
# the _SessionStatsProp descriptors on the deleted subclass.
_STAT_FIELDS = (
    "session_id", "cwd", "version", "git_branch", "slug",
    "model", "message_count", "user_message_count", "assistant_message_count",
    "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens",
    "duration_ms", "tools_used", "has_plan", "last_stop_reason",
    "last_user_message", "modified_at", "task_path",
    "estimated_cost_usd", "models_used", "primary_model", "created_at",
)

# Transcript entry types to exclude from filtered_entries (matches the
# deleted ClaudeSessionRecord.EXCLUDED_ENTRY_TYPES).
_EXCLUDED_ENTRY_TYPES = ("file-history-snapshot", "progress")

_ACTIVE_MAX_AGE_SECONDS = 300  # 5 minutes of inactivity → inactive

# ── Walker ───────────────────────────────────────────────────────────────────

def claude_sessions_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        for jsonl in sorted(Path(node.path).glob("*.jsonl")):
            out.append(
                FSRef(
                    jsonl,
                    record_type=RecordType.CLAUDE_SESSION,
                    parent=node,
                )
            )
    return out

# ── Helpers ──────────────────────────────────────────────────────────────────

def _extract_text(content: object) -> str | None:
    """Extract plain text from a message content field (str or list of blocks)."""
    if isinstance(content, str):
        text = content.strip()
        return text if text and not text.startswith("<") else None
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "").strip()
                return text if text and not text.startswith("<") else None
    return None

def _iter_head_json(path: str | Path) -> Iterator[dict]:
    """Yield parsed JSON envelopes from the first ``_HEAD_LINES`` JSONL lines.

    Mirror of ``codex_sessions._iter_head_json``: iterates complete lines and
    skips unparsable ones. A fixed-byte head slab is NOT safe here — an early
    oversized entry (e.g. a file-history-snapshot) can push the ``cwd``-bearing
    line past the byte boundary, and the truncated line's parse error used to
    abort the scan, silently dropping ``cwd`` (which then bound resumed
    processes to the wrong project).
    """
    with open(path, encoding="utf-8", errors="replace") as fh:
        for _, line in zip(range(_HEAD_LINES), fh):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue

def claude_session_id(ref: FSRef) -> str:
    """Stable, filesystem-safe **UUID** id = sessionId from the JSONL head
    envelope (fallback: filename stem). Claude session ids are already UUIDs so
    they're kept as-is; anything non-conforming is hashed with the same
    ``f"{type}:{key}"`` formula ``Entity.allocate_id`` uses, so it matches the DB
    id."""
    key = ref._path.stem
    try:
        for raw in _iter_head_json(ref._path):
            sid = raw.get("sessionId")
            if sid:
                key = str(sid)
                break
    except OSError:
        pass
    return key if is_valid_entity_id(key) else mint_uuid(f"{RecordType.CLAUDE_SESSION}:{key}", namespace=uuid.NAMESPACE_DNS)

# ── Extractor (head + tail read, no stat parse) ──────────────────────────────

def extract_claude_session(ref: FSRef) -> list[FSRecord]:
    """Parse a JSONL session into a Record. Replaces ``ClaudeSessionRecord._from_fsref_sync``."""
    return [extract_claude_session_from_path(ref._path)]

def extract_claude_session_from_path(path: str | Path, *, include_content: bool = True) -> FSRecord:
    """Build a Record from a JSONL transcript path.

    Envelope fields are read cheaply: first ``_HEAD_LINES`` lines for
    session_id / slug / cwd, tail ``_TAIL_BYTES`` for the most-recent ai-title
    or custom-title. The searchable ``content`` (extractive transcript text for
    FTS) requires a full-transcript parse via ``worker_summary_log`` — this is
    gated by the indexer's skip-fresh check, so it only runs when the JSONL has
    changed. Listing callers that hit many transcripts per request (e.g.
    worker history) must pass ``include_content=False`` — they have no
    skip-fresh gate, and the full parse per file starves the server.
    Stats are NOT populated here — call
    ``ensure_claude_session_stats(rec)`` to lazy-load them.

    Replaces ``ClaudeSessionRecord.from_jsonl``.
    """
    path = Path(path)
    session_id = path.stem  # fallback
    slug = ""
    cwd = ""
    custom_title = ""

    # head — first few lines cover session_id / slug / cwd
    try:
        for raw in _iter_head_json(path):
            if raw.get("sessionId"):
                session_id = raw["sessionId"]
            if raw.get("slug"):
                slug = raw["slug"]
            if not cwd and raw.get("cwd"):
                cwd = raw["cwd"]
            # Stop at the first cwd-bearing line. slug/sessionId ride the same
            # envelope when present, and most transcripts have no slug at all —
            # requiring it here would force reading all _HEAD_LINES lines
            # (including multi-hundred-KB snapshot entries) on every listing.
            if cwd:
                break
    except OSError:
        pass

    # tail — most-recent ai-title (preferred) or custom-title
    try:
        sz = path.stat().st_size
        with open(path, "rb") as fb:
            if sz > _TAIL_BYTES:
                fb.seek(sz - _TAIL_BYTES)
            tail = fb.read().decode("utf-8", errors="replace")
        tail_custom: str = ""
        for line in reversed(tail.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            rtype = raw.get("type")
            if rtype == "ai-title" and raw.get("aiTitle"):
                custom_title = raw["aiTitle"]
                break
            if not tail_custom and rtype == "custom-title" and raw.get("customTitle"):
                tail_custom = raw["customTitle"]
        if not custom_title and tail_custom:
            custom_title = tail_custom
    except OSError:
        pass

    name = custom_title or slug or session_id

    # Extractive transcript text for full-text search (worker-generic).
    content = ""
    if include_content:
        from flow_sdk.transcript_analyzer import worker_summary_log  # noqa: PLC0415
        content = worker_summary_log(path, "claude")

    rec = FSRecord(
        type=RecordType.CLAUDE_SESSION,
        id=session_id,
        name=name,
        session_id=session_id,
        slug=slug,
        cwd=cwd,
        custom_title=custom_title,
        jsonl_path=str(path),
        source_file=str(path),
        path=str(path),
        content=content,
    )
    # Read-only — Claude Code owns the JSONL.
    object.__setattr__(rec, "_asset_ref", FSRef(path, read_only=True))
    return rec

# ── Lazy stats (mirror of ensure_codex_session_stats) ─────────────────────────

def ensure_claude_session_stats(rec: Record) -> FSRecord:
    """Populate lazy stat fields onto the record. Idempotent.

    Replaces the ``_SessionStatsProp`` descriptors: instead of triggering on
    attribute access, callers invoke this explicitly before reading any
    field beyond the head set (session_id, slug, cwd).
    """
    stats = _get_session_batch_stats(rec)
    inst = object.__getattribute__(rec, "__dict__")
    for field in _STAT_FIELDS:
        if field in stats:
            value = stats[field]
            existing = inst.get(field)
            if value or not existing:
                inst[field] = value
    return rec

# ── Active / start_time (replaces PropertyRecord descriptors) ─────────────────

def claude_session_is_active(rec: Record) -> bool:
    """True iff JSONL mtime is within the last 5 minutes."""
    path = getattr(rec, "jsonl_path", None) or rec.source_file
    if not path:
        return False
    try:
        mtime = Path(path).stat().st_mtime
    except OSError:
        return False
    return (time.time() - mtime) <= _ACTIVE_MAX_AGE_SECONDS

def claude_session_start_time(rec: Record) -> str | None:
    """ISO timestamp of the first JSONL entry; fallback to file ctime."""
    path = getattr(rec, "jsonl_path", None) or rec.source_file
    if not path:
        return None
    p = Path(path)
    try:
        with open(p, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                    ts = raw.get("timestamp")
                    if ts:
                        return str(ts)
                except json.JSONDecodeError:
                    continue
        return datetime.fromtimestamp(p.stat().st_ctime, tz=timezone.utc).isoformat()
    except OSError:
        return None

def claude_session_status(rec: Record) -> WorkerStatus:
    """Derive WorkerStatus from the last 4 KB of the JSONL (~60µs)."""
    path = getattr(rec, "jsonl_path", None) or rec.source_file
    if not path:
        return WorkerStatus.IDLE
    return _tail_status(path)

# ── Transcript helpers ────────────────────────────────────────────────────────

def claude_session_transcript_entries(rec: Record) -> list:
    """Lazily load transcript entries from the JSONL file."""
    from flow_sdk.fs_store.indexer.functions.claude_transcript import create_transcript_entry

    path = getattr(rec, "jsonl_path", None) or rec.source_file or ""
    if not path or not Path(path).is_file():
        return []
    entries = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            entries.append(create_transcript_entry(raw))
    return entries

def claude_session_filtered_entries(rec: Record) -> list:
    """Transcript entries minus noisy types (file-history-snapshot, progress)."""
    return [
        e for e in claude_session_transcript_entries(rec)
        if getattr(e, "entry_type", None) not in _EXCLUDED_ENTRY_TYPES
    ]

def claude_session_to_transcript_dicts(rec: Record, include_raw_json: bool = False) -> list[dict]:
    """Return filtered transcript entries as serializable dicts."""
    entries = claude_session_filtered_entries(rec)
    if include_raw_json:
        return [e.meta_dict() for e in entries]
    return [
        {k: v for k, v in e.meta_dict().items() if k != "raw_json"}
        for e in entries
    ]

def claude_session_to_dict(rec: Record) -> dict:
    """Serialize to dict, including lazy stat fields and derived status."""
    ensure_claude_session_stats(rec)
    d = rec.to_dict()
    d["status"] = claude_session_status(rec)
    d["is_active"] = claude_session_is_active(rec)
    return d

def claude_session_meta_dict(rec: Record) -> dict:
    """Fast meta_dict for bulk listings — avoids the full JSONL parse.

    Mirrors the deleted ``ClaudeSessionRecord.meta_dict`` fast path: derives
    id/name/type/updated_date/created_date/status/message_count/slug/cwd
    from cheap sources (head fields + one stat() + first JSONL line). Use
    this for project session listings; call ``ensure_claude_session_stats``
    + ``rec.to_dict()`` when full stats are needed.
    """
    import os as _os

    inst = object.__getattribute__(rec, "__dict__")

    # Fast path: stats already cached — full to_dict is now free.
    if "_session_batch_stats" in inst:
        return rec.meta_dict()

    result: dict = {}
    for k in ("id", "name"):
        v = inst.get(k)
        if v is not None:
            result[k] = v

    t = inst.get("type")
    if t is not None:
        result["type"] = t.value if hasattr(t, "value") else str(t)

    path = inst.get("jsonl_path") or inst.get("_source_file") or ""

    if path:
        try:
            result["updated_date"] = datetime.fromtimestamp(
                _os.path.getmtime(path), tz=timezone.utc
            ).isoformat()
        except OSError:
            pass
        try:
            with open(path, "rb") as fh:
                first_line = fh.readline()
            entry = json.loads(first_line)
            ts = entry.get("timestamp")
            if ts:
                result["created_date"] = ts
        except Exception:
            pass

    result["status"] = "complete"

    mc = inst.get("message_count")
    if mc is not None:
        result["message_count"] = mc

    slug = inst.get("slug")
    if slug:
        result["slug"] = slug
    cwd = inst.get("cwd")
    if cwd:
        result["cwd"] = cwd

    return result

# ── Discovery / lookup ───────────────────────────────────────────────────────

def discover_claude_session_paths_iter(limit: int | None = None) -> Iterator[Path]:
    """Yield session JSONL paths under ``~/.claude/projects/<encoded>/*.jsonl``.

    Replaces ``ClaudeSessionRecord.discover_paths_iter``.
    """
    projects_dir = get_instance_settings().claude_projects_dir
    if not projects_dir.is_dir():
        return
    count = 0
    for project_dir in sorted(projects_dir.iterdir()):
        if not project_dir.is_dir():
            continue
        for jsonl_file in sorted(project_dir.glob("*.jsonl")):
            yield jsonl_file
            count += 1
            if limit is not None and count >= limit:
                return

def get_claude_session(uid: str, project: str | Path | None = None) -> FSRecord | None:
    """Resolve a session by session_id to its path + envelope. O(1) when ``project`` is the abs cwd.

    This is a path/envelope resolver, never a content reader: it extracts with
    ``include_content=False`` so it never runs the full ``worker_summary_log``
    transcript parse. Every caller reads only ``jsonl_path``/``cwd``/existence —
    none touch ``.content`` — and this method is reached from hot paths (e.g.
    ``transcript_descriptor``), so it must stay cheap.
    """
    projects_dir = get_instance_settings().claude_projects_dir
    if not projects_dir.is_dir():
        return None
    fname = f"{uid}.jsonl"

    if project:
        encoded = str(project).replace("/", "-")
        candidate = projects_dir / encoded / fname
        if candidate.exists():
            try:
                return extract_claude_session_from_path(candidate, include_content=False)
            except (json.JSONDecodeError, OSError):
                return None

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / fname
        if candidate.exists():
            try:
                return extract_claude_session_from_path(candidate, include_content=False)
            except (json.JSONDecodeError, OSError):
                continue
    return None
