"""``UsageEntry`` — per-stream token / request accounting.

Each chargeable stream emitted by an assistant turn becomes one entry: a
Claude turn with ``{input:30, output:12k, cache_read:50k, cache_write_1h:8k}``
produces four entries. The dimension axes (``io``, ``cache``, ``cache_tier``,
``reasoning``, ``tool``, ``unit``) form a key space that pairs cleanly with
``ItemPrice.dims`` in :mod:`flow_sdk.transcript_analyzer.pricing` — cost is
``count × matching rule.per_unit_usd`` per entry.

Why per-dim, not aggregate: every Anthropic / OpenAI price line maps to one
tuple in this space. Adding a new chargeable axis is a parser+price-table
change; downstream code (filters, summarizers, cost calc) stays the same.

Codex emits cumulative totals separately — see :class:`CodexUsageEntry`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from ..entry import EntryKind, TranscriptEntry
from ..pricing import pricing_for

if TYPE_CHECKING:
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData


IoLiteral = Literal["input", "output"]
CacheLiteral = Literal["none", "read", "write"]
CacheTierLiteral = Literal["none", "5m", "1h"]
UnitLiteral = Literal["token", "request"]


class UsageEntry(TranscriptEntry):
    """One chargeable stream (tokens or requests) emitted in a single turn.

    Identity:
      - ``model`` and ``timestamp`` come from the base envelope (set by the
        parser to the assistant message's model + timestamp).
      - All per-dim entries from the same turn share ``entry_id`` (the
        message's ``{message.id}:usage``); ``self.id`` is suffixed with
        ``:dim_<n>`` for uniqueness.

    Pricing match contract: ``pricing.ItemPrice.matches(self)`` does
    attribute equality on each key in ``dims``. Default ``cache="none"``
    and ``cache_tier="none"`` makes the bare-input rule (``cache="none"``)
    match every non-cache input entry without needing a wildcard.
    """

    kind = EntryKind.TOKEN_USAGE

    def __init__(
        self,
        *,
        count: int,
        io: IoLiteral,
        unit: UnitLiteral = "token",
        cache: CacheLiteral = "none",
        cache_tier: CacheTierLiteral = "none",
        reasoning: bool = False,
        tool: str | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.count = count
        self.io = io
        self.unit = unit
        self.cache = cache
        self.cache_tier = cache_tier
        self.reasoning = reasoning
        self.tool = tool

    def to_flow_data(self) -> list["FlowData"]:
        return []

    def to_dict(self) -> dict:
        # ``cost_usd`` is priced here, at the one place that owns the price
        # tables, so every client reads a cost instead of re-implementing the
        # rules. ``CodexUsageEntry`` carries ``count=0`` by construction, so a
        # cumulative carrier prices to 0.0 and never double-counts its per-dim
        # siblings.
        return {
            **super().to_dict(),
            "count": self.count,
            "io": self.io,
            "unit": self.unit,
            "cache": self.cache,
            "cache_tier": self.cache_tier,
            "reasoning": self.reasoning,
            "tool": self.tool,
            "cost_usd": round(pricing_for(self.model, self.worker).cost_of(self), 10),
        }

    def _body_lines(self) -> list[str]:
        parts: list[str] = [f"io={self.io}", f"count={self.count}", f"unit={self.unit}"]
        if self.cache != "none":
            parts.append(f"cache={self.cache}")
            if self.cache_tier != "none":
                parts.append(f"cache_tier={self.cache_tier}")
        if self.reasoning:
            parts.append("reasoning=true")
        if self.tool:
            parts.append(f"tool={self.tool}")
        return ["usage: " + " ".join(parts)]


class CodexUsageEntry(UsageEntry):
    """Codex-only: carries the cumulative per-session totals + turn_id.

    Codex emits these in the same ``token_count`` event_msg payload as the
    per-turn counts. They're useful for sanity-checking aggregate spend
    against per-entry sums but don't participate in cost arithmetic (the
    per-dim ``UsageEntry`` siblings emitted in the same turn do).
    """

    def __init__(
        self,
        *,
        total_input_tokens: int | None = None,
        total_output_tokens: int | None = None,
        turn_id: str | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.total_input_tokens = total_input_tokens
        self.total_output_tokens = total_output_tokens
        self.turn_id = turn_id

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "turn_id": self.turn_id,
        }

    def _body_lines(self) -> list[str]:
        lines = super()._body_lines()
        extra: list[str] = []
        if self.total_input_tokens is not None:
            extra.append(f"total_in={self.total_input_tokens}")
        if self.total_output_tokens is not None:
            extra.append(f"total_out={self.total_output_tokens}")
        if extra:
            lines.append("cumulative: " + " ".join(extra))
        if self.turn_id:
            lines.append(f"turn_id: {self.turn_id}")
        return lines
