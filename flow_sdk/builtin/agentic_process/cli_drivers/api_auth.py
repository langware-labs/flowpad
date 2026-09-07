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

import json
import logging
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from flow_sdk.builtin.agentic_process.model_tiers import resolve_model_tier
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
    #: The provider name this binding's ``config_overrides`` declare (codex's
    #: ``model_providers.<name>``). Carried rather than recovered: a renderer that needs it was
    #: parsing the very TOML keys the factory below had just formatted, which is a decision made
    #: in one place and reverse-engineered in another.
    provider_key: str = ""
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
    provider_key: str = ""  # the ``model_providers.<name>`` those overrides declare
    model_env_vars: tuple[str, ...] = ()  # extra env vars that also carry the slug
    #: Env vars that carry the model when there is NO argv to carry it. ``model_env_vars`` above
    #: is for a SPAWN, which passes ``--model`` / ``-c model=`` / a generated config; a person
    #: typing the CLI passes nothing, and the harness then asks for its own default -- which a
    #: budgeted endpoint refuses outright ("has no known price"; observed as claude requesting
    #: ``claude-opus-4-8`` and getting a 400). Empty where the slug already reaches the harness
    #: another way: codex and opencode through their generated file, copilot through
    #: ``model_env_vars``.
    prompt_model_env_vars: tuple[str, ...] = ()
    #: For a harness configured by FILE: the variable that POINTS at that file, and whether it
    #: names the directory (codex) or the file itself (opencode). Empty for an env-configured
    #: harness. Here rather than in the renderers so ``managed_env_vars`` can derive the full set
    #: instead of hard-coding half of it.
    pointer_env: str = ""
    pointer_is_dir: bool = False
    #: Where this harness reads funding from BOX-WIDE, relative to the user's home, and how to
    #: apply it (``json`` merge | ``toml`` managed block | ``profile`` managed block). Empty when
    #: the harness has no such file -- copilot, whose BYOK credentials live behind an interactive
    #: UI, so its only box-wide form is the shell profile.
    user_config_path: str = ""
    user_config_fmt: str = ""
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
        return ProviderBinding(self.token_env_var, self.base_env, self.config_overrides, provider_key=self.provider_key)


@dataclass
class WorkerApiAuth:
    """Resolved binding for one spawn: env to inject, model slug, config overrides."""

    env: dict[str, str] = field(default_factory=dict)
    model_slug: str | None = None
    config_overrides: list[tuple[str, str]] = field(default_factory=list)
    #: ``opencode.json`` ``provider`` fragment; empty for every env-configured harness.
    provider_options: dict[str, dict] = field(default_factory=dict)
    #: Which key of ``env`` holds the SECRET. A spawn never needs to know — it injects the whole
    #: dict — but a renderer writing the harness's own config file does: codex takes the token as
    #: a static header rather than an env var, and picking "the one that looks like a key" out of
    #: a dict is exactly the guess that breaks when a binding grows a second variable.
    token_env_var: str = ""
    #: The provider name ``config_overrides`` declare, straight off the ``ProviderBinding`` that
    #: chose it -- so a renderer composes the key path instead of parsing it back out of the
    #: very TOML keys that binding had just formatted.
    provider_key: str = ""


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
        provider_key="flowpad",
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
    prompt_model_env_vars=("ANTHROPIC_MODEL",),
    user_config_path=".claude/settings.json",
    user_config_fmt="json",
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
    provider_key="openrouter",
    pointer_env="CODEX_HOME",
    pointer_is_dir=True,
    user_config_path=".codex/config.toml",
    user_config_fmt="toml",
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
    user_config_path=".profile",
    user_config_fmt="profile",
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
        provider_key="openrouter",
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
    pointer_env="OPENCODE_CONFIG",
    user_config_path=".config/opencode/opencode.json",
    user_config_fmt="json",
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
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import (  # noqa: PLC0415
        LLMSourceError,
        resolve_llm_endpoint,
    )

    worker_type = getattr(process.driver, "name", None)
    if not worker_type or driver_api_auth_spec(worker_type) is None:
        return None

    try:
        candidate = await resolve_llm_endpoint(process)
    except LLMSourceError as exc:
        raise WorkerSpawnError(worker_type, str(exc)) from exc

    return await binding_for_candidate(worker_type, candidate, tier=(process.cli_config or {}).get("model"))


