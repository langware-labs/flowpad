"""``MetaEntry`` — entries that carry no chat content and emit no FlowData.

Catch-all for control-plane lines we recognize but don't render in the chat
stream: deferred-tools attachments, file-history snapshots, queue ops,
custom title, PR link, codex session_meta / event_msg / token_count, etc.
``meta_kind`` carries the original type string for downstream filtering.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

from ..entry import EntryKind, TranscriptEntry


class MetaEntry(TranscriptEntry):
    kind = EntryKind.META

    def __init__(self, *, meta_kind: str, payload: dict | None = None, **base: Any) -> None:
        super().__init__(**base)
        self.meta_kind = meta_kind
        self.payload = payload or {}

    def to_flow_data(self) -> list[FlowData]:
        return []
