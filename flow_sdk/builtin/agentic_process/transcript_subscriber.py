"""TranscriptStreamer subscriber that bridges per-session deltas to the
matching :class:`AgenticProcess`.

This is the upper-layer adapter that ties the lower-layer streamer (no entity
knowledge) to AP-aware logic. Loaded during ``load_entities()`` (AP package
import time), so the subscriber is registered well before the FSOp watcher
fires its first event.

The dispatch contract:
    - Streamer calls every registered subscriber with
      ``(session_id, jsonl_path, new_entries)``.
    - We resolve the AgenticProcess by ``session_id``; if none exists, the
      file is from an unmanaged session (e.g. a transcript on disk with no
      paired AP) and we no-op.
    - The AP's :meth:`on_transcript_change` handles per-entry routing.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from flow_sdk.transcript_streamer.registry import transcript_streamer_registry

if TYPE_CHECKING:
    from flow_sdk.transcript_analyzer.entry import TranscriptEntry

_log = logging.getLogger(__name__)


async def _route_to_ap(
    session_id: str,
    jsonl_path: Path,
    new_entries: list["TranscriptEntry"],
) -> None:
    """Resolve the AP for this session_id and forward the delta to it."""
    if not session_id:
        return
    # Lazy import: AgenticProcess module loads this submodule at import time,
    # so a top-level import would cycle.
    from flow_sdk.builtin.agentic_process import AgenticProcess

    try:
        aps = await AgenticProcess.get_all(
            entities_filter=QueryFilter(match=ExpressionNode(session_id=session_id))
        )
    except Exception:
        _log.exception("transcript_subscriber: AP lookup failed for session %s", session_id)
        return
    if not aps:
        # Unmanaged session — transcript exists but no AP paired with it.
        return
    # Dispatch to every matching AP (forked / shared sessions are rare but
    # real — same JSONL can back multiple AgenticProcess entities).
    for ap in aps:
        try:
            await ap.on_transcript_change(jsonl_path, new_entries)
        except Exception:
            _log.exception(
                "transcript_subscriber: on_transcript_change raised on AP %s", ap.id
            )


# Register at module load. The AP package's __init__ imports this submodule
# so the subscriber is in place before the FSOp watcher dispatches anything.
transcript_streamer_registry.subscribe("agentic_process", _route_to_ap)
