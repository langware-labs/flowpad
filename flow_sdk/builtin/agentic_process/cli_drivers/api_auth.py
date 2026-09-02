"""Turning a chosen ``LLMSource`` into a spawn binding.

WHICH source funds a worker is decided by ``resolve_llm_source`` (``llm_source.py``);
this module owns the other half — the per-vendor recipe that turns that decision into
env vars, a model slug and (codex) ``-c`` overrides. Each driver declares an
:class:`ApiAuthSpec` with the exact values proven to work against the provider in the
Docker OpenRouter runs.

Consumed in three places:
  * env injection  — folded into ``apply_worker_secret_env`` at spawn;
  * model / config override — applied to the CLI options before argv is frozen;
  * auth probe      — reports the resolved source's provider.

It intentionally lives outside ``auth_probe.py`` (which is kept flow_sdk-import-free)
because ``ApiAuthSpec`` references :class:`LMApiProvider`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable

from flow_sdk.builtin.agentic_process.model_tiers import resolve_model_tier
from flow_sdk.cli.auth.lm_api_keys import get_lm_api
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.flowpad_types.vendors import vendor_or_none

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProviderBinding:
    """What ONE provider contributes to a spawn: where the key goes, the
    non-secret env around it, and (codex) the ``-c`` overrides."""

    token_env_var: str
    base_env: dict[str, str]
    config_overrides: tuple[tuple[str, str], ...] = ()
    #: opencode is configured by FILE, not env: its OpenRouter provider is built in and honours no
    #: base-URL variable (verified against 1.18.25 -- ``OPENROUTER_BASE_URL`` is ignored and the CLI
    #: still calls openrouter.ai). Its generated ``opencode.json`` is the only way to redirect it, so
    #: a binding may carry a ``provider`` fragment to merge into that file.
    provider_options: dict[str, dict] = field(default_factory=dict)


@dataclass(frozen=True)
class ApiAuthSpec:
    """Per-driver recipe for authenticating a worker against an LLM provider key.

    ``token_env_var`` / ``base_env`` / ``config_overrides`` are the OpenRouter
    binding (the values verified against OpenRouter's protocol endpoints), kept
    flat so the existing shape is unchanged. ``hub_endpoint_binding`` builds the
    ``LMApiProvider.FLOWPAD`` binding from the hub endpoint's invoke URL at spawn
    time -- the URL is not known statically. ``binding_for`` picks between them.
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
    # FLOWPAD: (invoke_url, no trailing slash) -> binding. None = unsupported.
    hub_endpoint_binding: Callable[[str], ProviderBinding] | None = None

    def binding_for(self, provider: LMApiProvider, *, hub_invoke_url: str | None) -> ProviderBinding:
        """The binding to spawn with for *provider*.

        OpenRouter (and any other statically-bound provider) returns the spec's
        own fields byte-identical. FLOWPAD needs the hub endpoint URL and raises
        ``ValueError`` when the driver has no hub binding or the box is unbound.
        """
        if provider is LMApiProvider.FLOWPAD:
            if self.hub_endpoint_binding is None:
                raise ValueError("this harness cannot route through the FlowPad hub endpoint")
            if not hub_invoke_url:
                raise ValueError("no FlowPad hub LLM endpoint is bound to this box")
            return self.hub_endpoint_binding(hub_invoke_url.rstrip("/"))
        return ProviderBinding(self.token_env_var, self.base_env, self.config_overrides)


@dataclass
class WorkerApiAuth:
    """Resolved binding for one spawn: env to inject, model slug, config overrides."""

    env: dict[str, str] = field(default_factory=dict)
    model_slug: str | None = None
    config_overrides: list[tuple[str, str]] = field(default_factory=list)
    #: ``opencode.json`` ``provider`` fragment; empty for every env-configured harness.
    provider_options: dict[str, dict] = field(default_factory=dict)


# ── Per-driver specs (proven OpenRouter values) ──────────────────────────────
#
# The FLOWPAD bindings point the same CLIs at the hub's LLMEndpoint instead of
# OpenRouter directly. The endpoint is a passthrough to OpenRouter, so the wire
# quirks (blank ANTHROPIC_API_KEY, no thinking, `wire_api = responses`, alt
# provider type "openai") and the OpenRouter model slugs are unchanged; only the
# base URL and the token move. claude appends `/v1/messages` to its base itself;
# codex and copilot expect the `/v1` root.


def _claude_hub_binding(url: str) -> ProviderBinding:
    return ProviderBinding(
        token_env_var="ANTHROPIC_AUTH_TOKEN",
        base_env={
            "ANTHROPIC_BASE_URL": url,
            "ANTHROPIC_API_KEY": "",
            "MAX_THINKING_TOKENS": "0",
            "DISABLE_INTERLEAVED_THINKING": "1",
        },
    )


def _codex_hub_binding(url: str) -> ProviderBinding:
    return ProviderBinding(
        token_env_var="FLOWPAD_HUB_API_KEY",
        base_env={},
        config_overrides=(
            ("model_provider", "flowpad"),
            ("model_providers.flowpad.name", "FlowPad"),
            ("model_providers.flowpad.base_url", f"{url}/v1"),
            ("model_providers.flowpad.wire_api", "responses"),
            ("model_providers.flowpad.env_key", "FLOWPAD_HUB_API_KEY"),
            # OpenRouter slugs carry no codex model metadata, so codex falls back to
            # "reasoning: none" -- which the Responses endpoint refuses for gpt-5
            # ("Reasoning is mandatory for this endpoint"). Proven on a real box.
            ("model_reasoning_effort", "low"),
        ),
    )


def _copilot_hub_binding(url: str) -> ProviderBinding:
    return ProviderBinding(
        token_env_var="COPILOT_PROVIDER_API_KEY",
        base_env={
            "COPILOT_ENABLE_ALT_PROVIDERS": "1",
            "COPILOT_PROVIDER_TYPE": "openai",
            "COPILOT_PROVIDER_BASE_URL": f"{url}/v1",
        },
    )


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
    # OpenRouter directly, or the hub's LLMEndpoint (a passthrough to it). A
    # direct vendor is NOT here: base_env is fixed to OpenRouter's URL, so
    # selecting one would post its key to OpenRouter.
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD),
    default_provider=LMApiProvider.OPENROUTER,
    hub_endpoint_binding=_claude_hub_binding,
)

