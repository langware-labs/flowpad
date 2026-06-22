"""Walker + extractor + helpers for COPILOT_SESSION records.

Source: ``~/.copilot/session-state/<session_id>/events.jsonl`` — flat, one dir
per session, with the cwd in a sibling ``workspace.yaml``. Read-only — Copilot
owns the session-state tree; the indexer never writes back.

Mirrors ``codex_sessions.py`` but for Copilot's flat (non-date-sharded) layout.
The session id is the session-state directory name; metadata (cwd) is read via
the existing ``read_copilot_session_meta`` helper.

Public helpers:
- ``extract_copilot_session_from_path(path)`` — build a Record from an
  ``events.jsonl`` path.
- ``copilot_session_id(ref)`` — stable id = the session-state dir name.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def copilot_sessions_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        sessions_root = Path(node.path) / ".copilot" / "session-state"
        if not sessions_root.is_dir():
            continue
        for events in sessions_root.glob("*/events.jsonl"):
            out.append(
                FSRef(
                    events,
                    record_type=RecordType.COPILOT_SESSION,
                    parent=node,
                )
            )
    return out


def copilot_session_id(ref: FSRef) -> str:
    """Stable, filesystem-safe **UUID** id from the session-state directory name
    (already the session UUID in practice — kept as-is when conforming, else
    hashed with the same ``f"{type}:{key}"`` formula ``Entity.allocate_id`` uses
    so it matches the DB id)."""
    key = ref._path.parent.name
    return key if is_valid_entity_id(key) else mint_uuid(f"{RecordType.COPILOT_SESSION}:{key}", namespace=uuid.NAMESPACE_DNS)


def extract_copilot_session(ref: FSRef) -> list[FSRecord]:
    return [extract_copilot_session_from_path(ref._path)]


def extract_copilot_session_from_path(path: str | Path) -> FSRecord:
    """Build a Record from a Copilot ``events.jsonl`` path.

    Envelope fields (session id / cwd) come from ``read_copilot_session_meta``
    (workspace.yaml + first JSONL line). The searchable ``content`` (extractive
    transcript text for FTS) requires a full-transcript parse via
    ``worker_summary_log`` — gated by the indexer's skip-fresh check, so it only
    runs when the transcript has changed.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (  # noqa: PLC0415
        read_copilot_session_meta,
    )
    from flow_sdk.transcript_analyzer import worker_summary_log  # noqa: PLC0415
    from flow_sdk.transcript_analyzer.formats import TranscriptFormat  # noqa: PLC0415

    p = Path(path)
    # The directory name is the canonical session id (matches copilot_session_id,
    # so gen_id and the extracted record agree). cwd comes from workspace.yaml.
    session_id = p.parent.name
    cwd = str(read_copilot_session_meta(p).get("cwd") or "")

    content = worker_summary_log(
        p, "copilot", transcript_format=TranscriptFormat.COPILOT_EVENTS
    )

    rec = FSRecord(
        type=RecordType.COPILOT_SESSION,
        id=session_id,
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
