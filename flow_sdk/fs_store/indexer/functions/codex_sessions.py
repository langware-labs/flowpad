"""Walker + extractor + helpers for CODEX_SESSION records.

Source: ``$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl``
(default ``~/.codex/sessions/...``). First JSONL line is ``session_meta`` with
``payload.id`` (= thread_id), ``payload.cwd``, ``payload.cli_version``,
``payload.originator``.

Replaces the deleted ``CodexSessionRecord`` subclass. Read-only — rollouts are
owned by Codex itself; the indexer never writes back.

Public helpers used outside the indexer:
- ``extract_codex_session_from_path(path)`` — build a Record from a JSONL path
  (replaces ``CodexSessionRecord.from_jsonl``).
- ``discover_codex_session_paths_iter(limit)`` — yield rollout paths
  newest-first (replaces ``CodexSessionRecord.discover_paths_iter``).
- ``get_codex_session(uid, date_path=None)`` — find a session by thread_id
  (replaces ``CodexSessionRecord.get``).
- ``ensure_codex_session_stats(rec)`` — lazy-populate all stat fields onto
  the Record (replaces ``_CodexSessionStatsProp`` descriptor on-attr-access).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.indexer.functions._codex_session_stats import (
    _get_codex_session_batch_stats,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings

_HEAD_LINES = 64

# Fields the lazy stats parser populates on the record. Used by
# ensure_codex_session_stats() to mirror dict→attrs.
_STAT_FIELDS = (
    "session_id", "cwd", "version", "originator", "git_branch",
    "model", "effort", "personality", "approval_policy", "sandbox_policy",
    "message_count", "user_message_count", "assistant_message_count", "tool_uses",
    "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens",
    "last_user_message", "last_assistant_message", "last_stop_reason",
    "modified_at", "created_at",
    "estimated_cost_usd", "models_used", "primary_model",
    "worker_type",
)


def codex_sessions_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        sessions_root = Path(node.path) / ".codex" / "sessions"
        if not sessions_root.is_dir():
            continue
        for jsonl in sessions_root.rglob("rollout-*.jsonl"):
            # Sub-agent threads are not sessions — see rollout_thread_source.
            if is_subagent_rollout(jsonl):
                continue
            out.append(
                FSRef(
                    jsonl,
                    record_type=RecordType.CODEX_SESSION,
                    parent=node,
                )
            )
    return out


def _iter_head_json(path: Path) -> Iterator[dict]:
    """Yield parsed JSON envelopes from the first _HEAD_LINES JSONL lines."""
    with open(path, encoding="utf-8") as fh:
        for _, line in zip(range(_HEAD_LINES), fh):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _extract_thread_id(filename: str) -> str | None:
    """Pull the thread_id off a Codex rollout filename.

    Filename pattern: ``rollout-<ISO-timestamp>-<thread_id>.jsonl``. The
    thread_id is a UUID — last 5 hyphen-separated groups of the stem.
    """
    stem = filename
    if stem.endswith(".jsonl"):
        stem = stem[: -len(".jsonl")]
    if not stem.startswith("rollout-"):
        return None
    parts = stem[len("rollout-"):].split("-")
    if len(parts) < 5:
        return None
    return "-".join(parts[-5:])


def rollout_thread_source(path: str | Path) -> str:
    """``session_meta.thread_source`` for a rollout — ``"subagent"`` for a
    thread Codex spawned under a parent, ``"user"`` for a top-level session,
    ``""`` when the header does not say.

    A sub-agent rollout lives in the same directory, under the same
    ``rollout-<ts>-<thread_id>.jsonl`` name, as a real session, so the header is
    the only thing that separates them. Codex refuses ``resume`` on a sub-agent
    ("cannot resume an unloaded multi-agent v2 sub-agent through its parent"),
    so anything that offers sessions for resume must consult this first.
    """
    try:
        for raw in _iter_head_json(Path(path)):
            if (raw.get("type") or "") == "session_meta":
                payload = raw.get("payload") or {}
                declared = payload.get("thread_source")
                if declared:
                    return str(declared)
                # Older rollouts predate ``thread_source`` but still carry the
                # spawn edge, which is equally conclusive.
                source = payload.get("source")
                spawned = bool(payload.get("parent_thread_id")) or (
                    isinstance(source, dict) and "subagent" in source
                )
                return "subagent" if spawned else ""
    except (OSError, json.JSONDecodeError):
        pass
    return ""


def is_subagent_rollout(path: str | Path) -> bool:
    """True when this rollout is a Codex sub-agent thread, not a session."""
    return rollout_thread_source(path) == "subagent"


def codex_session_identity_key(ref: FSRef | Path) -> str:
    """Stable, filesystem-safe **UUID** id = session_meta payload.id (the
    thread_id). The thread_id is already a UUID so it's kept as-is; any
    non-conforming fallback is hashed with the same ``f"{type}:{key}"`` formula
    ``Entity.allocate_id`` uses, so it matches the DB id."""
    path = Path(getattr(ref, "_path", ref))
    key = None
    try:
        for raw in _iter_head_json(path):
            if raw.get("type") == "session_meta":
                payload = raw.get("payload") or {}
                if payload.get("id"):
                    key = str(payload["id"])
                    break
            if raw.get("type") == "thread.started" and raw.get("thread_id"):
                key = str(raw["thread_id"])
                break
    except OSError:
        pass
    if key is None:
        key = _extract_thread_id(path.name) or path.stem
    return key


def codex_session_id_from_file(ref: FSRef | Path) -> str | None:
    key = codex_session_identity_key(ref)
    return key if is_valid_entity_id(key) else None


def extract_codex_session(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a rollout JSONL into a Record (head fields only — stats lazy)."""
    return [extract_codex_session_from_path(ref._path, resolved_id=resolved_id)]