CODEX_API_AUTH_SPEC = ApiAuthSpec(
    token_env_var="OPENROUTER_API_KEY",
    base_env={},
    tier_models={
        "sm": "openai/gpt-5-mini",
        "md": "openai/gpt-5",
        # Was also ``openai/gpt-5``, which made the lg tier a no-op: asking for the
        # accurate model got the balanced one. Verified against the live OpenRouter
        # catalog rather than guessed.
        "lg": "openai/gpt-5-pro",
    },
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD),
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
    hub_endpoint_binding=_codex_hub_binding,
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
        "lg": "openai/gpt-5-pro",  # was a duplicate of md -- see the codex spec
    },
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD),
    default_provider=LMApiProvider.OPENROUTER,
    model_env_vars=("COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL", "COPILOT_MODEL"),
    hub_endpoint_binding=_copilot_hub_binding,
)

def _opencode_hub_binding(url: str) -> ProviderBinding:
    """opencode keeps its own OpenRouter provider and its bare key; only the base URL moves.

    Nothing goes in ``base_env`` because opencode reads no base-URL variable -- the redirect has to
    reach it through the generated ``opencode.json``.
    """
    return ProviderBinding(
        token_env_var="OPENROUTER_API_KEY",
        base_env={},
        provider_options={"openrouter": {"options": {"baseURL": f"{url}/v1"}}},
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
        "lg": "openrouter/z-ai/glm-5.3",  # was a duplicate of md -- see the codex spec
    },
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD),
    default_provider=LMApiProvider.OPENROUTER,
    hub_endpoint_binding=_opencode_hub_binding,
)


_SPECS: dict[str, ApiAuthSpec] = {
    "claude": CLAUDE_API_AUTH_SPEC,
    "codex": CODEX_API_AUTH_SPEC,
    "copilot": COPILOT_API_AUTH_SPEC,
    "opencode": OPENCODE_API_AUTH_SPEC,
}


def driver_api_auth_spec(worker_type: str) -> ApiAuthSpec | None:
    """The ApiAuthSpec for any vendor spelling ``VENDORS`` knows, or None."""
    vendor = vendor_or_none(worker_type)
    return _SPECS.get(vendor.key) if vendor else None


def endpoint_invoke_url(typeid) -> str | None:
    """The absolute invoke URL for a hub endpoint typeid, or ``None`` when it is not one.

    Deliberately unvalidated against any local list: the hub authorizes every ``invoke``
    against the endpoint in the URL, so a stale or forged typeid can only earn a 401/403 --
    it cannot reach a budget this caller may not spend. That is what lets an override carry
    no new trust assumptions, and it means a freshly-shared endpoint works before any local
    cache has heard of it.
    """
    if not typeid:
        return None
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint, hub_invoke_path  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
    from flow_sdk.instance_settings.llm_endpoint import hub_origin  # noqa: PLC0415

    try:
        parsed = TypeId(str(typeid))
    except (TypeError, ValueError):
        return None
    if parsed.type != LLMEndpoint.get_type():
        # A well-formed typeid of the wrong type would otherwise build a plausible-looking
        # invoke URL for something that is not a budget at all.
        return None
    return f"{hub_origin()}{hub_invoke_path(parsed)}"


