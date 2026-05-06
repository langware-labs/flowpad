"""Codex session collector — enumerates rollout JSONL transcripts.

Mirrors the two-phase pattern from ``session_collector.get_recent_sessions()``:
  1. Stat-only walk (no parsing) to collect ``(mtime, path, cwd)`` triples,
     newest first; apply per-project / global limits.
  2. Parse only the top-N selected files via ``CodexSessionFsRecord``'s lazy
     stats (quick=True) or a fuller parse (quick=False).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from flow_sdk.fs_records.codex import CodexSessionRecord
from flow_sdk.fs_records.codex.codex_project import _codex_project_id

from ..utils import _codex_sessions_dir


def _quick_meta(jsonl_path: Path) -> dict | None:
    """Return ``(cwd, originator, version, model, msg_count, last_user_message)``
    by reading only the head + tail of the rollout. Falls back to None when the
    file isn't a valid rollout (no session_meta in head).
    """
    try:
        size = jsonl_path.stat().st_size
        with open(jsonl_path, "rb") as fh:
            head = fh.read(8192).decode("utf-8", errors="replace")
    except OSError:
        return None

    cwd = ""
    originator = ""
    version = ""
    session_id = ""
    saw_meta = False
    for line in head.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            break
        if raw.get("type") == "session_meta":
            payload = raw.get("payload") or {}
            cwd = str(payload.get("cwd") or "")
            originator = str(payload.get("originator") or "")
            version = str(payload.get("cli_version") or "")
            session_id = str(payload.get("id") or "")
            saw_meta = True
            break
        if raw.get("type") == "thread.started":
            session_id = str(raw.get("thread_id") or "")
            saw_meta = True
            break

    if not saw_meta:
        return None

    # Tail: count user/assistant messages by raw byte search (fast).
    try:
        raw = jsonl_path.read_bytes()
        user_messages = raw.count(b'"role":"user"') + raw.count(b'"role": "user"')
        assistant_messages = (
            raw.count(b'"role":"assistant"') + raw.count(b'"role": "assistant"')
        )
        # Stream-event shape uses agent_message — count as assistant.
        assistant_messages += raw.count(b'"type":"agent_message"') + raw.count(
            b'"type": "agent_message"'
        )
    except OSError:
        user_messages = 0
        assistant_messages = 0

    try:
        modified_at = datetime.fromtimestamp(jsonl_path.stat().st_mtime).isoformat()
    except OSError:
        modified_at = None

    return {
        "session_id": session_id or jsonl_path.stem,
        "cwd": cwd,
        "originator": originator,
        "version": version,
        "user_messages": user_messages,
        "assistant_messages": assistant_messages,
        "message_count": user_messages + assistant_messages,
        "modified_at": modified_at,
        "size_bytes": size,
    }


def get_codex_session_info_quick(jsonl_path: Path) -> dict | None:
    """Quick session info: head/tail only. Returns the collector-shape dict."""
    if not jsonl_path.exists():
        return None
    meta = _quick_meta(jsonl_path)
    if meta is None:
        return None
    cwd = meta["cwd"] or ""
    project_id = f"codex_project:{_codex_project_id(cwd)}" if cwd else None
    return {
        "id": meta["session_id"],
        "session_id": meta["session_id"],
        "type": "codex_session",
        "worker_type": "codex",
        "name": meta["session_id"],
        "scope": "user",
        "source_file": str(jsonl_path),
        "path": str(jsonl_path),
        "cwd": cwd,
        "modified_at": meta["modified_at"],
        "created_at": None,  # filled by slow path
        "project_id": project_id,
        "size_bytes": meta["size_bytes"],
        "message_count": meta["message_count"],
        "user_messages": meta["user_messages"],
        "assistant_messages": meta["assistant_messages"],
        "tool_uses": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "estimated_cost_usd": 0.0,
        "originator": meta["originator"],
        "version": meta["version"],
        "model": None,
        "primary_model": None,
        "models_used": [],
        "last_user_message": None,
        "last_stop_reason": None,
    }


def get_codex_session_info(jsonl_path: Path) -> dict | None:
    """Full session info via ``CodexSessionRecord`` lazy stats (slow path)."""
    if not jsonl_path.exists():
        return None
    try:
        rec = CodexSessionRecord.from_jsonl(jsonl_path)
    except (json.JSONDecodeError, OSError):
        return None
    cwd = rec.cwd or ""
    project_id = f"codex_project:{_codex_project_id(cwd)}" if cwd else None
    if rec.message_count == 0:
        return None
    return {
        "id": rec.session_id,
        "session_id": rec.session_id,
        "type": "codex_session",
        "worker_type": "codex",
        "name": rec.last_user_message or rec.session_id,
        "scope": "user",
        "source_file": str(jsonl_path),
        "path": str(jsonl_path),
        "cwd": cwd,
        "modified_at": rec.modified_at,
        "created_at": rec.created_at,
        "project_id": project_id,
        "size_bytes": jsonl_path.stat().st_size,
        "message_count": rec.message_count,
        "user_messages": rec.user_message_count,
        "assistant_messages": rec.assistant_message_count,
        "tool_uses": rec.tool_uses,
        "input_tokens": rec.input_tokens,
        "output_tokens": rec.output_tokens,
        "cache_read_input_tokens": rec.cache_read_input_tokens,
        "estimated_cost_usd": rec.estimated_cost_usd,
        "originator": rec.originator,
        "version": rec.version,
        "model": rec.model,
        "primary_model": rec.primary_model,
        "models_used": rec.models_used or [],
        "approval_policy": rec.approval_policy,
        "sandbox_policy": rec.sandbox_policy,
        "effort": rec.effort,
        "personality": rec.personality,
        "last_user_message": rec.last_user_message,
        "last_stop_reason": rec.last_stop_reason,
    }


def get_recent_codex_sessions(
    limit: int = 10,
    per_project_limit: int = 0,
    quick: bool = True,
) -> list[dict]:
    """Recent rollouts across all Codex projects.

    Two-phase: stat-only mtime walk → slice → parse only selected files.
    """
    sessions_root = _codex_sessions_dir()
    if not sessions_root.is_dir():
        return []

    file_entries: list[tuple[float, Path]] = []
    for p in sessions_root.rglob("rollout-*.jsonl"):
        try:
            file_entries.append((p.stat().st_mtime, p))
        except OSError:
            continue

    if per_project_limit > 0:
        # Group by quick-scanned cwd, keep newest N per project.
        per_project: dict[str, list[tuple[float, Path]]] = {}
        for mtime, p in file_entries:
            meta = _quick_meta(p)
            cwd = (meta or {}).get("cwd") or ""
            per_project.setdefault(cwd, []).append((mtime, p))
        file_entries = []
        for cwd, items in per_project.items():
            items.sort(key=lambda x: x[0], reverse=True)
            file_entries.extend(items[:per_project_limit])

    file_entries.sort(key=lambda x: x[0], reverse=True)
    if limit > 0:
        file_entries = file_entries[:limit]

    info_fn = get_codex_session_info_quick if quick else get_codex_session_info
    out: list[dict] = []
    for _, p in file_entries:
        info = info_fn(p)
        if info:
            out.append(info)
    out.sort(key=lambda x: x.get("modified_at") or "", reverse=True)
    return out
