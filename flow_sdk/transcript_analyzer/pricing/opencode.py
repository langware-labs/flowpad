"""OpenCode price tables.

OpenCode is the one worker that is **model-agnostic**: every id is
``provider/model`` and the provider is whatever the user has credentials for, so
this table is keyed on the model slug rather than on a vendor family. Rates are
the provider's published per-MTok prices.

OpenCode does report a ``cost`` on each ``step_finish``, but the transcript
contract is that USD is server-derived from token counts — a worker never bills
itself — so the vendor number is carried only as debug payload and the money is
computed from these rates. (Its own store records ``cost: 0`` on message rows
anyway, so trusting it would make the two transcript formats disagree.)

Rates verified 2026-08-11 against openrouter.ai model pages.
"""

from __future__ import annotations

from .base import ItemPrice, ModelPricing

_M = 1_000_000


def _flat_pricing(
    model: str,
    base_in: float,
    base_out: float,
    cached_in: float | None = None,
) -> ModelPricing:
    """Flat per-MTok input/output, with an optional flat cached-input rate."""
    items: list[ItemPrice] = []
    if cached_in is not None:
        items.append(ItemPrice({"io": "input", "cache": "read"}, cached_in / _M))
    items.extend([
        ItemPrice({"io": "input", "cache": "none"}, base_in / _M),
        ItemPrice({"io": "output"}, base_out / _M),
    ])
    return ModelPricing(model=model, items=tuple(items))


GLM_5_2 = _flat_pricing("z-ai/glm-5.2", 1.40, 4.40)
GLM_5_1 = _flat_pricing("z-ai/glm-5.1", 1.10, 3.50)
GLM_5 = _flat_pricing("z-ai/glm-5", 1.10, 3.50)
GLM_4_7 = _flat_pricing("z-ai/glm-4.7", 0.60, 2.00)
GLM_4_7_FLASH = _flat_pricing("z-ai/glm-4.7-flash", 0.10, 0.40)
GLM_4_6 = _flat_pricing("z-ai/glm-4.6", 0.40, 1.75)

OPENCODE_PRICING: dict[str, ModelPricing] = {
    "z-ai/glm-5.2": GLM_5_2,
    "z-ai/glm-5.1": GLM_5_1,
    "z-ai/glm-5": GLM_5,
    "z-ai/glm-4.7-flash": GLM_4_7_FLASH,
    "z-ai/glm-4.7": GLM_4_7,
    "z-ai/glm-4.6": GLM_4_6,
}

# The tier map's mid model — what an unqualified opencode run resolves to.
_DEFAULT = GLM_5_2


def _strip_provider(model: str) -> str:
    """``openrouter/z-ai/glm-5.2`` → ``z-ai/glm-5.2``.

    opencode addresses models as ``provider/model``, and the model half is
    itself often ``org/name``, so only the FIRST segment is the provider.
    """
    parts = model.split("/")
    if len(parts) >= 3:
        return "/".join(parts[1:])
    return model


def pricing_for(model: str | None) -> ModelPricing:
    if not model:
        return _DEFAULT
    slug = _strip_provider(model)
    if slug in OPENCODE_PRICING:
        return OPENCODE_PRICING[slug]
    # Longest key first, so ``glm-4.7-flash`` never matches the ``glm-4.7`` row.
    for key in sorted(OPENCODE_PRICING, key=len, reverse=True):
        if key in slug:
            return OPENCODE_PRICING[key]
    return _DEFAULT
