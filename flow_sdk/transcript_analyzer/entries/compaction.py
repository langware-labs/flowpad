"""``CompactionEntry`` — a context compaction / summarization boundary.

Compaction is a first-class agentic primitive: the worker resets its context
window and carries a compressed summary forward (a checkpoint + resume). It is
normalized across workers so the call-stack/report can show context resets:

* **Claude** writes a line with ``isCompactSummary: true`` (the summary that
  survives the reset); a manual ``/compact`` slash command is the trigger.
* **Codex** emits a ``response_item`` with ``type="compacted"``.
* **Copilot** has no compaction concept.

In the context-control taxonomy this is ``context_policy="compact"`` /
``control_policy="resume"`` — see ``callable_taxonomy.py``.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class CompactionEntry(TranscriptEntry):
    kind = EntryKind.COMPACTION

    def __init__(
        self,
        *,
        trigger: str = "auto",  # "auto" | "manual"
        summary_preview: str = "",
        pre_tokens: int | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.trigger = trigger
        self.summary_preview = summary_preview
        self.pre_tokens = pre_tokens

    def to_flow_data(self) -> list[FlowData]:
        # Compaction belongs to the session-structure pane, not the chat stream.
        return []

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "trigger": self.trigger,
            "summary_preview": self.summary_preview,
            "pre_tokens": self.pre_tokens,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = [f"trigger: {self.trigger}"]
        if self.pre_tokens is not None:
            out.append(f"pre_tokens: {self.pre_tokens}")
        if self.summary_preview:
            out.extend(render_block("summary_preview", self.summary_preview))
        return out
