"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

COPILOT_EVENTS_FILENAME = "events.jsonl"


def copilot_session_identity_key(ref: FSRef | Path) -> str:
    """Stable, filesystem-safe **UUID** id for a Copilot transcript.

    The two layouts carry the id in different places, and the filename says
    which one this is: Copilot's own store names the *directory*
    (``<session_id>/events.jsonl``), while an installed (received) transcript is
    a flat file named for the id (``.github/transcripts/<session_id>.jsonl``) —
    there the parent is the literal ``transcripts``, which would collapse every
    installed transcript onto a single id. A non-conforming key is hashed with
    the same ``f"{type}:{key}"`` formula ``Entity.allocate_id`` uses, so it
    matches the DB id.
    """
    path = Path(getattr(ref, "_path", ref))
    return path.parent.name if path.name == COPILOT_EVENTS_FILENAME else path.stem


def copilot_session_id_from_file(ref: FSRef | Path) -> str | None:
    key = copilot_session_identity_key(ref)
    return key if is_valid_entity_id(key) else None


def extract_copilot_session(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    return [extract_copilot_session_from_path(ref._path, resolved_id=resolved_id)]


def extract_copilot_session_from_path(path: str | Path, *, resolved_id: str | None = None) -> FSRecord:
    """Build a Record from a Copilot ``events.jsonl`` path.

    Envelope fields (session id / cwd) come from ``read_copilot_session_meta``
    (workspace.yaml + first JSONL line). The searchable ``content`` (extractive
    transcript text for FTS) requires a full-transcript parse via
    ``worker_summary_log`` — gated by the indexer's skip-fresh check, so it only
    runs when the transcript has changed.
    """
    from flow_sdk.assets.types.copilot_meta import read_copilot_session_meta
    from flow_sdk.transcript_analyzer import worker_summary_log  # noqa: PLC0415
    from flow_sdk.transcript_analyzer.formats import TranscriptFormat  # noqa: PLC0415

    p = Path(path)
    # Same key the walker's gen_id uses, so the id and the extracted record
    # agree in both layouts (own store: dir name; installed: file stem).
    session_id = copilot_session_identity_key(p)
    cwd = str(read_copilot_session_meta(p).get("cwd") or "")

    content = worker_summary_log(p, "copilot", transcript_format=TranscriptFormat.COPILOT_EVENTS)

    rec = FSRecord(
        type=RecordType.COPILOT_SESSION,
        id=resolved_id or session_id,
        name=session_id,
        session_id=session_id,
        cwd=cwd,
        jsonl_path=str(p),
        worker_type="copilot",
        source_file=str(p),
        path=str(p),
        content=content,
    )
    # Read-only marker — session-state is owned by Copilot.
    object.__setattr__(rec, "_asset_ref", FSRef(p, read_only=True))
    return rec
