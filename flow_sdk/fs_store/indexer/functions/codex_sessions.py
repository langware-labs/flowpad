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

from flow_sdk.assets.types.codex_sessions import _iter_head_json, extract_codex_session_from_path
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._codex_session_stats import (
    _get_codex_session_batch_stats,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings

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














def ensure_codex_session_stats(rec: FSRecord) -> FSRecord:
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