async def binding_for_candidate(worker_type: str, candidate, *, tier: str | None = None) -> WorkerApiAuth | None:
    """The spawn binding for one ALREADY-CHOSEN source — env, model slug, config overrides.

    The half of :func:`resolve_worker_api_auth` that does not care WHERE the choice came from,
    split out for the callers that have no process to resolve against. ``flow llm`` is exactly
    that: the user names a row from the picker's own list and wants the binding for it, so the
    recipe must be reachable without inventing a fake process to carry it.

    ``None`` for a DEVICE source, for the same reason as the caller above: the vendor CLI reads
    its own credentials and there is nothing to inject.

    *tier* is the ``sm``/``md``/``lg`` key (or a literal slug); ``None`` means the small tier,
    which is what every caller without an explicit ``cli_config.model`` has always got.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        WorkerSpawnError,
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind  # noqa: PLC0415

    spec = driver_api_auth_spec(worker_type)
    if spec is None:
        return None

    endpoint, source = candidate
    if endpoint.kind == LLMEndpointKind.DEVICE:
        return None

    is_hub = endpoint.kind == LLMEndpointKind.HUB
    # A hub endpoint is spent through the harness's FLOWPAD binding whatever its root
    # provider is: the hub relays verbatim, so the box speaks the binding's protocol to the
    # hub and the hub speaks the root's upstream.
    provider_value = LMApiProvider.FLOWPAD.value if is_hub else endpoint.provider
    try:
        provider = LMApiProvider(provider_value)
    except ValueError as exc:
        raise WorkerSpawnError(worker_type, f"{worker_type} is bound to unknown provider {provider_value!r}") from exc
    if provider not in spec.supported_providers:
        raise WorkerSpawnError(worker_type, f"{worker_type} cannot use provider {provider.value!r}")

    # For FLOWPAD the endpoint and the key are one question: the "key" IS the hub login,
    # and what makes it usable is having an endpoint to point it at.
    hub_invoke_url = None
    if is_hub:
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
        root_provider = (endpoint.provider or "").strip().lower()
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
        # Stored only, matching what the resolver judged eligible — a spawn must not be
        # funded by an environment variable the picker never counted.
        key = endpoint.resolve_api_key(allow_environment=False)
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
    # Deliberately NOT merged with ``endpoint.models``. Those are the slugs for calling this
    # credential directly (an embedding model, a general-purpose chat model); the harness
    # tier map is what THIS CLI should run, and codex asking for its small tier must get
    # gpt-5-mini rather than whatever general-purpose model the endpoint happens to name.
    # Folding them made every harness inherit the endpoint's defaults and silently
    # re-pointed codex at a Claude slug.
    merged = {**spec.tier_models, **overrides}
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
        token_env_var=binding.token_env_var,
        provider_key=binding.provider_key,
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


# ── rendering a binding for a human's terminal ───────────────────────────────
#
# A spawn injects env and generates a per-process config, so it never needs this. ``flow llm``
# does: it hands the SAME binding to a shell the user then types ``claude`` / ``codex`` /
# ``opencode`` into. Two of the four cannot be redirected by an environment variable at all --
# verified against codex 0.153.4 (ignores ``OPENAI_BASE_URL``) and opencode 1.18.29 (ignores
# ``OPENROUTER_BASE_URL`` and ``OPENCODE_BASE_URL``); both called their vendor default instead.
# Their base URL only moves through a config FILE, and the only variable they honour is one
# that points AT that file. Hence ``files`` + ``pointer_env`` rather than env alone.


@dataclass(frozen=True)
class ShellBinding:
    """One harness's binding as a terminal can consume it.

    ``files`` are written by the caller (it owns the filesystem layout, this module owns the
    contents), then ``pointer_env`` is exported pointing at the directory or the single file,
    per ``pointer_is_dir``. Empty ``pointer_env`` means env alone is enough.
    """

    env: dict[str, str]
    files: dict[str, str] = field(default_factory=dict)
    pointer_env: str = ""
    pointer_is_dir: bool = False


#: Managed-region markers for the two formats that are not JSON. Everything between them is ours
#: to rewrite; everything outside is the user's and must survive — a whole-file overwrite would
#: eat hand-written settings, which is the one thing a command like this must never do.
MANAGED_BEGIN = "# >>> flowpad llm >>>"
MANAGED_END = "# <<< flowpad llm <<<"


@dataclass(frozen=True)
class UserBinding:
    """Where a harness reads its funding from by DEFAULT, and what to put there.

    ``fmt`` says how the caller must apply it, because only the caller owns the filesystem:

    * ``json``    — deep-merge ``merge`` into the existing document (never overwrite it);
    * ``toml`` / ``profile`` — replace the managed region of the file with ``lines``.

    ``path`` is relative to the user's home. ``note`` explains a harness that has no file of its
    own, and is rendered verbatim.
    """

    fmt: str = ""
    path: str = ""
    merge: dict = field(default_factory=dict)
    lines: tuple[str, ...] = ()
    note: str = ""


def managed_env_vars() -> list[str]:
    """Every variable the shell form can set, for any harness and any provider.

    What ``flow llm clear`` unsets. Derived wholly from the specs -- including the pointer
    variables and the prompt-model variables, which used to be string literals here AND in the
    renderer below. Static and secret-free, because clearing must work with no source chosen and
    no credential available.
    """
    names: set[str] = set()
    for spec in _SPECS.values():
        names.update({spec.token_env_var, *spec.base_env, *spec.model_env_vars, *spec.prompt_model_env_vars})
        names.discard("")
        if spec.pointer_env:
            names.add(spec.pointer_env)
        if spec.hub_endpoint_binding is not None:
            # The URL is never read back -- only the variable NAMES are -- so any well-formed
            # one will do.
            hub = spec.hub_endpoint_binding("https://example.invalid")
            names.add(hub.token_env_var)
            names.update(hub.base_env)
    return sorted(names)


def _prompt_env(spec: ApiAuthSpec, auth: WorkerApiAuth) -> dict[str, str]:
    """*auth*'s env plus the model, for a surface that has no argv to carry it."""
    env = dict(auth.env)
    for name in spec.prompt_model_env_vars:
        if auth.model_slug:
            env[name] = auth.model_slug
    return env


