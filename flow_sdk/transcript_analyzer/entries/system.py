"""``SystemEntry`` — system / progress / control-plane events.

Folds:
  * Claude ``type=="system"`` lines (``subtype`` = turn_duration, api_error,
    stop_hook_summary, compact_boundary, …).
  * Claude ``type=="progress"`` lines (``subtype`` = data.type — hook_progress,
    bash_progress, tool_use, …).
  * Codex stream-event control lines (``subtype`` = thread.started,
    turn.started, turn.completed).
"""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

from ..entry import EntryKind, TranscriptEntry


class SystemEntry(TranscriptEntry):
    kind = EntryKind.SYSTEM

    def __init__(self, *, subtype: str, payload: dict | None = None, **base: Any) -> None:
        super().__init__(**base)
        self.subtype = subtype
        # Optional structured payload (e.g. usage counters from
        # ``turn.completed``, hook fields from progress lines). Parsers fill
        # this; ``to_flow_data()`` ignores it because system events are not
        # rendered into the chat timeline.
        self.payload = payload or {}

    def to_flow_data(self) -> list[FlowData]:
        # System / progress events are not surfaced in the FlowData stream.
        return []
