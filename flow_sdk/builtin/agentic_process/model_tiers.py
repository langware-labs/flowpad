"""Worker-agnostic model **tiers** (sm / md / lg) → per-worker selection.

A caller picks a size instead of a vendor model name. Claude's CLI owns native
size aliases; other device logins use ``Capability.model_map['device']`` at
spawn binding. An unmapped size is rejected, never silently replaced by the
vendor default. Omitting the model still lets the vendor choose.

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


# Native CLI aliases, not versioned model ids. Endpoint-funded workers use the
# endpoint's tiers; device overrides are resolved by the spawn binding.
CLAUDE_MODEL_TIERS: dict[str, str | None] = {
    ModelTier.SM.value: "haiku",
    ModelTier.MD.value: "sonnet",
    ModelTier.LG.value: "opus",
}

# The claude CLI's own names for its sizes, read back as sizes by a funded spawn
# (``ApiAuthSpec.native_tiers``) so the endpoint's slug for that size runs.
CLAUDE_CLI_ALIASES: dict[str, str] = {name: size for size, name in CLAUDE_MODEL_TIERS.items() if name}

#: Unmapped native tiers; command emission refuses these until the binding supplies a model.
VENDOR_DEFAULT_TIERS: Mapping[str, str | None] = MappingProxyType({tier.value: None for tier in ModelTier})


_TIER_VALUES = frozenset(tier.value for tier in ModelTier)


def is_model_tier(model: str | None) -> bool:
    """Whether *model* is a portable size (``sm``/``md``/``lg``) rather than a named model."""
    return model in _TIER_VALUES


def resolve_model_tier(tier_map: Mapping[str, str | None], model: str | None) -> str | None:
    """Resolve native aliases; reject an unmapped requested size, pass model names through."""
    if not model:
        return model
    resolved = tier_map.get(model, model)
    if is_model_tier(model) and (not resolved or resolved == model):
        raise ValueError(
            f"Model size {model!r} has no mapping for this worker; configure "
            "Capability.model_map['device'] or name a concrete model"
        )
    return resolved
