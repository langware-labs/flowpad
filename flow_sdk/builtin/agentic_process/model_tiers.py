"""Worker-agnostic model **tiers** (sm / md / lg) → concrete per-worker model.

A caller picks a *size* (small / medium / large) instead of hard-coding a vendor
model name; each worker driver maps the tier to its own model family. This keeps
prompts/tests/configs portable across workers ("use the small model") and is the
single place that knows, e.g., that claude's small model is ``haiku``.

Resolution is authoritative on the backend (driver ``cli_options``), so a tier
that was persisted into ``cli_config['model']`` still resolves correctly on
reload. A value that is NOT a tier passes through unchanged — callers may still
pass a concrete model name (``"sonnet"``, ``"claude-opus-4-6"``, …) directly.

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


# Per-worker tier → concrete model string. A worker absent from this map (codex,
# copilot) has no tier mapping yet → tiers pass through unchanged (the CLI then
# uses its own default / rejects an unknown name, surfacing the gap loudly rather
# than silently picking the wrong size).
# claude's tier map. Each worker's CLI-options class owns its own map (and
# applies it internally — see ``WorkerCLIOptions.model``); this module is just
# the single place those maps are declared. Codex/copilot have none yet → their
# options pass tiers through unchanged.
CLAUDE_MODEL_TIERS: dict[str, str] = {
    ModelTier.SM.value: "haiku",
    ModelTier.MD.value: "sonnet",
    ModelTier.LG.value: "opus",
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
