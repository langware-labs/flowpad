"""Worker-agnostic model **tiers** (sm / md / lg) → concrete per-worker model.

A caller picks a *size* (small / medium / large) instead of hard-coding a vendor
model name; each worker driver maps the tier to its own model family. This keeps
prompts/tests/configs portable across workers ("use the small model") and is the
single place that knows, e.g., that claude's small model is ``haiku``.

Resolution is authoritative on the backend (driver ``cli_options``), so a tier
that was persisted into ``cli_config['model']`` still resolves correctly on
reload. A value that is NOT a tier passes through unchanged — callers may still
pass a concrete model name (``"sonnet"``, ``"gpt-5.4"``, …) directly.

The SDK mirrors the enum (``WorkerModelTier`` in ``ts_sdk`` agentic-types) so the
frontend can pass ``WorkerModelTier.SM`` as ``context.model``.
"""

from __future__ import annotations

from flow_sdk._compat import StrEnum


class ModelTier(StrEnum):
    """Portable model size. Values are the wire form sent as ``model``."""

    SM = "sm"
    MD = "md"
    LG = "lg"


# Per-worker tier → concrete model string. Each worker's CLI-options class owns
# its own map and resolves only when emitting the worker command; persisted
# AgenticProcess.cli_config keeps the portable tier.
CLAUDE_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "haiku",
    ModelTier.MD.value: "sonnet",
    ModelTier.LG.value: "opus",
}

CODEX_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "gpt-5.4-mini",
    ModelTier.MD.value: "gpt-5.4",
    ModelTier.LG.value: "gpt-5.5",
}

COPILOT_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "gpt-5.4-mini",
    ModelTier.MD.value: "gpt-5.4",
    ModelTier.LG.value: "gpt-5.5",
}

# OpenCode is provider-agnostic: every model is addressed as ``provider/model``
# and the provider is whatever the user has credentials for. These tiers pick
# open-weight models through OpenRouter, which is the provider opencode resolves
# from a bare ``OPENROUTER_API_KEY`` in the environment with no config at all.
OPENCODE_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "openrouter/z-ai/glm-4.7-flash",
    ModelTier.MD.value: "openrouter/z-ai/glm-5.2",
    ModelTier.LG.value: "openrouter/z-ai/glm-5.2",
}


def resolve_model_tier(tier_map: dict[str, str], model: str | None) -> str | None:
    """Map a tier (``sm``/``md``/``lg``) to a concrete model via *tier_map*.

    Idempotent and pass-through: a non-tier value (a real model name, or a tier
    absent from *tier_map*) is returned unchanged. The worker supplies its own
    *tier_map* so the size→model knowledge stays worker-local.
    """
    if not model:
        return model
    return tier_map.get(model, model)
