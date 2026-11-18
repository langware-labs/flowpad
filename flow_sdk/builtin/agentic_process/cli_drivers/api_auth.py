"""Turning a chosen ``LLMSource`` into a spawn binding.

WHICH source funds a worker is decided by ``resolve_llm_endpoint`` (``llm_source.py``);
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

import asyncio
import functools
import json
import logging
import shlex
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable

from flow_sdk.builtin.agentic_process.cli_drivers.credential_artifacts import CredentialArtifact
from flow_sdk.builtin.agentic_process.model_tiers import (
    CLAUDE_CLI_ALIASES,
    is_model_tier,
)
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.flowpad_types.vendors import vendor_or_none

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)
_FETCHES: set = set()  # in-flight budget-list fetches, kept alive


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
    supported_providers: tuple[LMApiProvider, ...]
    default_provider: LMApiProvider
    config_overrides: tuple[tuple[str, str], ...] = ()  # codex `-c key=val` pairs
    provider_key: str = ""  # the ``model_providers.<name>`` those overrides declare
    model_env_vars: tuple[str, ...] = ()  # extra env vars that also carry the slug
    #: How this harness spells a canonical ``vendor/model`` slug (an endpoint's size): prepended to it.
    #: opencode addresses every model as ``<provider>/<model>``.
    slug_prefix: str = ""
    #: The env var through which this harness takes a cap on one reply's length, if it has one
    #: and does not cap it by itself. A funded spawn sets it to ``FUNDED_MAX_OUTPUT_TOKENS``.
    max_output_env_var: str = ""
    #: Env vars that carry the model when there is NO argv to carry it. ``model_env_vars`` above
    #: is for a SPAWN, which passes ``--model`` / ``-c model=`` / a generated config; a person
    #: typing the CLI passes nothing, and the harness then asks for its own default -- which a
    #: budgeted endpoint refuses outright ("has no known price"; observed as claude requesting
    #: ``claude-opus-4-8`` and getting a 400). Empty where the slug already reaches the harness
    #: another way: codex and opencode through their generated file, copilot through
    #: ``model_env_vars``.
    prompt_model_env_vars: tuple[str, ...] = ()
    #: The harness's own names for its sizes (claude's ``haiku`` is its ``sm``). Funded, the name
    #: means the size: left as is, the CLI expands it to a vendor id the gateway may not price.
    native_tiers: dict[str, str] = field(default_factory=dict)
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
    #: The name the harness insists on for its file-configured form. NOT derivable from
    #: ``user_config_path``: codex's ``CODEX_HOME`` is a DIRECTORY and the file inside it must be
    #: called ``config.toml`` -- that is codex's constraint, which only happens to equal the
    #: basename of the box-wide path -- while opencode's pointer names the file itself, so its
    #: basename is arbitrary. Deriving one from the other coupled two unrelated requirements.
    config_filename: str = ""
    #: Rendered verbatim when this harness has no config file of its own. On the spec like every
    #: other per-harness fact, so a second profile-configured harness does not inherit a sentence
    #: about copilot.
    user_config_note: str = ""
    # FLOWPAD: (invoke_url, no trailing slash) -> binding. None = unsupported.
    hub_endpoint_binding: Callable[[str], ProviderBinding] | None = None
    #: Does this harness have an ACCOUNT OF ITS OWN to be signed into? False for one that is
    #: funded only by a key or an endpoint (deepagents). The resolver then has no device rung at
    #: all -- otherwise an unproven, rank-0 "device login" that cannot exist outranks the real
    #: funding and the worker is spawned with no credentials.
    has_device_login: bool = True
    local_bindings: dict[LMApiProvider, Callable] = field(default_factory=dict)
    local_env_vars: tuple[str, ...] = ()

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
    credential_artifact: CredentialArtifact | None = field(default=None, repr=False)
    endpoint_typeid: str | None = None


# ── Per-driver specs (proven OpenRouter values) ──────────────────────────────
#
# The FLOWPAD bindings point the same CLIs at the hub's LLMEndpoint instead of
# OpenRouter directly. The endpoint is a passthrough to OpenRouter, so the wire
# quirks (blank ANTHROPIC_API_KEY, no thinking, `wire_api = responses`, alt
# provider type "openai") and the OpenRouter model slugs are unchanged; only the
# base URL and the token move. claude appends `/v1/messages` to its base itself;
# codex and copilot expect the `/v1` root.


def _claude_vertex_binding(endpoint, key: str, slug: str) -> WorkerApiAuth:
    from flow_sdk.external_apis.llm.errors import LLMNotSupported
    from flow_sdk.external_apis.llm.vertex import canonical_config, is_claude, vertex_model

    _, config = canonical_config(endpoint.base_url, credential=key)
    if not is_claude(slug):
        raise LLMNotSupported("Claude Code requires a Claude model on the Vertex endpoint; configure its model tiers")
    return WorkerApiAuth(
        env={
            "CLAUDE_CODE_USE_VERTEX": "1",
            "ANTHROPIC_VERTEX_PROJECT_ID": config.project_id,
            "CLOUD_ML_REGION": config.location,
            "ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": "", "ANTHROPIC_BASE_URL": "",
            "CLAUDE_CODE_OAUTH_TOKEN": "", "GOOGLE_API_KEY": "",
            "CLAUDE_CODE_USE_BEDROCK": "", "CLAUDE_CODE_USE_FOUNDRY": "",
            "CLAUDE_CODE_SKIP_VERTEX_AUTH": "",
            "ANTHROPIC_SMALL_FAST_MODEL": "", "CLAUDE_CODE_SUBAGENT_MODEL": "",
            "GOOGLE_CLOUD_PROJECT": config.project_id,
            **{
                f"ANTHROPIC_DEFAULT_{alias.upper()}_MODEL": vertex_model(endpoint.tiers.get(tier, ""))
                if is_claude(endpoint.tiers.get(tier, "")) else ""
                for alias, tier in CLAUDE_CLI_ALIASES.items()
            },
        },
        model_slug=vertex_model(slug),
        credential_artifact=CredentialArtifact("GOOGLE_APPLICATION_CREDENTIALS", key),
    )


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


#: The longest single reply a funded spawn asks for. A request is priced by OpenRouter's
#: affordability check at its output cap -- or, naming none, at the model's MAXIMUM (64k for opus) --
#: so a key with a daily limit refuses it outright (402, "can only afford N tokens") before anything
#: is spent, and a hub ``max_tokens_ceiling`` refuses a cap above it (400). Each harness that takes a
#: cap names its knob in ``max_output_env_var`` (verified against the request body each sends:
#: claude 2.1, opencode 1.18 ask 32000 by default). copilot has no knob that reaches the request --
#: ``COPILOT_PROVIDER_MAX_OUTPUT_TOKENS`` only budgets internally (copilot 1.0.91) -- and codex
#: names none, so for those the hub's ceiling writes the cap in.
FUNDED_MAX_OUTPUT_TOKENS = 16384


def _copilot_hub_binding(url: str) -> ProviderBinding:
    return ProviderBinding(
        token_env_var="COPILOT_PROVIDER_API_KEY",
        base_env={
            "COPILOT_ENABLE_ALT_PROVIDERS": "1",
            "COPILOT_PROVIDER_TYPE": "openai",
            "COPILOT_PROVIDER_BASE_URL": f"{url}/v1",
        },
    )


def _claude_anthropic_binding(endpoint, key: str, slug: str) -> WorkerApiAuth:
    """A direct Anthropic key must not inherit another Claude auth mode."""
    base = endpoint.base_url.rstrip("/").removesuffix("/v1")
    return WorkerApiAuth(
        env={
            "ANTHROPIC_API_KEY": key, "ANTHROPIC_BASE_URL": base,
            "ANTHROPIC_AUTH_TOKEN": "", "CLAUDE_CODE_OAUTH_TOKEN": "",
            "CLAUDE_CODE_USE_VERTEX": "", "CLAUDE_CODE_USE_BEDROCK": "",
            "CLAUDE_CODE_USE_FOUNDRY": "", "ANTHROPIC_MODEL": slug,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": slug, "ANTHROPIC_DEFAULT_SONNET_MODEL": slug,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": slug,
            "ANTHROPIC_SMALL_FAST_MODEL": slug, "CLAUDE_CODE_SUBAGENT_MODEL": slug,
            "GOOGLE_APPLICATION_CREDENTIALS": "", "GOOGLE_API_KEY": "",
            "CLAUDE_CODE_SKIP_VERTEX_AUTH": "", "ANTHROPIC_VERTEX_PROJECT_ID": "",
            "CLOUD_ML_REGION": "",
        },
        model_slug=slug, token_env_var="ANTHROPIC_API_KEY",
    )


def _codex_openai_binding(endpoint, key: str, slug: str) -> WorkerApiAuth:
    """An explicit key-backed Responses provider, independent of Codex's account login."""
    provider = "flowpad_openai"
    base = endpoint.dialect.openai_base(endpoint.base_url)
    return WorkerApiAuth(
        env={"OPENAI_API_KEY": key, "OPENAI_BASE_URL": ""},
        model_slug=slug, token_env_var="OPENAI_API_KEY", provider_key=provider,
        config_overrides=[
            ("model_provider", provider),
            (f"model_providers.{provider}.name", "OpenAI"),
            (f"model_providers.{provider}.base_url", base),
            (f"model_providers.{provider}.wire_api", "responses"),
            (f"model_providers.{provider}.env_key", "OPENAI_API_KEY"),
        ],
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
    # Direct vendors use their own factories, never the static OpenRouter recipe.
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD, LMApiProvider.VERTEX, LMApiProvider.ANTHROPIC),
    local_bindings={LMApiProvider.VERTEX: _claude_vertex_binding, LMApiProvider.ANTHROPIC: _claude_anthropic_binding},
    local_env_vars=("CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK",
                    "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
                    "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
                    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_API_KEY", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
                    "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"),
    default_provider=LMApiProvider.OPENROUTER,
    prompt_model_env_vars=("ANTHROPIC_MODEL",),
    native_tiers=dict(CLAUDE_CLI_ALIASES),
    user_config_path=".claude/settings.json",
    user_config_fmt="json",
    hub_endpoint_binding=_claude_hub_binding,
    max_output_env_var="CLAUDE_CODE_MAX_OUTPUT_TOKENS",
)