def extract_codex_session_from_path(
    path: str | Path,
    *,
    include_content: bool = True,
    resolved_id: str | None = None,
) -> FSRecord:
    """Build a Record from a rollout JSONL path.

    Envelope fields (session_id / cwd / version / originator) are read from the
    first few lines only. The searchable ``content`` (extractive transcript
    text for FTS) requires a full-transcript parse via ``worker_summary_log`` —
    gated by the indexer's skip-fresh check, so it only runs when the rollout
    has changed. Stats are not populated here — call
    ``ensure_codex_session_stats(rec)`` to lazy-load them.

    Listing callers that hit many rollouts per request (e.g. worker history)
    must pass ``include_content=False`` — they have no skip-fresh gate, and the
    full ``worker_summary_log`` parse per file starves the server (the parsed
    ``content`` is unused by those callers). Mirrors
    ``extract_claude_session_from_path``.

    Replaces ``CodexSessionRecord.from_jsonl``.
    """
    p = Path(path)
    session_id = _extract_thread_id(p.name) or p.stem
    cwd = ""
    version = ""
    originator = ""
    thread_source = ""

    try:
        for raw in _iter_head_json(p):
            rtype = raw.get("type") or ""
            if rtype == "session_meta":
                payload = raw.get("payload") or {}
                if payload.get("id"):
                    session_id = str(payload["id"])
                if not cwd and payload.get("cwd"):
                    cwd = str(payload["cwd"])
                if not version and payload.get("cli_version"):
                    version = str(payload["cli_version"])
                if not originator and payload.get("originator"):
                    originator = str(payload["originator"])
                if not thread_source and payload.get("thread_source"):
                    thread_source = str(payload["thread_source"])
            elif rtype == "thread.started" and raw.get("thread_id"):
                session_id = str(raw["thread_id"])
    except OSError:
        pass

    # Extractive transcript text for full-text search (worker-generic). Skipped
    # for listing callers (include_content=False) — the full-transcript parse is
    # the dominant cost and they don't read `content`.
    content = ""
    if include_content:
        from flow_sdk.transcript_analyzer import worker_summary_log  # noqa: PLC0415
        content = worker_summary_log(p, "codex")

    rec = FSRecord(
        type=RecordType.CODEX_SESSION,
        id=resolved_id or session_id,
        name=session_id,
        session_id=session_id,
        cwd=cwd,
        version=version,
        originator=originator,
        thread_source=thread_source,
        jsonl_path=str(p),
        worker_type="codex",
        source_file=str(p),
        path=str(p),
        content=content,
    )
    # Read-only marker — rollouts are owned by Codex.
    object.__setattr__(rec, "_asset_ref", FSRef(p, read_only=True))
    return rec


