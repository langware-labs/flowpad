"""API-key auth binding for agentic worker harnesses.

When a harness's ``Capability.auth_mode == "api"``, its worker spawns against a
stored LLM-provider key (see :mod:`flow_sdk.cli.auth.lm_api_keys`) instead of the
vendor device-login credentials. Each driver declares an :class:`ApiAuthSpec` with
the exact env / model / config it needs on the provider — the values proven to work
in the Docker OpenRouter runs.

This module is the single source of truth for that binding, consumed by three
places:
  * env injection  — folded into ``apply_worker_secret_env`` at spawn;
  * model / config override — applied to the CLI options before argv is frozen;
  * auth probe      — reports ``auth_mode="api"`` and the harness's providers.

It intentionally lives outside ``auth_probe.py`` (which is kept flow_sdk-import-free)
because ``ApiAuthSpec`` references :class:`LMApiProvider`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from flow_sdk.builtin.agentic_process.model_tiers import resolve_model_tier
from flow_sdk.cli.auth.lm_api_keys import get_lm_api
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess


@dataclass(frozen=True)
class ApiAuthSpec:
    """Per-driver recipe for authenticating a worker against an LLM provider key.

    All values are the ones verified against OpenRouter's protocol endpoints.
    ``base_env`` and ``model_env_vars`` are non-secret; the key itself is injected
    separately into ``token_env_var`` at spawn and never persisted.
    """

    token_env_var: str
    base_env: dict[str, str]
    tier_models: dict[str, str]  # sm/md/lg → provider model slug
    supported_providers: tuple[LMApiProvider, ...]
    default_provider: LMApiProvider
    config_overrides: tuple[tuple[str, str], ...] = ()  # codex `-c key=val` pairs
    model_env_vars: tuple[str, ...] = ()  # extra env vars that also carry the slug


@dataclass
class WorkerApiAuth:
    """Resolved binding for one spawn: env to inject, model slug, config overrides."""

    env: dict[str, str] = field(default_factory=dict)
    model_slug: str | None = None
    config_overrides: list[tuple[str, str]] = field(default_factory=list)


# ── Per-driver specs (proven OpenRouter values) ──────────────────────────────

CLAUDE_API_AUTH_SPEC = ApiAuthSpec(
    token_env_var="ANTHROPIC_AUTH_TOKEN",
    base_env={
        "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
        # Present-but-blank: the CLI prefers ANTHROPIC_API_KEY over the auth token
        # when set, so it must be empty, not unset.
        "ANTHROPIC_API_KEY": "",
        # OpenRouter appends a trailing redacted_thinking block that makes Claude
        # Code's -p result come back empty; disabling thinking avoids it.
        "MAX_THINKING_TOKENS": "0",
        "DISABLE_INTERLEAVED_THINKING": "1",
    },
    tier_models={
        "sm": "anthropic/claude-haiku-4.5",
        "md": "anthropic/claude-sonnet-4.5",
        "lg": "anthropic/claude-opus-4.1",
    },
    # Only OpenRouter routes today: base_env/token are provider-agnostic (fixed to
    # OpenRouter), so selecting a direct vendor would post its key to OpenRouter.
    # Add providers here only once ApiAuthSpec carries per-provider base_env.
    supported_providers=(LMApiProvider.OPENROUTER,),
    default_provider=LMApiProvider.OPENROUTER,
)

CODEX_API_AUTH_SPEC = ApiAuthSpec(
    token_env_var="OPENROUTER_API_KEY",
    base_env={},
    tier_models={
        "sm": "openai/gpt-5-mini",
        "md": "openai/gpt-5",
        "lg": "openai/gpt-5",
    },
    supported_providers=(LMApiProvider.OPENROUTER,),
    default_provider=LMApiProvider.OPENROUTER,
    # OpenRouter serves an OpenAI Responses-compatible endpoint; codex 0.144
    # dropped the chat wire, so wire_api must be "responses".
    config_overrides=(
        ("model_provider", "openrouter"),
        ("model_providers.openrouter.name", "OpenRouter"),
        ("model_providers.openrouter.base_url", "https://openrouter.ai/api/v1"),
        ("model_providers.openrouter.wire_api", "responses"),
        ("model_providers.openrouter.env_key", "OPENROUTER_API_KEY"),
    ),
)

COPILOT_API_AUTH_SPEC = ApiAuthSpec(
    token_env_var="COPILOT_PROVIDER_API_KEY",
    base_env={
        # ENABLE_ALT_PROVIDERS is what lets copilot start on a BYOK provider
        # without a GitHub token.
        "COPILOT_ENABLE_ALT_PROVIDERS": "1",
        "COPILOT_PROVIDER_TYPE": "openai",
        "COPILOT_PROVIDER_BASE_URL": "https://openrouter.ai/api/v1",
    },
    tier_models={
        "sm": "openai/gpt-5-mini",
        "md": "openai/gpt-5",
        "lg": "openai/gpt-5",
    },
    supported_providers=(LMApiProvider.OPENROUTER,),
    default_provider=LMApiProvider.OPENROUTER,
    model_env_vars=("COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL", "COPILOT_MODEL"),
)

OPENCODE_API_AUTH_SPEC = ApiAuthSpec(
    # OpenCode resolves OpenRouter from a bare key in the environment — it is a
    # built-in provider, so unlike codex/copilot there is no provider block, no
    # config override, and nothing written to disk. Verified on 1.18.16:
    # ``providers list`` reports the env var and ``models openrouter`` returns
    # the full catalog with no config file present at all.
    token_env_var="OPENROUTER_API_KEY",
    base_env={},
    tier_models={
        "sm": "openrouter/z-ai/glm-4.7-flash",
        "md": "openrouter/z-ai/glm-5.2",
        "lg": "openrouter/z-ai/glm-5.2",
    },
    supported_providers=(LMApiProvider.OPENROUTER,),
    default_provider=LMApiProvider.OPENROUTER,
)


_SPECS: dict[str, ApiAuthSpec] = {
    "claude": CLAUDE_API_AUTH_SPEC,
    "codex": CODEX_API_AUTH_SPEC,
    "copilot": COPILOT_API_AUTH_SPEC,
    "opencode": OPENCODE_API_AUTH_SPEC,
}


def driver_api_auth_spec(worker_type: str) -> ApiAuthSpec | None:
    """The ApiAuthSpec for a driver name (claude/codex/copilot), or None."""
    return _SPECS.get(worker_type)


async def resolve_worker_api_auth(process: "AgenticProcess") -> WorkerApiAuth | None:
    """Resolve the API-key binding for *process*, or None when not in api mode.

    Raises :class:`WorkerSpawnError` when api mode is selected but no key is stored
    for the provider — better a clear failure than a silent fall-through to the
    vendor device-login picker (which hangs the turn).
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        WorkerSpawnError,
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability

    worker_type = getattr(process.driver, "name", None)
    spec = driver_api_auth_spec(worker_type) if worker_type else None
    if spec is None:
        return None

    cap = await Capability.get_by_kind(worker_capability_kind(worker_type))
    if cap is None or getattr(cap, "auth_mode", "device") != "api":
        return None

    provider = cap.api_provider or spec.default_provider.value
    key = get_lm_api(provider)
    if not key:
        raise WorkerSpawnError(
            worker_type,
            f"{worker_type} is set to API-key auth but no {provider} key is stored "
            f"(set one via set_lm_api / the harness modal).",
        )

    # Effective tier→slug map = code defaults ⊕ the harness's user overrides for
    # this provider (Capability.model_map). Custom option names resolve here too;
    # an unknown value still passes through as a literal slug.
    overrides = (getattr(cap, "model_map", None) or {}).get(provider) or {}
    merged = {**spec.tier_models, **overrides}
    tier = (process.cli_config or {}).get("model")
    slug = resolve_model_tier(merged, tier or "sm")  # merged always has "sm"
    env = {**spec.base_env, spec.token_env_var: key}
    if slug:
        for var in spec.model_env_vars:
            env[var] = slug
    return WorkerApiAuth(env=env, model_slug=slug, config_overrides=list(spec.config_overrides))


async def apply_api_model_to_options(cmd, process: "AgenticProcess") -> None:
    """When *process* is in api mode, stamp the resolved model slug (and codex `-c`
    overrides) onto the CLI options *cmd* before its argv is frozen."""
    auth = await resolve_worker_api_auth(process)
    if auth is None:
        return
    if auth.model_slug:
        cmd.model = auth.model_slug
    if auth.config_overrides and hasattr(cmd, "extra_config_overrides"):
        cmd.extra_config_overrides = auth.config_overrides