async def resolve_worker_api_auth(process: "AgenticProcess") -> WorkerApiAuth | None:
    """Materialize the spawn binding for whichever ``LLMSource`` funds *process*.

    Returns ``None`` for a DEVICE source -- the vendor CLI reads its own credentials, so
    there is nothing to inject, and ``None`` is what "spawn with device auth" has always
    meant to every caller.

    Which source wins is NOT decided here any more: ``resolve_llm_source`` owns the
    ladder, so the answer this spawn uses and the answer the picker renders come from one
    place and cannot disagree. This function owns the other half -- turning a chosen
    source into env, model slug and config overrides.

    Raises :class:`WorkerSpawnError` when nothing can fund the spawn, carrying every
    candidate's reason rather than a sentence written here.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        WorkerSpawnError,
        worker_capability_kind,
    )
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import (  # noqa: PLC0415
        LLMSourceError,
        LLMSourceKind,
        resolve_llm_source,
    )
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    worker_type = getattr(process.driver, "name", None)
    spec = driver_api_auth_spec(worker_type) if worker_type else None
    if spec is None:
        return None

    try:
        source = await resolve_llm_source(process)
    except LLMSourceError as exc:
        raise WorkerSpawnError(worker_type, str(exc)) from exc

    if source.kind is LLMSourceKind.DEVICE:
        return None

    try:
        provider = LMApiProvider(source.provider)
    except ValueError as exc:
        raise WorkerSpawnError(worker_type, f"{worker_type} is bound to unknown provider {source.provider!r}") from exc
    if provider not in spec.supported_providers:
        raise WorkerSpawnError(worker_type, f"{worker_type} cannot use provider {provider.value!r}")

    # For FLOWPAD the endpoint and the key are one question: the "key" IS the hub login,
    # and what makes it usable is having an endpoint to point it at.
    hub_invoke_url = None
    if provider is LMApiProvider.FLOWPAD:
        from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415
        from flow_sdk.instance_settings.llm_endpoint import hub_llm_endpoint_invoke_url  # noqa: PLC0415

        hub_invoke_url = endpoint_invoke_url(source.endpoint_typeid) or hub_llm_endpoint_invoke_url()
        key = resolve_hub_api_key() if hub_invoke_url else None
        # ``tier_models`` are OpenRouter slugs, and the wire quirks around them (claude's
        # blank ANTHROPIC_API_KEY, codex's ``wire_api = responses``) were proven against
        # OpenRouter's protocol endpoints. A hub endpoint whose ROOT is a direct vendor is
        # therefore about to be sent a slug it does not know. We do not refuse -- an
        # endpoint's own ``filters.model_map`` can legitimately remap it, and refusing
        # would break a working setup -- but this must not be a silent field-only failure.
        root_provider = source.root_provider.strip().lower()
        if root_provider and root_provider != LMApiProvider.OPENROUTER.value:
            logger.warning(
                "%s is spending hub endpoint %s whose root provider is %r, not openrouter; the "
                "tier slugs are OpenRouter names and will only resolve if that endpoint's "
                "filters.model_map remaps them",
                worker_type,
                source.endpoint_typeid or "(box binding)",
                root_provider,
            )
    else:
        key = get_lm_api(provider)
    if not key:
        raise WorkerSpawnError(worker_type, f"{worker_type}: {source.name} is unusable (no credential available)")
    try:
        binding = spec.binding_for(provider, hub_invoke_url=hub_invoke_url)
    except ValueError as exc:
        raise WorkerSpawnError(worker_type, str(exc)) from exc

    # Effective tier→slug map = code defaults ⊕ the harness's user overrides for
    # this provider (Capability.model_map). Custom option names resolve here too;
    # an unknown value still passes through as a literal slug.
    cap = await Capability.get_by_kind(worker_capability_kind(worker_type))
    overrides = (getattr(cap, "model_map", None) or {}).get(provider.value) or {}
    merged = {**spec.tier_models, **overrides}
    tier = (process.cli_config or {}).get("model")
    slug = resolve_model_tier(merged, tier or "sm")  # merged always has "sm"
    env = {**binding.base_env, binding.token_env_var: key}
    if slug:
        for var in spec.model_env_vars:
            env[var] = slug
    return WorkerApiAuth(
        env=env,
        model_slug=slug,
        config_overrides=list(binding.config_overrides),
        provider_options=dict(binding.provider_options),
    )


async def apply_api_model_to_options(cmd, process: "AgenticProcess") -> None:
    """When *process* is in api mode, stamp the resolved model slug (and codex `-c`
    overrides) onto the CLI options *cmd* before its argv is frozen."""
    auth = await resolve_worker_api_auth(process)
    if auth is None:
        return
    if auth.model_slug:
        cmd.model = auth.model_slug
    if auth.provider_options and hasattr(cmd, "provider_options"):
        # File-configured harnesses (opencode) reach their endpoint through this, not through env.
        cmd.provider_options = dict(auth.provider_options)
    if auth.config_overrides and hasattr(cmd, "extra_config_overrides"):
        cmd.extra_config_overrides = [
            *list(getattr(cmd, "extra_config_overrides", []) or []),
            *auth.config_overrides,
        ]


async def stamp_api_model(context, process: "AgenticProcess") -> None:
    """Best-effort :func:`apply_api_model_to_options` for a headless turn.

    The API-key path must reach the model too: without this the provider token is
    injected but the model stays the vendor default, which the provider (e.g.
    OpenRouter) would not recognise. Failures are logged and swallowed — a broken
    override must not take down a turn that device-login auth would have run.
    """
    import logging  # noqa: PLC0415

    try:
        await apply_api_model_to_options(context, process)
    except Exception:
        logging.getLogger(__name__).debug("stamp_api_model: api model override failed", exc_info=True)