def _codex_toml(auth: WorkerApiAuth, *, inline_token: bool) -> list[str]:
    """codex's config as dotted-key TOML: the ``-c`` overrides verbatim, one per line.

    ``inline_token`` picks how the token travels. A SHELL can export ``env_key``'s variable, so
    the overrides stand as-is. A BOX-WIDE file cannot -- ``env_key`` names an environment
    variable and a person typing ``codex`` has none set (``~/.codex/auth.json`` does NOT satisfy
    it for a custom provider) -- so the key is dropped and the token becomes a static header.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_serialization import serialize_toml_cli_value

    lines = [f"model = {serialize_toml_cli_value(auth.model_slug)}"] if auth.model_slug else []
    lines += [
        f"{key} = {serialize_toml_cli_value(value)}"
        for key, value in auth.config_overrides
        if not (inline_token and key.endswith(".env_key"))
    ]
    if inline_token and auth.provider_key:
        token = auth.env.get(auth.token_env_var, "")
        header = f"model_providers.{auth.provider_key}.http_headers.Authorization"
        lines.append(f"{header} = {serialize_toml_cli_value(f'Bearer {token}')}")
    return lines


def _opencode_config(auth: WorkerApiAuth, *, inline_key: bool) -> dict:
    """opencode's ``opencode.json``. ``inline_key`` puts the token in the file, for a box-wide
    setup where no variable is exported."""
    provider = {name: {**options} for name, options in auth.provider_options.items()}
    if inline_key:
        for options in provider.values():
            options["options"] = {**options.get("options", {}), "apiKey": auth.env.get(auth.token_env_var, "")}
    config: dict = {"provider": provider}
    if auth.model_slug:
        config["model"] = auth.model_slug
    return config


def shell_binding(worker_type: str, auth: WorkerApiAuth) -> ShellBinding:
    """*auth* rendered for ONE terminal: what to export, and what to write first."""
    spec = _SPECS.get(worker_type)
    if spec is None:
        return ShellBinding(env=dict(auth.env))
    env = _prompt_env(spec, auth)
    if spec.user_config_fmt == "toml":
        files = {Path(spec.user_config_path).name: "\n".join(_codex_toml(auth, inline_token=False)) + "\n"}
    elif spec.pointer_env:
        files = {
            Path(spec.user_config_path).name: json.dumps(_opencode_config(auth, inline_key=False), indent=2) + "\n"
        }
    else:
        return ShellBinding(env=env)
    return ShellBinding(env=env, files=files, pointer_env=spec.pointer_env, pointer_is_dir=spec.pointer_is_dir)


def user_binding(worker_type: str, auth: WorkerApiAuth) -> UserBinding:
    """*auth* written where *worker_type* looks by default, so EVERY terminal is funded."""
    spec = _SPECS.get(worker_type)
    if spec is None or not spec.user_config_path:
        return UserBinding(note=f"{worker_type} cannot be configured box-wide")
    env = _prompt_env(spec, auth)
    if spec.user_config_fmt == "json" and spec.pointer_env:
        merge = _opencode_config(auth, inline_key=True)
    elif spec.user_config_fmt == "json":
        merge = {"env": env}
    elif spec.user_config_fmt == "toml":
        return UserBinding(fmt="toml", path=spec.user_config_path, lines=tuple(_codex_toml(auth, inline_token=True)))
    else:
        return UserBinding(
            fmt="profile",
            path=spec.user_config_path,
            lines=tuple(f"export {k}={shlex.quote(v)}" for k, v in env.items()),
            note="copilot has no config file of its own, so this goes in your shell profile.",
        )
    return UserBinding(fmt="json", path=spec.user_config_path, merge=merge)
