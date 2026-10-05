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

from flow_sdk._compat import StrEnum


class ModelTier(StrEnum):
    """Portable model size. Values are the wire form sent as ``model``."""

    SM = "sm"
    MD = "md"
    LG = "lg"


# Per-worker tier → concrete model or vendor-auto outcome. Each worker's
# CLI-options class owns its own map and resolves only when emitting the worker
# command; persisted AgenticProcess.cli_config keeps the portable tier.
CLAUDE_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "haiku",
    ModelTier.MD.value: "sonnet",
    ModelTier.LG.value: "opus",
}

# Only models a ChatGPT-login codex offers (``~/.codex/models_cache.json``): that
# account refuses the retired ``gpt-5.4`` family with a 400 "not supported when
# using Codex with a ChatGPT account", and the turn dies before it answers.
CODEX_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "gpt-5.6-luna",
    ModelTier.MD.value: "gpt-5.6-terra",
    ModelTier.LG.value: "gpt-5.6-sol",
}

COPILOT_MODEL_TIERS: dict[str, str | None] = {
    ModelTier.SM.value: None,
    ModelTier.MD.value: None,
    ModelTier.LG.value: None,
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

# Deep Agents runs OUR runner over the chat-completions wire, so a tier is a bare
# gateway slug (no ``openrouter/`` prefix — that is opencode's provider syntax).
# Three DISTINCT slugs: a collapsed ``md == lg`` is a silent no-op tier.
DEEPAGENTS_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "z-ai/glm-5.3-flash",
    ModelTier.MD.value: "z-ai/glm-5.2",
    ModelTier.LG.value: "z-ai/glm-5.3",
}


# A model FAMILY at a size — ``--model kimi:sm`` — for a worker funded by an LLM endpoint. The
# per-worker tables above pick ONE family per harness (claude's small is haiku, opencode's is a
# GLM); this table lets any funded harness run any family. Canonical ``vendor/model`` gateway
# slugs, every one in the hub's price table (a cost-capped endpoint refuses an unpriced model);
# each harness then spells the slug its own way (``ApiAuthSpec.slug_prefix``). A device login has
# no gateway to name these against, so there a family model is refused, not guessed.
FAMILY_TIERS: dict[str, dict[str, str]] = {
    "kimi": {
        ModelTier.SM.value: "moonshotai/kimi-k2-thinking",
        ModelTier.MD.value: "moonshotai/kimi-k2.5",
        ModelTier.LG.value: "moonshotai/kimi-k2.6",
    },
    "glm": {
        ModelTier.SM.value: "z-ai/glm-4.7",
        ModelTier.MD.value: "z-ai/glm-5",
        ModelTier.LG.value: "z-ai/glm-5.3",
    },
    "openai": {
        ModelTier.SM.value: "openai/gpt-oss-20b",
        ModelTier.MD.value: "openai/gpt-oss-120b",
        ModelTier.LG.value: "openai/gpt-5",
    },
    "claude": {
        ModelTier.SM.value: "anthropic/claude-haiku-4.5",
        ModelTier.MD.value: "anthropic/claude-sonnet-4.6",
        ModelTier.LG.value: "anthropic/claude-opus-4.8",
    },
}


_TIER_VALUES = frozenset(tier.value for tier in ModelTier)


def is_model_tier(model: str | None) -> bool:
    """Whether *model* is a portable size (``sm``/``md``/``lg``) rather than a named model."""
    return model in _TIER_VALUES


def is_family_model(model: str | None) -> bool:
    """Whether *model* is ``<family>:<size>`` syntax for a known family (any size, even a bad
    one — so a typo'd size is reported, not sent as a literal slug)."""
    family, sep, _ = (model or "").partition(":")
    return bool(sep) and family.strip().lower() in FAMILY_TIERS


def resolve_family_tier(model: str | None) -> str | None:
    """The canonical slug for ``<family>:<size>`` (``kimi:sm`` → ``moonshotai/kimi-k2-thinking``),
    or ``None`` when *model* is not family syntax — a tier, a literal slug, an OpenRouter
    ``:free`` variant. A known family with an unknown size raises ``ValueError`` naming the sizes.
    """
    if not is_family_model(model):
        return None
    family, _, size = model.partition(":")  # type: ignore[union-attr] — is_family_model checked it
    sizes = FAMILY_TIERS[family.strip().lower()]
    slug = sizes.get(size.strip().lower())
    if slug is None:
        raise ValueError(f"{model!r}: {family} comes in {', '.join(sizes)}")
    return slug


def resolve_model_tier(tier_map: dict[str, str | None], model: str | None) -> str | None:
    """Map a tier to a concrete model or vendor-auto via *tier_map*.

    Idempotent and pass-through: a non-tier value (a real model name, or a tier
    absent from *tier_map*) is returned unchanged. A present key mapped to
    ``None`` means vendor auto and suppresses the model flag. The worker supplies
    its own *tier_map* so the size→selection knowledge stays worker-local.
    """
    if not model:
        return model
    return tier_map.get(model, model)