CODEX_API_AUTH_SPEC = ApiAuthSpec(
    token_env_var="OPENROUTER_API_KEY",
    base_env={},
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD, LMApiProvider.OPENAI),
    local_bindings={LMApiProvider.OPENAI: _codex_openai_binding},
    local_env_vars=("OPENAI_API_KEY", "OPENAI_BASE_URL"),
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
    # ``CODEX_HOME`` is codex's whole state directory, not just where ``config.toml`` lives, so a
    # shell pointed at ours gets a funded codex with no history, no ``auth.json`` and no MCP
    # config. That is the trade for a redirect codex offers no other way to make; box-wide scope
    # writes the managed region of the real ``~/.codex/config.toml`` instead and keeps all of it.
    pointer_env="CODEX_HOME",
    pointer_is_dir=True,
    user_config_path=".codex/config.toml",
    user_config_fmt="toml",
    config_filename="config.toml",
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
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD),
    default_provider=LMApiProvider.OPENROUTER,
    model_env_vars=("COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL", "COPILOT_MODEL"),
    user_config_path=".profile",
    user_config_fmt="profile",
    user_config_note="copilot has no config file of its own, so this goes in your shell profile.",
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
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD),
    default_provider=LMApiProvider.OPENROUTER,
    slug_prefix="openrouter/",
    pointer_env="OPENCODE_CONFIG",
    user_config_path=".config/opencode/opencode.json",
    user_config_fmt="json",
    config_filename="opencode.json",
    hub_endpoint_binding=_opencode_hub_binding,
    max_output_env_var="OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX",
)


