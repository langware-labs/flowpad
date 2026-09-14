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

from pathlib import Path

from flow_sdk.assets.types.copilot_sessions import COPILOT_EVENTS_FILENAME
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

# The fixed filename Copilot's own store uses inside each per-session dir. It is
# also what tells the two layouts apart: in Copilot's store the ID is the
# DIRECTORY name, whereas an installed (received) transcript is a flat
# ``<session_id>.jsonl`` whose directory is the shared ``transcripts`` folder.



def copilot_sessions_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    for node in nodes:
        sessions_root = Path(node.path) / ".copilot" / "session-state"
        if not sessions_root.is_dir():
            continue
        for events in sessions_root.glob(f"*/{COPILOT_EVENTS_FILENAME}"):
            out.append(
                FSRef(
                    events,
                    record_type=RecordType.COPILOT_SESSION,
                    parent=node,
                )
            )
    return out
