"""Worker-agnostic model **tiers** (sm / md / lg) → per-worker selection.

A caller picks a *size* (small / medium / large) instead of hard-coding a vendor
model name; each worker driver maps the tier to its own model family or to
``None`` when the vendor should choose automatically. This keeps prompts/tests/
configs portable across workers ("use the small model") and is the single place
that knows, e.g., that claude's small model is ``haiku`` while native Copilot
must omit ``--model``.

Resolution is authoritative on the backend (driver ``cli_options``), so a tier
that was persisted into ``cli_config['model']`` still resolves correctly on
reload. A value that is NOT a tier passes through unchanged — callers may still
pass a concrete model name (``"sonnet"``, ``"gpt-5.4"``, …) directly.

The SDK mirrors the enum (``WorkerModelTier`` in ``ts_sdk`` agentic-types) so the
frontend can pass ``WorkerModelTier.SM`` as ``context.model``.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping

from flow_sdk._compat import StrEnum


class ModelTier(StrEnum):
    """Portable model size. Values are the wire form sent as ``model``."""

    SM = "sm"
    MD = "md"
    LG = "lg"


# What a size means to a harness on its OWN login (no LLM endpoint). No model ids here: the claude
# CLI has its own size words (``haiku``/``sonnet``/``opus``) and resolves them to whatever its
# installed version ships; every other vendor CLI gets ``None`` and picks its own default. A worker
# funded by an endpoint never reads these -- it runs the slug the endpoint declares for the size
# (``LLMEndpoint.models``, inherited down the hub chain).
CLAUDE_MODEL_TIERS: dict[str, str | None] = {
    ModelTier.SM.value: "haiku",
    ModelTier.MD.value: "sonnet",
    ModelTier.LG.value: "opus",
}

# The claude CLI's own names for its sizes, read back as sizes by a funded spawn
# (``ApiAuthSpec.native_tiers``) so the endpoint's slug for that size runs.
CLAUDE_CLI_ALIASES: dict[str, str] = {name: size for size, name in CLAUDE_MODEL_TIERS.items() if name}

#: The vendor chooses at every size: the default for every harness but claude (read-only, shared).
VENDOR_DEFAULT_TIERS: Mapping[str, str | None] = MappingProxyType({tier.value: None for tier in ModelTier})


_TIER_VALUES = frozenset(tier.value for tier in ModelTier)


def is_model_tier(model: str | None) -> bool:
    """Whether *model* is a portable size (``sm``/``md``/``lg``) rather than a named model."""
    return model in _TIER_VALUES


def resolve_model_tier(tier_map: Mapping[str, str | None], model: str | None) -> str | None:
    """Map a tier to a concrete model or vendor-auto via *tier_map*.

    Idempotent and pass-through: a non-tier value (a real model name, or a tier
    absent from *tier_map*) is returned unchanged. A present key mapped to
    ``None`` means vendor auto and suppresses the model flag. The worker supplies
    its own *tier_map* so the size→selection knowledge stays worker-local.
    """
    if not model:
        return model
    return tier_map.get(model, model)
