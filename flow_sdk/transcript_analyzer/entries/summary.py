"""``SummaryEntry`` — auto-generated session summary."""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class SummaryEntry(TranscriptEntry):
    kind = EntryKind.SUMMARY

    def __init__(self, *, summary_text: str, **base: Any) -> None:
        super().__init__(**base)
        self.summary_text = summary_text

    def to_flow_data(self) -> list[FlowData]:
        # Summaries belong to the session metadata pane, not the chat stream.
        return []

    def to_dict(self) -> dict:
        return {**super().to_dict(), "summary_text": self.summary_text}

    def _body_lines(self) -> list[str]:
        return render_block("summary_text", self.summary_text)
