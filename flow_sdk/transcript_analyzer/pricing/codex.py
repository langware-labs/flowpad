"""Codex / OpenAI model price tables.

Skeleton — rates need verification against OpenAI's public pricing page at
implementation time. The schema mirrors :mod:`pricing.claude` so the
``UsageEntry`` dimension contract is identical across workers.
"""

from __future__ import annotations

from .base import ItemPrice, ModelPricing

_M = 1_000_000


def _openai_pricing(
    model: str,
    base_in: float,
    base_out: float,
    cached_in: float | None = None,
) -> ModelPricing:
    """Cached input on OpenAI is a flat rate, not a multiplier."""
    items: list[ItemPrice] = []
    if cached_in is not None:
        items.append(ItemPrice({"io": "input", "cache": "read"}, cached_in / _M))
    items.extend([
        ItemPrice({"io": "input", "cache": "none"}, base_in / _M),
        # Reasoning tokens are billed at the output rate on OpenAI.
        ItemPrice({"io": "output"}, base_out / _M),
    ])
    return ModelPricing(model=model, items=tuple(items))


# Placeholder rates. Update against OpenAI's published table when codex
# transcripts come into active cost-reporting scope.
GPT_5 = _openai_pricing("gpt-5", 2.50, 10.00, cached_in=1.25)
GPT_5_MINI = _openai_pricing("gpt-5-mini", 0.25, 2.00, cached_in=0.125)


CODEX_PRICING: dict[str, ModelPricing] = {
    "gpt-5": GPT_5,
    "gpt-5-mini": GPT_5_MINI,
}


_DEFAULT = GPT_5


def pricing_for(model: str | None) -> ModelPricing:
    if not model:
        return _DEFAULT
    if model in CODEX_PRICING:
        return CODEX_PRICING[model]
    for key, table in CODEX_PRICING.items():
        if key in model or model in key:
            return table
    return _DEFAULT