def ensure_codex_session_stats(rec: Record) -> FSRecord:
    """Populate lazy stat fields onto the record. Idempotent.

    Replaces the ``_CodexSessionStatsProp`` descriptor: instead of triggering
    on attribute access, callers invoke this explicitly before reading any
    field beyond the head set (cwd, session_id, version, originator).
    """
    stats = _get_codex_session_batch_stats(rec)
    for field in _STAT_FIELDS:
        if field in stats:
            value = stats[field]
            # Don't clobber head fields with empty stat values.
            existing = object.__getattribute__(rec, "__dict__").get(field)
            if value or not existing:
                object.__getattribute__(rec, "__dict__")[field] = value
    return rec


def discover_codex_session_paths_iter(limit: int | None = None) -> Iterator[Path]:
    """Yield rollout JSONL paths newest-first by date dir.

    Replaces ``CodexSessionRecord.discover_paths_iter``.
    """
    sessions_root = get_instance_settings().codex_sessions_dir
    if not sessions_root.is_dir():
        return
    count = 0
    for year_dir in sorted(sessions_root.iterdir(), reverse=True):
        if not year_dir.is_dir():
            continue
        for month_dir in sorted(year_dir.iterdir(), reverse=True):
            if not month_dir.is_dir():
                continue
            for day_dir in sorted(month_dir.iterdir(), reverse=True):
                if not day_dir.is_dir():
                    continue
                for jsonl_file in sorted(day_dir.glob("rollout-*.jsonl"), reverse=True):
                    yield jsonl_file
                    count += 1
                    if limit is not None and count >= limit:
                        return


def get_codex_session(uid: str, date_path: str | None = None) -> FSRecord | None:
    """Find a session by thread_id (suffix-match against rollout filenames).

    Codex stores rollouts as ``rollout-<ts>-<thread_id>.jsonl`` so a suffix
    scan is O(N) over rollout files. Pass ``date_path="YYYY/MM/DD"`` for an
    O(1) lookup when the date is known.

    Like ``get_claude_session``, this is a path/envelope resolver, never a
    content reader: it extracts with ``include_content=False`` so it never runs
    the full ``worker_summary_log`` transcript parse. Its only caller
    (``_resolve_session_record``, behind ``terminals/get_by_worker_id``) reads
    ``cwd``/``name``/existence and never touches ``.content``, while the parse
    it was paying for dominated the call — 205ms with it, 10ms without, on a
    256KB rollout. A caller that genuinely wants ``content`` should reach for
    ``extract_codex_session_from_path`` directly.
    """
    sessions_root = get_instance_settings().codex_sessions_dir
    if not sessions_root.is_dir():
        return None
    suffix = f"-{uid}.jsonl"

    if date_path:
        day = sessions_root / date_path
        if day.is_dir():
            for p in day.glob("rollout-*.jsonl"):
                if p.name.endswith(suffix):
                    if is_subagent_rollout(p):
                        return None
                    try:
                        return extract_codex_session_from_path(p, include_content=False)
                    except (json.JSONDecodeError, OSError):
                        return None

    for p in sessions_root.rglob("rollout-*.jsonl"):
        if p.name.endswith(suffix):
            # A sub-agent thread is not resumable: handing its id to
            # ``codex resume`` exits 1 and the start latch retries forever.
            # A miss is the correct answer here, exactly like an unknown id.
            if is_subagent_rollout(p):
                return None
            try:
                return extract_codex_session_from_path(p, include_content=False)
            except (json.JSONDecodeError, OSError):
                continue
    return None
