"""``TokenUsageEntry`` — per-line token accounting.

Both Claude and Codex emit usage on assistant turns. Claude attaches
``message.usage`` to assistant content lines; Codex emits a standalone
``event_msg`` of type ``token_count`` with ``info.last_token_usage`` and
``info.total_token_usage``.

This entry kind exists so that callers (cost dashboards, summarizers) can
filter on ``EntryKind.TOKEN_USAGE`` without scanning every assistant line
for a nested ``usage`` field. It does not render into the chat stream
(``to_flow_data`` returns ``[]``).
"""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

from ..entry import EntryKind, TranscriptEntry


class TokenUsageEntry(TranscriptEntry):
    kind = EntryKind.TOKEN_USAGE

    def __init__(
        self,
        *,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        cached_input_tokens: int | None = None,
        cache_read_tokens: int | None = None,
        cache_creation_tokens: int | None = None,
        reasoning_output_tokens: int | None = None,
        total_input_tokens: int | None = None,
        total_output_tokens: int | None = None,
        turn_id: str | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        # `cached_input_tokens` is the legacy single-value field (read OR
        # creation, whichever was reported). Kept for back-compat.
        # `cache_read_tokens` and `cache_creation_tokens` are the disaggregated
        # form Claude actually emits — both are independently meaningful for
        # cost dashboards (read = cheap hit; creation = wrote new prompt block).
        self.cached_input_tokens = cached_input_tokens
        self.cache_read_tokens = cache_read_tokens
        self.cache_creation_tokens = cache_creation_tokens
        self.reasoning_output_tokens = reasoning_output_tokens
        # ``total_*`` are codex-specific cumulative counters (per-turn vs
        # per-session). Claude's ``message.usage`` only carries per-turn
        # numbers — totals stay None there.
        self.total_input_tokens = total_input_tokens
        self.total_output_tokens = total_output_tokens
        self.turn_id = turn_id

    def to_flow_data(self) -> list[FlowData]:
        return []

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_creation_tokens": self.cache_creation_tokens,
            "reasoning_output_tokens": self.reasoning_output_tokens,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "turn_id": self.turn_id,
        }

    def _body_lines(self) -> list[str]:
        parts: list[str] = []
        if self.input_tokens is not None:
            parts.append(f"in={self.input_tokens}")
        if self.output_tokens is not None:
            parts.append(f"out={self.output_tokens}")
        if self.cache_read_tokens is not None:
            parts.append(f"cache_read={self.cache_read_tokens}")
        if self.cache_creation_tokens is not None:
            parts.append(f"cache_create={self.cache_creation_tokens}")
        if self.cache_read_tokens is None and self.cache_creation_tokens is None and self.cached_input_tokens is not None:
            parts.append(f"cached={self.cached_input_tokens}")
        if self.reasoning_output_tokens is not None:
            parts.append(f"reasoning={self.reasoning_output_tokens}")
        if self.total_input_tokens is not None:
            parts.append(f"total_in={self.total_input_tokens}")
        if self.total_output_tokens is not None:
            parts.append(f"total_out={self.total_output_tokens}")
        out: list[str] = []
        if parts:
            out.append("tokens: " + " ".join(parts))
        if self.turn_id:
            out.append(f"turn_id: {self.turn_id}")
        return out
