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
