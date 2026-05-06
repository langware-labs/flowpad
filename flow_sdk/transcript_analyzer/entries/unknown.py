"""``UnknownEntry`` — an entry the parser couldn't classify.

Constructor emits a ``warnings.warn`` so the gap shows up in CI / dev runs
without losing the line. ``raw_data`` carries the original JSONL dict so
downstream code can inspect or migrate.
"""

from __future__ import annotations

import warnings
from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class UnknownEntry(TranscriptEntry):
    kind = EntryKind.UNKNOWN

    def __init__(self, *, raw_data: dict, **base: Any) -> None:
        # Force-populate raw_data on this kind regardless of caller — the
        # whole point of UnknownEntry is preserving the unparsed line.
        base["raw_data"] = raw_data
        super().__init__(**base)
        warnings.warn(
            f"transcript_analyzer: unknown entry type "
            f"{(raw_data or {}).get('type')!r} (worker={self.worker})",
            stacklevel=3,
        )

    def to_flow_data(self) -> list[FlowData]:
        # Unknowns don't render — the warn is the audit trail.
        return []

    def to_dict(self) -> dict:
        return {**super().to_dict(), "raw_data": self.raw_data}

    def _body_lines(self) -> list[str]:
        return render_block("raw_data", self.raw_data)
