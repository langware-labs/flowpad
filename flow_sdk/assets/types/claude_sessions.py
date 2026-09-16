"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

_HEAD_LINES = 64


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


def claude_session_identity_key(ref: FSRef | Path) -> str:
    """Stable, filesystem-safe **UUID** id = sessionId from the JSONL head
    envelope (fallback: filename stem). Claude session ids are already UUIDs so
    they're kept as-is; anything non-conforming is hashed with the same
    ``f"{type}:{key}"`` formula ``Entity.allocate_id`` uses, so it matches the DB
    id."""
    path = Path(getattr(ref, "_path", ref))
    key = path.stem
    try:
        for raw in _iter_head_json(path):
            sid = raw.get("sessionId")
            if sid:
                key = str(sid)
                break
    except OSError:
        pass
    return key


def claude_session_id_from_file(ref: FSRef | Path) -> str | None:
    key = claude_session_identity_key(ref)
    return key if is_valid_entity_id(key) else None


def extract_claude_session(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a JSONL session into a Record. Replaces ``ClaudeSessionRecord._from_fsref_sync``."""
    return [extract_claude_session_from_path(ref._path, resolved_id=resolved_id)]


def extract_claude_session_from_path(
    path: str | Path,
    *,
    include_content: bool = True,
    resolved_id: str | None = None,
) -> FSRecord:
    """Build a Record from a JSONL transcript path.

    Envelope fields are read cheaply: first ``_HEAD_LINES`` lines for
    session_id / slug / cwd; title metadata is scanned once and read
    incrementally thereafter, with explicit custom titles taking precedence. The searchable ``content`` (extractive transcript text for
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

    from flow_sdk.assets.types.claude_titles import read_claude_title

    title = read_claude_title(path)
    custom_title = title.title if title else ""

    name = custom_title or slug or session_id

    # Extractive transcript text for full-text search (worker-generic).
    content = ""
    if include_content:
        from flow_sdk.transcript_analyzer import worker_summary_log  # noqa: PLC0415
        content = worker_summary_log(path, "claude")

    rec = FSRecord(
        type=RecordType.CLAUDE_SESSION,
        id=resolved_id or session_id,
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
