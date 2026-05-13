"""``ItemPrice`` / ``ModelPricing`` — cost dot-product over per-dim usage entries.

A model's price table is an ordered list of ``ItemPrice`` rules. Each rule
specifies a dimension match against a ``UsageEntry`` plus a per-unit USD rate.
Cost for one entry = ``entry.count * rule.per_unit_usd`` for the first
matching rule (or 0.0 if none match). ``ModelPricing.cost(entries)`` sums.

Dimensions live on ``UsageEntry``: ``io``, ``cache``, ``cache_tier``,
``reasoning``, ``tool``, ``unit``. A missing key in ``ItemPrice.dims`` is a
wildcard — it matches any value of that dim. Specific dims should be listed
first so they win over wildcards (first-match-wins).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Iterable, Mapping

if TYPE_CHECKING:
    from ..entries.usage import UsageEntry


@dataclass(frozen=True)
class ItemPrice:
    """One row in a model's price table.

    ``dims`` is matched against attributes on a ``UsageEntry`` by equality.
    Keys absent from ``dims`` are wildcards (match any value). Use specific
    matches first; rules are evaluated in order and first-match-wins.
    """

    dims: Mapping[str, object]
    per_unit_usd: float

    def matches(self, entry: "UsageEntry") -> bool:
        for k, expected in self.dims.items():
            actual = getattr(entry, k, None)
            if actual != expected:
                return False
        return True


@dataclass(frozen=True)
class ModelPricing:
    """Price table for one model. First-match-wins evaluation."""

    model: str
    items: tuple[ItemPrice, ...]

    def cost_of(self, entry: "UsageEntry") -> float:
        for rule in self.items:
            if rule.matches(entry):
                return entry.count * rule.per_unit_usd
        return 0.0

    def cost(self, entries: Iterable["UsageEntry"]) -> float:
        return sum(self.cost_of(e) for e in entries)