# The runner defines the two variables it reads; a retyped literal here would spawn an unfunded
# worker the day one of them is renamed. (``runner`` is stdlib-only at import.)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import (  # noqa: E402
    API_KEY_ENV as _DEEPAGENTS_KEY_ENV,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import (  # noqa: E402
    BASE_URL_ENV as _DEEPAGENTS_URL_ENV,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import (  # noqa: E402
    MAX_OUTPUT_ENV as _DEEPAGENTS_MAX_OUTPUT_ENV,
)


def _deepagents_hub_binding(url: str) -> ProviderBinding:
    """Our own runner speaks the chat-completions wire, so only the base URL moves (the same
    ``/v1`` the hub serves copilot and opencode)."""
    return ProviderBinding(token_env_var=_DEEPAGENTS_KEY_ENV, base_env={_DEEPAGENTS_URL_ENV: f"{url}/v1"})


DEEPAGENTS_API_AUTH_SPEC = ApiAuthSpec(
    # Both variables are read by OUR runner (``cli_drivers/deepagents/models.py``), so there is
    # no vendor config to write: no pointer, no box-wide file, nothing on disk. There is also no
    # CLI a person types, hence no ``prompt_model_env_vars`` -- the slug always rides ``--model``.
    token_env_var=_DEEPAGENTS_KEY_ENV,
    base_env={_DEEPAGENTS_URL_ENV: "https://openrouter.ai/api/v1"},
    # One wire, so ONE tier table: no native spelling of its own. Agents are written with claude's
    # aliases (``model: haiku``), so those name the same sizes here when such an agent runs on deepagents.
    native_tiers=dict(CLAUDE_CLI_ALIASES),
    supported_providers=(LMApiProvider.OPENROUTER, LMApiProvider.FLOWPAD),
    default_provider=LMApiProvider.OPENROUTER,
    hub_endpoint_binding=_deepagents_hub_binding,
    max_output_env_var=_DEEPAGENTS_MAX_OUTPUT_ENV,
    has_device_login=False,
)


_SPECS: dict[str, ApiAuthSpec] = {
    "claude": CLAUDE_API_AUTH_SPEC,
    "codex": CODEX_API_AUTH_SPEC,
    "copilot": COPILOT_API_AUTH_SPEC,
    "opencode": OPENCODE_API_AUTH_SPEC,
    "deepagents": DEEPAGENTS_API_AUTH_SPEC,
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
    return f"{hub_origin(str(parsed))}{hub_invoke_path(parsed)}"


def default_size() -> str:
    """Device-login size preference when omitted; funded sources use their endpoint default."""
    from flow_sdk.preferences import DEFAULT_LLM_SIZE, PREF_LLM_DEFAULT_SIZE, read_instance_pref  # noqa: PLC0415

    size = read_instance_pref(PREF_LLM_DEFAULT_SIZE, DEFAULT_LLM_SIZE)
    return size if is_model_tier(size) else DEFAULT_LLM_SIZE


def _slug_for(worker_type: str, spec: "ApiAuthSpec", sizes: dict, source, tier: str | None,
              default_model: str | None = None) -> str:
    """The model a funded spawn runs: the slug the ENDPOINT declares for the size, never a code default.

    A size (``sm``/``md``/``lg``, the harness's own word for one such as claude's ``haiku``, or nothing
    at all -> the endpoint default, else ``sm``) reads ``sizes[size]`` -- the endpoint's own map, which for a hub
    endpoint is the size inherited down its chain. A custom name the endpoint declares beside its sizes
    (such as ``coding``) runs the model it names. A size the endpoint does not declare is refused in words -- a
    guessed model is how a worker ended up silently answered by another vendor. Anything else is a
    model the caller named, and runs as named.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.launch_health import LaunchErrorCode  # noqa: PLC0415
    from flow_sdk.external_apis.llm.errors import LLMError
    from flow_sdk.external_apis.llm.model_selection import resolve_completion_model

    try:
        slug = resolve_completion_model(sizes, spec.native_tiers.get(tier, tier), default_model=default_model)
    except LLMError as exc:
        raise WorkerSpawnError(worker_type, str(exc), LaunchErrorCode.MODEL_UNAVAILABLE) from exc
    return slug if slug.startswith(spec.slug_prefix) else f"{spec.slug_prefix}{slug}"


async def resolve_worker_api_auth(process: "AgenticProcess", *, include_device: bool = False) -> WorkerApiAuth | None:
    """Materialize the spawn binding for whichever ``LLMSource`` funds *process*.

    DEVICE sources keep the vendor CLI's own credentials. A configured device model
    returns a model-only binding; otherwise native aliases or the vendor default apply.
    An explicit size without a configured mapping or native alias is refused.

    Which source wins is NOT decided here any more: ``resolve_llm_endpoint`` owns the
    ladder, so the answer this spawn uses and the answer the picker renders come from one
    place and cannot disagree. This function owns the other half -- turning a chosen
    source into env, model slug and config overrides.

    Raises :class:`WorkerSpawnError` when nothing can fund the spawn, carrying every
    candidate's reason rather than a sentence written here.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import (  # noqa: PLC0415
        LLMSourceError,
        _hub_budget_pending,
        resolve_llm_endpoint,
    )
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints  # noqa: PLC0415

    worker_type = getattr(process.driver, "name", None)
    if not worker_type or driver_api_auth_spec(worker_type) is None:
        return None

    try:
        candidate = await resolve_llm_endpoint(process)
    except LLMSourceError as exc:
        exc.budget_not_ready = _hub_budget_pending()
        if exc.budget_not_ready:  # fetch the list once, without holding the refusal; the card's retry finds it
            _FETCHES.add(task := asyncio.create_task(fetch_hub_llm_endpoints()))
            task.add_done_callback(_FETCHES.discard)
        raise WorkerSpawnError(worker_type, str(exc)) from exc

    model = (process.cli_config or {}).get("model")
    auth = await binding_for_candidate(worker_type, candidate, tier=model)
    if auth is None and not include_device:
        return None
    if auth is None:
        auth = WorkerApiAuth()
    auth.endpoint_typeid = candidate.source.endpoint_typeid
    return auth


async def binding_for_candidate(worker_type: str, candidate, *, tier: str | None = None) -> WorkerApiAuth | None:
    """The spawn binding for one ALREADY-CHOSEN source — env, model slug, config overrides.

    The half of :func:`resolve_worker_api_auth` that does not care WHERE the choice came from,
    split out for the callers that have no process to resolve against. ``flow llm`` is exactly
    that: the user names a row from the picker's own list and wants the binding for it, so the
    recipe must be reachable without inventing a fake process to carry it.

    DEVICE sources inject no credentials. The sizes and custom names set on the device login's
    own endpoint row return a model-only binding; otherwise native aliases/defaults apply.

    *tier* is the ``sm``/``md``/``lg`` key (or a literal slug). Omission uses the funded
    endpoint's default, then ``sm``; only device logins retain the instance size preference.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind  # noqa: PLC0415

    spec = driver_api_auth_spec(worker_type)
    if spec is None:
        return None

    endpoint, source = candidate
    if endpoint.kind == LLMEndpointKind.DEVICE:
        from flow_sdk.builtin.agentic_process.cli_drivers.device_endpoints import device_tiers  # noqa: PLC0415

        sizes = await device_tiers(worker_type)
        selected = sizes.get(tier or default_size())
        if tier and is_model_tier(tier) and not selected and tier not in spec.native_tiers.values():
            raise WorkerSpawnError(
                worker_type,
                f"Model size {tier!r} has no device mapping for {worker_type}; set the model sizes "
                f"on the {worker_type} device login endpoint, or name a concrete model",
            )
        return WorkerApiAuth(model_slug=selected) if selected else None

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

    # For FLOWPAD the endpoint and the key are one question: the "key" IS the hub login (or,
    # for a PUBLIC endpoint on a box with no login, the placeholder the hub ignores), and what
    # makes it usable is having an endpoint to point it at. Asked of the endpoint itself so a
    # spawn and an in-process ``endpoint.client()`` can never disagree about what signs a call.
    hub_invoke_url = None
    if is_hub:
        from flow_sdk.instance_settings.llm_endpoint import hub_llm_endpoint_invoke_url  # noqa: PLC0415

        own_url = endpoint_invoke_url(source.endpoint_typeid)
        hub_invoke_url = own_url or hub_llm_endpoint_invoke_url()
        key = endpoint.resolve_api_key() if hub_invoke_url else None
    else:
        # Stored only, matching what the resolver judged eligible — a spawn must not be
        # funded by an environment variable the picker never counted.
        key = endpoint.resolve_api_key(allow_environment=False)
    if not key:
        raise WorkerSpawnError(worker_type, f"{worker_type}: {source.name} is unusable (no credential available)")
    sizes = dict(endpoint.tiers or {})
    if is_hub:
        from flow_sdk.external_apis.llm.errors import LLMError
        from flow_sdk.instance_settings.llm_endpoint import fetch_model_config

        wanted = spec.native_tiers.get(tier, tier)
        try:
            metadata = await fetch_model_config(source.endpoint_typeid, public=endpoint.public, model=wanted)
            slug = metadata.resolve(wanted)
        except LLMError as exc:
            raise WorkerSpawnError(worker_type, str(exc)) from exc
        slug = slug if slug.startswith(spec.slug_prefix) else f"{spec.slug_prefix}{slug}"
    else:
        # The legacy per-harness overrides land on this key row; migrate before reading its sizes.
        from flow_sdk.builtin.agentic_process.cli_drivers.device_endpoints import (  # noqa: PLC0415
            migrate_capability_model_maps,
        )

        await migrate_capability_model_maps()
        if endpoint.secret_name and (fresh := await type(endpoint).find_by_secret(endpoint.secret_name)):
            sizes = dict(fresh.tiers or {})
            endpoint = fresh
        slug = _slug_for(worker_type, spec, sizes, source, tier, endpoint.default_model)
    if factory := spec.local_bindings.get(provider):
        from flow_sdk.external_apis.llm.errors import LLMError

        try:
            auth = factory(endpoint, key, slug)
        except (ValueError, LLMError) as exc:
            raise WorkerSpawnError(worker_type, str(exc)) from exc
        if spec.max_output_env_var:
            auth.env[spec.max_output_env_var] = str(FUNDED_MAX_OUTPUT_TOKENS)
        return auth
    try:
        binding = spec.binding_for(provider, hub_invoke_url=hub_invoke_url)
    except ValueError as exc:
        raise WorkerSpawnError(worker_type, str(exc)) from exc
    env = {**binding.base_env, binding.token_env_var: key}
    if spec.max_output_env_var:
        env[spec.max_output_env_var] = str(FUNDED_MAX_OUTPUT_TOKENS)
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


async def apply_api_model_to_options(cmd, process: "AgenticProcess", *, prepare_launch: bool = False) -> None:
    """Stamp the source's resolved model and config onto options before argv is frozen."""
    if prepare_launch:
        process.__dict__.pop("_prepared_api_auth", None)
    auth = await resolve_worker_api_auth(process, include_device=prepare_launch)
    if prepare_launch:
        process.__dict__["_prepared_api_auth"] = auth
    _apply_auth_to_options(cmd, auth)


def _apply_auth_to_options(cmd, auth: WorkerApiAuth | None) -> None:
    if hasattr(cmd, "bound_model"):
        cmd.bound_model = auth.model_slug if auth and auth.endpoint_typeid else None
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
    """Use exactly the binding that funded this headless launch.

    A cached None means env setup failed: the driver's existing setup_error gate
    owns that refusal. An unattempted binding still resolves and propagates errors.
    """
    if "_spawn_api_auth" in process.__dict__:
        _apply_auth_to_options(context, process.__dict__["_spawn_api_auth"])
    else:
        await apply_api_model_to_options(context, process)


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
    """Where a harness reads its funding from by DEFAULT, and what older versions put there.

    Read only to remove those writes (see ``user_binding``). ``fmt`` says how:

    * ``json``    — prune exactly the leaves ``merge`` names (the user's own keys survive);
    * ``toml`` / ``profile`` — drop the managed region of the file.

    ``path`` is relative to the user's home. ``note`` explains a harness that has no file of its
    own, and is rendered verbatim.
    """

    fmt: str = ""
    path: str = ""
    merge: dict = field(default_factory=dict)
    lines: tuple[str, ...] = ()
    note: str = ""


@functools.cache
def managed_env_vars() -> tuple[str, ...]:
    """Every variable the shell form can set, for any harness and any provider.

    What ``flow llm clear`` unsets. Cached because it is a constant: derived wholly from the specs -- including the pointer
    variables and the prompt-model variables, which used to be string literals here AND in the
    renderer below. Static and secret-free, because clearing must work with no source chosen and
    no credential available.
    """
    names: set[str] = set()
    for spec in _SPECS.values():
        names.update(
            {spec.token_env_var, spec.pointer_env, *spec.base_env, *spec.model_env_vars, *spec.prompt_model_env_vars,
             *spec.local_env_vars}
        )
        if spec.hub_endpoint_binding is not None:
            # The URL is never read back -- only the variable NAMES are -- so any well-formed
            # one will do.
            hub = spec.hub_endpoint_binding("https://example.invalid")
            names.update({hub.token_env_var, *hub.base_env})
    names.discard("")
    return tuple(sorted(names))


def _prompt_env(spec: ApiAuthSpec, auth: WorkerApiAuth) -> dict[str, str]:
    """*auth*'s env plus the model, for a surface that has no argv to carry it."""
    if not auth.model_slug:
        return dict(auth.env)
    return {**auth.env, **dict.fromkeys(spec.prompt_model_env_vars, auth.model_slug)}


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
    """*auth* rendered for ONE terminal: what to export, and what to write first.

    The question is "is this harness configured by a FILE?" -- ``pointer_env`` -- and the format
    is a sub-question. Testing the format first conflated it with "is this codex", which would
    have emitted a file with no variable able to point at it.
    """
    if auth.credential_artifact is not None:
        raise ValueError("This credential requires a managed worker process; use AgenticProcess")
    spec = driver_api_auth_spec(worker_type)
    if spec is None:
        return ShellBinding(env=dict(auth.env))
    env = _prompt_env(spec, auth)
    if not spec.pointer_env:
        return ShellBinding(env=env)
    body = (
        "\n".join(_codex_toml(auth, inline_token=False)) + "\n"
        if spec.user_config_fmt == "toml"
        else json.dumps(_opencode_config(auth, inline_key=False), indent=2) + "\n"
    )
    return ShellBinding(
        env=env,
        files={spec.config_filename: body},
        pointer_env=spec.pointer_env,
        pointer_is_dir=spec.pointer_is_dir,
    )


def user_binding(worker_type: str, auth: WorkerApiAuth) -> UserBinding:
    """*auth* as older versions wrote it where *worker_type* looks by default.

    Nothing writes this any more -- those files belong to the machine, not to an instance. It is
    kept so ``flow llm user clear`` can name exactly the leaves / region to take back out."""
    spec = driver_api_auth_spec(worker_type)
    if spec is None or not spec.user_config_path:
        return UserBinding(note=f"{worker_type} cannot be configured box-wide")
    if spec.user_config_fmt == "toml":
        return UserBinding(fmt="block", path=spec.user_config_path, lines=tuple(_codex_toml(auth, inline_token=True)))
    if spec.user_config_fmt == "profile":
        lines = tuple(f"export {k}={shlex.quote(v)}" for k, v in _prompt_env(spec, auth).items())
        return UserBinding(fmt="block", path=spec.user_config_path, lines=lines, note=spec.user_config_note)
    # JSON, and which fragment depends on whether the harness is file-configured: opencode's
    # funding lives under its provider block, claude's in the ``env`` block it applies to itself.
    merge = _opencode_config(auth, inline_key=True) if spec.pointer_env else {"env": _prompt_env(spec, auth)}
    return UserBinding(fmt="json", path=spec.user_config_path, merge=merge)


def apply_managed_block(existing: str, lines: "list[str] | tuple[str, ...]") -> str:
    """*existing* with our managed region replaced by *lines* (removed when empty).

    Beside the markers it is the inverse of: emitting and parsing one literal are one unit, and
    splitting them left the only reader importing the format across a module boundary.

    The region goes at the TOP, not the bottom. codex's config is dotted-key TOML, and a real
    ``~/.codex/config.toml`` commonly ends inside a table (``[tui]``, ``[mcp_servers.x]``) --
    appending there would re-parent every key we write under that table, silently and with no
    error. TOML has no syntax for returning to the root table, so the only safe place is first.
    """
    kept = [line for line, skipping in _mark_regions(existing.splitlines()) if not skipping]
    while kept and not kept[0].strip():
        kept.pop(0)
    block = [MANAGED_BEGIN, *lines, MANAGED_END] if lines else []
    body = [*block, *kept] if block else kept
    while body and not body[-1].strip():
        body.pop()
    return "\n".join(body) + ("\n" if body else "")


def _mark_regions(lines: "list[str]"):
    """Each line paired with whether it falls inside the managed region."""
    skipping = False
    for line in lines:
        if line.strip() == MANAGED_BEGIN:
            skipping = True
            continue
        if line.strip() == MANAGED_END:
            skipping = False
            continue
        yield line, skipping
