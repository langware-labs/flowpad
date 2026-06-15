"""Claude model price tables — sourced from docs.claude.com/pricing.

Rates per 1M tokens (input/output) and per 1k requests (server tools).
Cache writes: 5-minute TTL is 1.25× base input; 1-hour TTL is 2× base input.
Cache reads: 0.1× base input regardless of tier.
"""

from __future__ import annotations

from .base import ItemPrice, ModelPricing

_M = 1_000_000


def _claude_pricing(model: str, base_in: float, base_out: float) -> ModelPricing:
    """Build a ModelPricing for a Claude model from base input/output rates.

    Cache + server-tool rules are derived per the published multiplier
    relationships so all Claude SKUs share one definition.
    """
    return ModelPricing(
        model=model,
        items=(
            # Cache read — must come before "input/cache=none" because cache=read
            # is more specific than the bare-input rule.
            ItemPrice({"io": "input", "cache": "read"}, base_in * 0.10 / _M),
            # Cache writes (split by tier).
            ItemPrice({"io": "input", "cache": "write", "cache_tier": "5m"}, base_in * 1.25 / _M),
            ItemPrice({"io": "input", "cache": "write", "cache_tier": "1h"}, base_in * 2.00 / _M),
            # Bare input / output (cache="none").
            ItemPrice({"io": "input", "cache": "none"}, base_in / _M),
            ItemPrice({"io": "output"}, base_out / _M),
            # Server tools — billed per-request, not per-token.
            ItemPrice({"unit": "request", "tool": "web_search"}, 10.00 / 1000),
            ItemPrice({"unit": "request", "tool": "web_fetch"}, 5.00 / 1000),
        ),
    )


# Base $/MTok for each tier (Jun 2026, verified against
# platform.claude.com/docs/en/about-claude/pricing AND cross-checked against
# ccusage's per-session report on a real transcript).
FABLE_5 = _claude_pricing("claude-fable-5", 10.00, 50.00)
SONNET_4 = _claude_pricing("claude-sonnet-4", 3.00, 15.00)
OPUS_4 = _claude_pricing("claude-opus-4", 5.00, 25.00)
HAIKU_4 = _claude_pricing("claude-haiku-4", 1.00, 5.00)
SONNET_3_5 = _claude_pricing("claude-3-5-sonnet", 3.00, 15.00)
OPUS_3 = _claude_pricing("claude-3-opus", 15.00, 75.00)
HAIKU_3 = _claude_pricing("claude-3-haiku", 0.25, 1.25)


# Public registry: keys are exact model strings as emitted on
# ``message.model`` in Claude Code transcripts. New aliases land here.
# Bare family keys ("claude-opus-4") act as substring fallbacks in
# ``pricing_for`` so a new point release (e.g. claude-opus-4-9) resolves to
# its family table instead of silently falling through to the Sonnet default.
CLAUDE_PRICING: dict[str, ModelPricing] = {
    # Fable / Mythos 5 family
    "claude-fable-5": FABLE_5,
    "claude-mythos-5": FABLE_5,
    "claude-mythos-preview": FABLE_5,
    # Sonnet 4 family
    "claude-sonnet-4-6": SONNET_4,
    "claude-sonnet-4-7": SONNET_4,
    "claude-sonnet-4-5": SONNET_4,
    "claude-sonnet-4-5-20250929": SONNET_4,
    "claude-sonnet-4": SONNET_4,
    # Opus 4 family
    "claude-opus-4-8": OPUS_4,
    "claude-opus-4-7": OPUS_4,
    "claude-opus-4-6": OPUS_4,
    "claude-opus-4-5": OPUS_4,
    "claude-opus-4-5-20251101": OPUS_4,
    "claude-opus-4": OPUS_4,
    # Haiku 4 family
    "claude-haiku-4-5": HAIKU_4,
    "claude-haiku-4-5-20251001": HAIKU_4,
    "claude-haiku-4": HAIKU_4,
    # Older
    "claude-3-5-sonnet": SONNET_3_5,
    "claude-3-5-sonnet-20241022": SONNET_3_5,
    "claude-3-opus": OPUS_3,
    "claude-3-haiku": HAIKU_3,
}


_DEFAULT = SONNET_4


def pricing_for(model: str | None) -> ModelPricing:
    """Resolve a price table for a model name with fuzzy fallback.

    Exact match wins; otherwise look for a substring match (so
    ``claude-sonnet-4-6-future-snapshot`` still resolves to SONNET_4).
    Returns the Sonnet-4 table as a last-resort default.
    """
    if not model:
        return _DEFAULT
    if model in CLAUDE_PRICING:
        return CLAUDE_PRICING[model]
    for key, table in CLAUDE_PRICING.items():
        if key in model or model in key:
            return table
    return _DEFAULT
