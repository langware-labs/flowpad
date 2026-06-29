"""Codex / OpenAI model price tables.

Rates verified 2026-06-12 against developers.openai.com/api/docs/pricing.
The schema mirrors :mod:`pricing.claude` so the ``UsageEntry`` dimension
contract is identical across workers.

Codex usage semantics (differ from Claude!): ``input_tokens`` INCLUDES
``cached_input_tokens``, and ``output_tokens`` INCLUDES
``reasoning_output_tokens``. The codex parser splits these into
non-overlapping billing dims (uncached input / cache read / output), so the
tables here price each stream exactly once.
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
        ItemPrice({"io": "output"}, base_out / _M),
    ])
    return ModelPricing(model=model, items=tuple(items))


# Verified rates: current models against developers.openai.com/api/docs/pricing,
# delisted models against the LiteLLM price database (both 2026-06-12).
GPT_5_5 = _openai_pricing("gpt-5.5", 5.00, 30.00, cached_in=0.50)
GPT_5_4 = _openai_pricing("gpt-5.4", 2.50, 15.00, cached_in=0.25)
GPT_5_3_CODEX = _openai_pricing("gpt-5.3-codex", 1.75, 14.00, cached_in=0.175)
GPT_5_2 = _openai_pricing("gpt-5.2", 1.75, 14.00, cached_in=0.175)
GPT_5 = _openai_pricing("gpt-5", 1.25, 10.00, cached_in=0.125)
GPT_5_MINI = _openai_pricing("gpt-5-mini", 0.25, 2.00, cached_in=0.025)


# Longest keys first — ``pricing_for``'s substring fallback must hit
# "gpt-5.2-codex" before the bare "gpt-5" family entry.
CODEX_PRICING: dict[str, ModelPricing] = {
    "gpt-5.2-codex": GPT_5_2,
    "gpt-5.3-codex": GPT_5_3_CODEX,
    "gpt-5-mini": GPT_5_MINI,
    "gpt-5.5": GPT_5_5,
    "gpt-5.4": GPT_5_4,
    "gpt-5.2": GPT_5_2,
    "gpt-5.1": GPT_5,
    "gpt-5": GPT_5,
}


# Codex CLI's current default model.
_DEFAULT = GPT_5_5


def pricing_for(model: str | None) -> ModelPricing:
    if not model:
        return _DEFAULT
    if model in CODEX_PRICING:
        return CODEX_PRICING[model]
    for key, table in CODEX_PRICING.items():
        if key in model or model in key:
            return table
    return _DEFAULT
